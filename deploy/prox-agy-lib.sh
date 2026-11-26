#!/usr/bin/env bash
# Shared fail-closed circuit-breaker, process-group timeout, and serialized event helpers for
# `prox-agy-usage.sh` and `prox-agy-recover.sh`. Never writes raw CLI output, credentials, or PII.

# Run a command with SIGTERM -> grace -> SIGKILL cleanup across its process group, never
# inheriting lock fd 8. Uses `node -e` (not a heredoc) so piped stdin passes through cleanly.
# When `AGY_TIMEOUT_SAME_GROUP=1` (inner CLI inside a recovery probe whose outer supervisor
# already owns a dedicated process group), spawns without `detached: true` so the outer
# `-pgid` kill reaches every CLI descendant atomically.
agy_run_with_timeout() {
  local timeout_sec="$1"
  local kill_after_sec="$2"
  shift 2
  node -e '
const { spawn } = require("node:child_process");

const [timeoutSecRaw, killAfterSecRaw, cmd, ...args] = process.argv.slice(1);
const timeoutMs = Math.max(50, Math.round((Number(timeoutSecRaw) || 90) * 1000));
const killAfterMs = Math.max(50, Math.round((Number(killAfterSecRaw) || 5) * 1000));
const detached = process.env.AGY_TIMEOUT_SAME_GROUP !== "1";

const child = spawn(cmd, args, {
  env: process.env,
  stdio: "inherit",
  detached,
});
const targetPid = detached ? -child.pid : child.pid;
let timedOut = false;
let exited = false;

function targetAlive() {
  if (!child.pid) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalTarget(sig) {
  if (!child.pid) return;
  try {
    process.kill(targetPid, sig);
  } catch {
    // already gone
  }
}

function finish(code) {
  if (!targetAlive()) process.exit(code);
  signalTarget("SIGKILL");
  const deadline = Date.now() + 2000;
  const poll = setInterval(() => {
    if (!targetAlive() || Date.now() >= deadline) {
      clearInterval(poll);
      process.exit(code);
    }
    signalTarget("SIGKILL");
  }, 25);
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    clearTimeout(timer);
    signalTarget("SIGKILL");
    finish(143);
  });
}

const timer = setTimeout(() => {
  timedOut = true;
  signalTarget("SIGTERM");
  setTimeout(() => {
    signalTarget("SIGKILL");
    if (exited) finish(124);
  }, killAfterMs).unref();
}, timeoutMs);
timer.unref();

child.on("exit", (code) => {
  exited = true;
  const exitCode = timedOut ? 124 : (code ?? 1);
  clearTimeout(timer);
  if (timedOut && targetAlive()) {
    signalTarget("SIGKILL");
  }
  finish(exitCode);
});

child.on("error", () => {
  clearTimeout(timer);
  finish(127);
});
' "$timeout_sec" "$kill_after_sec" "$@" 8>&-
}

agy_write_stop_flag() {
  local flag_path="$1"
  local category="$2"
  local reason="$3"
  local version="${4:-}"
  local attempts="${5:-0}"
  local data_dir
  data_dir=$(dirname "$flag_path")
  mkdir -p -m 700 "$data_dir"

  if node - "$flag_path" "$category" "$reason" "$version" "$attempts" "${NOW_MS:-}" <<'NODE' 2>/dev/null
const fs = require('node:fs');

const [flagPath, category, reason, agyVersion, attemptsRaw, nowOverride] = process.argv.slice(2);
const trippedAtMs = nowOverride && /^\d+$/.test(nowOverride) ? Number(nowOverride) : Date.now();
let finalCategory = category;
let finalAttempts = Number(attemptsRaw) || 0;

// Never downgrade an existing hard_stop flag (e.g. from a racing writer).
try {
  const prev = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
  if (prev && typeof prev === 'object') {
    if (prev.category === 'hard_stop') finalCategory = 'hard_stop';
    if (typeof prev.attempts === 'number' && Number.isFinite(prev.attempts)) {
      finalAttempts = Math.max(finalAttempts, prev.attempts);
    }
  }
} catch {
  // No existing JSON flag.
}

const payload = {
  schemaVersion: 1,
  trippedAt: new Date(trippedAtMs).toISOString(),
  trippedAtMs,
  category: finalCategory,
  reason,
  attempts: finalAttempts,
  ...(agyVersion ? { agyVersion } : {}),
};
const tmp = `${flagPath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, flagPath);
NODE
  then
    return 0
  fi

  # Shell fallback when Node is unavailable: plain-text flag is treated as `hard_stop` everywhere.
  local ts tmp_flag
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmp_flag="${flag_path}.tmp.$$"
  (
    umask 077
    printf '%s hard_stop %s\n' "$ts" "$reason" > "$tmp_flag"
    mv -T -f -- "$tmp_flag" "$flag_path"
  )
}

# Append one sanitized event under `.agy-events.lock` and print the emitted JSON line (empty if
# deduplicated or unwritable). Does NOT invoke the external hook so callers can release `.agy.lock`
# before dispatching slow hooks.
agy_record_event() {
  local events_path="$1"
  local event_name="$2"
  local category="$3"
  local reason="$4"
  local version="${5:-}"
  local dedup_key="${6:-}"
  local data_dir lock_file
  data_dir=$(dirname "$events_path")
  lock_file="$data_dir/.agy-events.lock"
  mkdir -p -m 700 "$data_dir" 2>/dev/null || return 0

  (
    flock -w 10 9 || exit 0
    node - "$events_path" "$event_name" "$category" "$reason" "$version" "$dedup_key" "${NOW_MS:-}" <<'NODE'
const fs = require('node:fs');

const [eventsPath, event, category, reason, agyVersion, dedupKey, nowOverride] =
  process.argv.slice(2);
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
  ...(agyVersion ? { agyVersion } : {}),
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
  ) 9>"$lock_file" 2>/dev/null || true
  return 0
}

# Dispatch one recorded event JSON line to optional AGY_EVENT_HOOK without holding lock fd 8.
agy_dispatch_hook() {
  local line="${1:-}"
  if [[ -n "${AGY_EVENT_HOOK:-}" && -x "${AGY_EVENT_HOOK}" && -n "$line" ]]; then
    printf '%s\n' "$line" | agy_run_with_timeout 10 2 "${AGY_EVENT_HOOK}" >/dev/null 2>&1 || true
  fi
  return 0
}
