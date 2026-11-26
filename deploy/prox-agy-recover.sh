#!/usr/bin/env bash
# Event-driven recovery check and timer watchdog for `prox-agy-usage`.
# Triggered immediately by `prox-agy-recover.path` when the circuit breaker trips and periodically
# by `prox-agy-recover.timer`. Serialized with `prox-agy-usage.sh` under `.agy.lock`; persists the
# consumed attempt as `hard_stop` BEFORE launching the bounded single probe, preserves any specific
# classified reason/version written by the probe, and dispatches external hooks only after releasing
# `.agy.lock`.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/prox-agy-lib.sh
source "${AGY_LIB_PATH:-$SCRIPT_DIR/prox-agy-lib.sh}"

AGY_DATA_DIR="${AGY_DATA_DIR:-$HOME/.local/share/prox-history}"
AGY_STOP_FLAG="${AGY_STOP_FLAG:-$AGY_DATA_DIR/agy-usage.stopped}"
AGY_EVENTS_PATH="${AGY_EVENTS_PATH:-$AGY_DATA_DIR/agy-events.jsonl}"
AGY_EVENT_HOOK="${AGY_EVENT_HOOK:-}"
AGY_USAGE_SCRIPT="${AGY_USAGE_SCRIPT:-$SCRIPT_DIR/prox-agy-usage.sh}"
AGY_TIMER_UNIT="${AGY_TIMER_UNIT:-prox-agy-usage.timer}"
AGY_RECOVERY_COOLDOWN_SEC="${AGY_RECOVERY_COOLDOWN_SEC:-1800}"
AGY_MAX_AUTO_RECOVERIES="${AGY_MAX_AUTO_RECOVERIES:-1}"
AGY_PROBE_TIMEOUT_SEC="${AGY_PROBE_TIMEOUT_SEC:-120}"
AGY_PROBE_KILL_AFTER_SEC="${AGY_PROBE_KILL_AFTER_SEC:-5}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"

mkdir -p -m 700 "$AGY_DATA_DIR"

exec 8>"$AGY_DATA_DIR/.agy.lock"
if ! flock -w 5 8; then
  exit 0
fi

pending_hooks=()
queue_event() {
  local line
  line=$(agy_record_event "$@" || true)
  if [[ -n "$line" ]]; then
    pending_hooks+=("$line")
  fi
}

flush_hooks_unlocked() {
  exec 8>&-
  for line in "${pending_hooks[@]}"; do
    agy_dispatch_hook "$line"
  done
}

restart_timer_if_enabled() {
  local reason="$1"
  local enabled_state
  enabled_state=$("$SYSTEMCTL_BIN" --user is-enabled "$AGY_TIMER_UNIT" 2>/dev/null || true)
  if [[ "$enabled_state" == "enabled" ]]; then
    "$SYSTEMCTL_BIN" --user restart "$AGY_TIMER_UNIT"
    queue_event "$AGY_EVENTS_PATH" "timer_restarted" "recovery" "$reason"
  fi
}

# Watchdog path: no circuit breaker active — ensure an enabled timer hasn't died silently.
if [[ ! -e "$AGY_STOP_FLAG" ]]; then
  enabled_state=$("$SYSTEMCTL_BIN" --user is-enabled "$AGY_TIMER_UNIT" 2>/dev/null || true)
  active_state=$("$SYSTEMCTL_BIN" --user is-active "$AGY_TIMER_UNIT" 2>/dev/null || true)
  if [[ "$enabled_state" == "enabled" && "$active_state" != "active" && "$active_state" != "activating" ]]; then
    "$SYSTEMCTL_BIN" --user restart "$AGY_TIMER_UNIT"
    queue_event "$AGY_EVENTS_PATH" "timer_restarted" "watchdog" "timer-inactive-watchdog"
  fi
  flush_hooks_unlocked
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
let agyVersion = '';

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
    if (typeof parsed.agyVersion === 'string') agyVersion = parsed.agyVersion;
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

process.stdout.write(`${action}\t${category}\t${reason}\t${trippedAtMs}\t${attempts}\t${agyVersion}\n`);
NODE
)

IFS=$'\t' read -r action category flag_reason tripped_at_ms attempts agy_version <<< "$decision"

case "$action" in
  defer-version)
    queue_event "$AGY_EVENTS_PATH" "recovery_check_deferred" "version_changed" "manual-version-review" "$agy_version" "$tripped_at_ms"
    echo "prox-agy-recover: version_changed ($flag_reason); awaiting manual review." >&2
    ;;
  defer-hard-stop)
    queue_event "$AGY_EVENTS_PATH" "recovery_check_deferred" "hard_stop" "hard-stop-manual-clear" "$agy_version" "$tripped_at_ms"
    echo "prox-agy-recover: hard_stop ($flag_reason); awaiting manual clear." >&2
    ;;
  defer-cooldown)
    queue_event "$AGY_EVENTS_PATH" "recovery_check_deferred" "transient" "cooldown-pending" "$agy_version" "$tripped_at_ms"
    echo "prox-agy-recover: transient ($flag_reason); waiting out cooldown before single probe." >&2
    ;;
  probe)
    # Consume the recovery attempt BEFORE invoking the probe so a timeout, crash, or failed
    # snapshot write can never leave the breaker retryable.
    next_attempts=$((attempts + 1))
    queue_event "$AGY_EVENTS_PATH" "recovery_check_started" "transient" "cooldown-elapsed" "$agy_version" "$tripped_at_ms"
    agy_write_stop_flag "$AGY_STOP_FLAG" "hard_stop" "recovery-probe-in-flight" "$agy_version" "$next_attempts"
    probe_ok=0
    AGY_RECOVERY_PROBE=1 agy_run_with_timeout "$AGY_PROBE_TIMEOUT_SEC" "$AGY_PROBE_KILL_AFTER_SEC" "$AGY_USAGE_SCRIPT" && probe_ok=1 || probe_ok=0
    if ((probe_ok == 1)); then
      queue_event "$AGY_EVENTS_PATH" "recovery_check_passed" "recovery" "probe-succeeded" "$agy_version"
      restart_timer_if_enabled "recovered-from-circuit-breaker"
    else
      # Preserve the probe's classified flag (reason AND version) when it recorded one; only write
      # the generic fallback when the probe was killed before replacing `recovery-probe-in-flight`.
      probe_meta=$(node - "$AGY_STOP_FLAG" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
try {
  const parsed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (parsed && typeof parsed === 'object' && typeof parsed.reason === 'string' && parsed.reason && parsed.reason !== 'recovery-probe-in-flight') {
    const ver = typeof parsed.agyVersion === 'string' ? parsed.agyVersion : '';
    process.stdout.write(`1\t${parsed.reason}\t${ver}\n`);
  }
} catch {}
NODE
      )
      if [[ -n "$probe_meta" ]]; then
        IFS=$'\t' read -r _ probe_reason probe_version <<< "$probe_meta"
        final_reason="$probe_reason"
        final_version="$probe_version"
      else
        final_reason="probe-failed-hard-stopped"
        final_version="$agy_version"
        agy_write_stop_flag "$AGY_STOP_FLAG" "hard_stop" "$final_reason" "$final_version" "$next_attempts"
      fi
      queue_event "$AGY_EVENTS_PATH" "recovery_check_escalated" "hard_stop" "$final_reason" "$final_version" "$tripped_at_ms"
      echo "prox-agy-recover: single recovery probe failed ($final_reason); escalated to hard_stop." >&2
    fi
    ;;
esac

flush_hooks_unlocked
exit 0
