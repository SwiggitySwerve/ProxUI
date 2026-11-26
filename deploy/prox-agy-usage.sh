#!/usr/bin/env bash
# Capture one zero-turn `/usage` snapshot from the official signed-in `agy` CLI and drop it
# atomically for prox-history. Never touches Google OAuth tokens or private endpoints directly.
# Serialized with `prox-agy-recover.sh` under `.agy.lock` so circuit-breaker transitions never race.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/prox-agy-lib.sh
source "${AGY_LIB_PATH:-$SCRIPT_DIR/prox-agy-lib.sh}"

AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}"
AGY_EXPECTED_VERSION="${AGY_EXPECTED_VERSION:-1.5.17}"
AGY_DATA_DIR="${AGY_DATA_DIR:-$HOME/.local/share/prox-history}"
AGY_SNAPSHOT_PATH="${AGY_SNAPSHOT_PATH:-$AGY_DATA_DIR/agy-usage.json}"
AGY_STOP_FLAG="${AGY_STOP_FLAG:-$AGY_DATA_DIR/agy-usage.stopped}"
AGY_EVENTS_PATH="${AGY_EVENTS_PATH:-$AGY_DATA_DIR/agy-events.jsonl}"
AGY_EVENT_HOOK="${AGY_EVENT_HOOK:-}"
AGY_WORKDIR="${AGY_WORKDIR:-$AGY_DATA_DIR/agy-cwd}"
AGY_INSTANCE_ID="${AGY_INSTANCE_ID:-gemini-primary}"
AGY_SOURCE_LABEL="${AGY_SOURCE_LABEL:-Gemini}"
AGY_PLAN="${AGY_PLAN:-g1-ultra-tier}"
AGY_RECOVERY_PROBE="${AGY_RECOVERY_PROBE:-0}"
AGY_VERSION_TIMEOUT_SEC="${AGY_VERSION_TIMEOUT_SEC:-15}"
AGY_USAGE_TIMEOUT_SEC="${AGY_USAGE_TIMEOUT_SEC:-90}"
AGY_KILL_AFTER_SEC="${AGY_KILL_AFTER_SEC:-5}"

mkdir -p -m 700 "$AGY_DATA_DIR" "$AGY_WORKDIR"

lock_held=0
if [[ "$AGY_RECOVERY_PROBE" != "1" ]]; then
  exec 8>"$AGY_DATA_DIR/.agy.lock"
  if ! flock -n 8; then
    exit 0
  fi
  lock_held=1
fi

release_lock() {
  if ((lock_held == 1)); then
    exec 8>&-
    lock_held=0
  fi
}

if [[ "$AGY_RECOVERY_PROBE" != "1" && -e "$AGY_STOP_FLAG" ]]; then
  echo "prox-agy-usage paused by circuit breaker ($AGY_STOP_FLAG); awaiting recovery check or manual clear." >&2
  exit 0
fi

trip_stop_flag() {
  local category="$1"
  local reason="$2"
  local version="${3:-}"
  local final_category="$category"
  local attempts=0
  local event_line=""
  if [[ "$AGY_RECOVERY_PROBE" == "1" ]]; then
    final_category="hard_stop"
    attempts=1
  fi
  # Always persist the stop flag first, then record the event, then release `.agy.lock` BEFORE
  # invoking any external event hook so a slow hook never blocks `prox-agy-recover.path`.
  agy_write_stop_flag "$AGY_STOP_FLAG" "$final_category" "$reason" "$version" "$attempts"
  if [[ "$AGY_RECOVERY_PROBE" != "1" ]]; then
    event_line=$(agy_record_event "$AGY_EVENTS_PATH" "circuit_breaker_tripped" "$final_category" "$reason" "$version" || true)
  fi
  release_lock
  if [[ -n "$event_line" ]]; then
    agy_dispatch_hook "$event_line"
  fi
  echo "prox-agy-usage circuit breaker tripped ($final_category: $reason); flag written to $AGY_STOP_FLAG." >&2
  exit 1
}

if [[ ! -x "$AGY_BIN" ]]; then
  trip_stop_flag "hard_stop" "missing-agy-binary"
fi
if ! command -v node >/dev/null 2>&1; then
  trip_stop_flag "hard_stop" "missing-node-runtime"
fi

# Run CLI commands inside a dedicated process group (with fd 8 closed) so timeouts kill every
# descendant cleanly without leaking the lock.
version_file=$(mktemp "$AGY_DATA_DIR/.agy-ver.XXXXXX")
raw_file=$(mktemp "$AGY_DATA_DIR/.agy-raw.XXXXXX")
err_file=$(mktemp "$AGY_DATA_DIR/.agy-err.XXXXXX")
out_file=$(mktemp "$AGY_DATA_DIR/.agy-usage.XXXXXX")
cleanup() {
  rm -f -- "$version_file" "$raw_file" "$err_file" "$out_file"
}
trap cleanup EXIT

version_exit=0
AGY_TIMEOUT_SAME_GROUP="$AGY_RECOVERY_PROBE" agy_run_with_timeout "$AGY_VERSION_TIMEOUT_SEC" "$AGY_KILL_AFTER_SEC" "$AGY_BIN" --version > "$version_file" 2>/dev/null || version_exit=$?
if ((version_exit == 124 || version_exit == 137)); then
  trip_stop_flag "transient" "agy-version-timeout"
fi
actual_version=$(head -n 1 "$version_file" | tr -d '[:space:]')
if [[ "$actual_version" != "$AGY_EXPECTED_VERSION" ]]; then
  trip_stop_flag "version_changed" "unexpected-agy-version:${actual_version:-unknown}:expected:${AGY_EXPECTED_VERSION}" "$actual_version"
fi

cd "$AGY_WORKDIR"
cmd_exit=0
AGY_TIMEOUT_SAME_GROUP="$AGY_RECOVERY_PROBE" agy_run_with_timeout "$AGY_USAGE_TIMEOUT_SEC" "$AGY_KILL_AFTER_SEC" "$AGY_BIN" --output-format json --print-timeout 60s -p "/usage" > "$raw_file" 2> "$err_file" || cmd_exit=$?
if ((cmd_exit != 0)); then
  # Fail closed by default: only explicit timeout exits and recognized network/transport
  # diagnostics qualify as `transient`; auth, policy, rate-limit, CLI flag, and unknown errors
  # always force `hard_stop`.
  if grep -Eiq '401|403|429|unauthenticated|tos_violation|suspended|unauthorized|forbidden|permission_denied|not logged in|login required|sign.?in|rate.?limit' "$raw_file" "$err_file" 2>/dev/null; then
    trip_stop_flag "hard_stop" "auth-or-policy-error" "$actual_version"
  fi
  if ((cmd_exit == 124 || cmd_exit == 137)); then
    trip_stop_flag "transient" "agy-command-timeout" "$actual_version"
  fi
  if grep -Eiq 'timed out|deadline exceeded|request timeout|connection timeout|econnreset|econnrefused|etimedout|ehostunreach|enetunreach|eai_again|temporary failure in name resolution|connection reset|network is unreachable|bad gateway|service unavailable|(http([[:space:]]+status)?|status([[:space:]]+code)?)[:[:space:]]+50[234]\b' "$raw_file" "$err_file" 2>/dev/null; then
    trip_stop_flag "transient" "agy-transient-transport-error" "$actual_version"
  fi
  trip_stop_flag "hard_stop" "agy-command-failed" "$actual_version"
fi

validation_code=0
node - "$raw_file" "$out_file" "$AGY_INSTANCE_ID" "$AGY_SOURCE_LABEL" "$actual_version" "$AGY_PLAN" "${NOW_MS:-}" <<'NODE' || validation_code=$?
const fs = require('node:fs');

const [rawPath, outPath, instanceId, sourceLabel, agyVersion, plan, nowOverride] = process.argv.slice(2);
const raw = fs.readFileSync(rawPath, 'utf8');
if (!raw.trim() || Buffer.byteLength(raw, 'utf8') > 256 * 1024) {
  process.exit(2);
}
if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw)) {
  process.exit(3);
}
let usage;
try {
  usage = JSON.parse(raw);
} catch {
  process.exit(4);
}
if (
  !usage ||
  typeof usage !== 'object' ||
  usage.num_turns !== 0 ||
  !usage.usage ||
  usage.usage.total_tokens !== 0
) {
  process.exit(9);
}
if (
  usage.status !== 'SUCCESS' ||
  !usage.command ||
  usage.command.name !== 'usage' ||
  !usage.command.data ||
  !Array.isArray(usage.command.data.groups)
) {
  process.exit(5);
}

let has5h = false;
let hasWeekly = false;
for (const group of usage.command.data.groups) {
  if (!group || typeof group.name !== 'string' || !Array.isArray(group.buckets)) {
    process.exit(6);
  }
  const isGemini = group.name.trim().toLowerCase() === 'gemini models';
  for (const bucket of group.buckets) {
    if (
      !bucket ||
      typeof bucket.id !== 'string' ||
      typeof bucket.name !== 'string' ||
      typeof bucket.window !== 'string' ||
      typeof bucket.remaining_fraction !== 'number' ||
      !Number.isFinite(bucket.remaining_fraction) ||
      bucket.remaining_fraction < 0 ||
      bucket.remaining_fraction > 1 ||
      typeof bucket.reset_time !== 'string' ||
      !Number.isFinite(Date.parse(bucket.reset_time))
    ) {
      process.exit(7);
    }
    if (isGemini && bucket.id.trim() === 'gemini-5h') has5h = true;
    if (isGemini && bucket.id.trim() === 'gemini-weekly') hasWeekly = true;
  }
}
if (!has5h || !hasWeekly) {
  process.exit(8);
}

const observedAtMs = nowOverride && /^\d+$/.test(nowOverride) ? Number(nowOverride) : Date.now();
const envelope = {
  schemaVersion: 1,
  instanceId,
  sourceLabel,
  observedAtMs,
  agyVersion,
  ...(plan ? { plan } : {}),
  usage,
};
fs.writeFileSync(outPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
NODE

if ((validation_code != 0)); then
  case "$validation_code" in
    3) trip_stop_flag "hard_stop" "unexpected-email-in-output" "$actual_version" ;;
    9) trip_stop_flag "hard_stop" "non-zero-turns" "$actual_version" ;;
    *) trip_stop_flag "hard_stop" "validation-failed" "$actual_version" ;;
  esac
fi

if ! chmod 600 "$out_file" || ! mv -T -f -- "$out_file" "$AGY_SNAPSHOT_PATH"; then
  trip_stop_flag "hard_stop" "snapshot-write-failed" "$actual_version"
fi
if [[ "$AGY_RECOVERY_PROBE" == "1" ]]; then
  rm -f -- "$AGY_STOP_FLAG"
fi
