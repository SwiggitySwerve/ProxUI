#!/usr/bin/env bash
# Event-driven recovery check and timer watchdog for `prox-agy-usage`.
# Triggered immediately by `prox-agy-recover.path` when the circuit breaker trips and periodically
# by `prox-agy-recover.timer`. Emits structured JSONL events (and invokes optional AGY_EVENT_HOOK),
# performs at most one bounded post-cooldown probe for transient failures, escalates a second
# failure to `hard_stop`, and restarts `prox-agy-usage.timer` on recovery or unexpected stop.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

AGY_DATA_DIR="${AGY_DATA_DIR:-$HOME/.local/share/prox-history}"
AGY_STOP_FLAG="${AGY_STOP_FLAG:-$AGY_DATA_DIR/agy-usage.stopped}"
AGY_EVENTS_PATH="${AGY_EVENTS_PATH:-$AGY_DATA_DIR/agy-events.jsonl}"
AGY_EVENT_HOOK="${AGY_EVENT_HOOK:-}"
AGY_USAGE_SCRIPT="${AGY_USAGE_SCRIPT:-$HOME/.local/share/prox/prox-agy-usage.sh}"
AGY_TIMER_UNIT="${AGY_TIMER_UNIT:-prox-agy-usage.timer}"
AGY_RECOVERY_COOLDOWN_SEC="${AGY_RECOVERY_COOLDOWN_SEC:-1800}"
AGY_MAX_AUTO_RECOVERIES="${AGY_MAX_AUTO_RECOVERIES:-1}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"

mkdir -p -m 700 "$AGY_DATA_DIR"

emit_event() {
  local event_name="$1"
  local category="$2"
  local reason="$3"
  local dedup_key="${4:-}"
  local line
  line=$(node - "$AGY_EVENTS_PATH" "$event_name" "$category" "$reason" "$dedup_key" "${NOW_MS:-}" <<'NODE'
const fs = require('node:fs');

const [eventsPath, event, category, reason, dedupKey, nowOverride] = process.argv.slice(2);
const atMs = nowOverride && /^\d+$/.test(nowOverride) ? Number(nowOverride) : Date.now();
let existing = [];
try {
  existing = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
} catch {
  // first event
}
if (dedupKey) {
  for (let i = existing.length - 1; i >= 0; i--) {
    try {
      const prev = JSON.parse(existing[i]);
      if (prev.event === event && prev.reason === reason && prev.dedupKey === dedupKey) {
        process.exit(0);
      }
    } catch {
      // ignore malformed historical line
    }
  }
}
const record = {
  at: new Date(atMs).toISOString(),
  atMs,
  event,
  category,
  reason,
  ...(dedupKey ? { dedupKey } : {}),
};
const line = JSON.stringify(record);
existing.push(line);
if (existing.length > 200) existing = existing.slice(-200);
const tmp = `${eventsPath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, `${existing.join('\n')}\n`, { mode: 0o600 });
fs.renameSync(tmp, eventsPath);
process.stdout.write(line);
NODE
  ) || true
  if [[ -n "$AGY_EVENT_HOOK" && -x "$AGY_EVENT_HOOK" && -n "$line" ]]; then
    printf '%s\n' "$line" | timeout 10 "$AGY_EVENT_HOOK" >/dev/null 2>&1 || true
  fi
}

restart_timer_if_enabled() {
  local reason="$1"
  local enabled_state
  enabled_state=$("$SYSTEMCTL_BIN" --user is-enabled "$AGY_TIMER_UNIT" 2>/dev/null || true)
  if [[ "$enabled_state" == "enabled" ]]; then
    "$SYSTEMCTL_BIN" --user restart "$AGY_TIMER_UNIT"
    emit_event "timer_restarted" "recovery" "$reason"
  fi
}

# Watchdog path: no circuit breaker active — ensure an enabled timer hasn't died silently.
if [[ ! -e "$AGY_STOP_FLAG" ]]; then
  enabled_state=$("$SYSTEMCTL_BIN" --user is-enabled "$AGY_TIMER_UNIT" 2>/dev/null || true)
  active_state=$("$SYSTEMCTL_BIN" --user is-active "$AGY_TIMER_UNIT" 2>/dev/null || true)
  if [[ "$enabled_state" == "enabled" && "$active_state" != "active" && "$active_state" != "activating" ]]; then
    "$SYSTEMCTL_BIN" --user restart "$AGY_TIMER_UNIT"
    emit_event "timer_restarted" "watchdog" "timer-inactive-watchdog"
  fi
  exit 0
fi

# Circuit breaker is open: inspect stop flag and decide defer vs bounded single probe.
decision=$(node - "$AGY_STOP_FLAG" "$AGY_RECOVERY_COOLDOWN_SEC" "$AGY_MAX_AUTO_RECOVERIES" "${NOW_MS:-}" <<'NODE'
const fs = require('node:fs');

const [flagPath, cooldownSecRaw, maxAttemptsRaw, nowOverride] = process.argv.slice(2);
const nowMs = nowOverride && /^\d+$/.test(nowOverride) ? Number(nowOverride) : Date.now();
const cooldownMs = Math.max(0, Number(cooldownSecRaw) || 0) * 1000;
const maxAttempts = Math.max(0, Number(maxAttemptsRaw) || 0);

let category = 'hard_stop';
let reason = 'legacy-or-malformed-flag';
let attempts = maxAttempts;
let trippedAtMs = Math.floor(fs.statSync(flagPath).mtimeMs);

try {
  const parsed = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.category === 'string') category = parsed.category;
    if (typeof parsed.reason === 'string') reason = parsed.reason;
    if (typeof parsed.attempts === 'number' && Number.isFinite(parsed.attempts)) {
      attempts = parsed.attempts;
    }
    if (typeof parsed.trippedAtMs === 'number' && Number.isSafeInteger(parsed.trippedAtMs)) {
      trippedAtMs = parsed.trippedAtMs;
    }
  }
} catch {
  // Keep conservative hard_stop defaults.
}

let action = 'defer-hard-stop';
if (category === 'version_changed') {
  action = 'defer-version';
} else if (category === 'transient' && attempts < maxAttempts) {
  action = nowMs - trippedAtMs >= cooldownMs ? 'probe' : 'defer-cooldown';
}

process.stdout.write(`${action}\t${category}\t${reason}\t${trippedAtMs}\n`);
NODE
)

IFS=$'\t' read -r action category flag_reason tripped_at_ms <<< "$decision"

case "$action" in
  defer-version)
    emit_event "recovery_check_deferred" "version_changed" "manual-version-review" "$tripped_at_ms"
    echo "prox-agy-recover: version_changed ($flag_reason); awaiting manual review." >&2
    exit 0
    ;;
  defer-hard-stop)
    emit_event "recovery_check_deferred" "hard_stop" "hard-stop-manual-clear" "$tripped_at_ms"
    echo "prox-agy-recover: hard_stop ($flag_reason); awaiting manual clear." >&2
    exit 0
    ;;
  defer-cooldown)
    emit_event "recovery_check_deferred" "transient" "cooldown-pending" "$tripped_at_ms"
    echo "prox-agy-recover: transient ($flag_reason); waiting out cooldown before single probe." >&2
    exit 0
    ;;
  probe)
    emit_event "recovery_check_started" "transient" "cooldown-elapsed" "$tripped_at_ms"
    if AGY_RECOVERY_PROBE=1 "$AGY_USAGE_SCRIPT"; then
      emit_event "recovery_check_passed" "recovery" "probe-succeeded"
      restart_timer_if_enabled "recovered-from-circuit-breaker"
      exit 0
    else
      emit_event "recovery_check_escalated" "hard_stop" "probe-failed-hard-stopped" "$tripped_at_ms"
      echo "prox-agy-recover: single recovery probe failed; escalated to hard_stop." >&2
      exit 0
    fi
    ;;
esac
