#!/usr/bin/env bash
# Capture one zero-turn `/usage` snapshot from the official signed-in `agy` CLI and drop it
# atomically for prox-history. Never touches Google OAuth tokens or private endpoints directly.
# Any unexpected error trips the classified circuit breaker and emits a structured event so
# `prox-agy-recover.path` fires immediately while `prox-agy-usage.timer` stops calling `agy`.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

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

mkdir -p -m 700 "$AGY_DATA_DIR" "$AGY_WORKDIR"

emit_event() {
  local event_name="$1"
  local category="$2"
  local reason="$3"
  local version="${4:-}"
  local line
  line=$(node - "$AGY_EVENTS_PATH" "$event_name" "$category" "$reason" "$version" "${NOW_MS:-}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [eventsPath, event, category, reason, agyVersion, nowOverride] = process.argv.slice(2);
const atMs = nowOverride && /^\d+$/.test(nowOverride) ? Number(nowOverride) : Date.now();
const record = {
  at: new Date(atMs).toISOString(),
  atMs,
  event,
  category,
  reason,
  ...(agyVersion ? { agyVersion } : {}),
};
const line = JSON.stringify(record);
let existing = [];
try {
  existing = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
} catch {
  // first event
}
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
  if [[ "$AGY_RECOVERY_PROBE" == "1" ]]; then
    final_category="hard_stop"
    attempts=1
  fi
  if [[ "$AGY_RECOVERY_PROBE" != "1" ]]; then
    emit_event "circuit_breaker_tripped" "$final_category" "$reason" "$version"
  fi
  node - "$AGY_STOP_FLAG" "$final_category" "$reason" "$version" "$attempts" "${NOW_MS:-}" <<'NODE'
const fs = require('node:fs');

const [flagPath, category, reason, agyVersion, attemptsRaw, nowOverride] = process.argv.slice(2);
const trippedAtMs = nowOverride && /^\d+$/.test(nowOverride) ? Number(nowOverride) : Date.now();
const payload = {
  schemaVersion: 1,
  trippedAt: new Date(trippedAtMs).toISOString(),
  trippedAtMs,
  category,
  reason,
  attempts: Number(attemptsRaw) || 0,
  ...(agyVersion ? { agyVersion } : {}),
};
const tmp = `${flagPath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, flagPath);
NODE
  echo "prox-agy-usage circuit breaker tripped ($final_category: $reason); flag written to $AGY_STOP_FLAG." >&2
  exit 1
}

if [[ ! -x "$AGY_BIN" ]]; then
  trip_stop_flag "hard_stop" "missing-agy-binary"
fi

actual_version=$("$AGY_BIN" --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
if [[ "$actual_version" != "$AGY_EXPECTED_VERSION" ]]; then
  trip_stop_flag "version_changed" "unexpected-agy-version:${actual_version:-unknown}:expected:${AGY_EXPECTED_VERSION}" "$actual_version"
fi

raw_file=$(mktemp "$AGY_DATA_DIR/.agy-raw.XXXXXX")
err_file=$(mktemp "$AGY_DATA_DIR/.agy-err.XXXXXX")
out_file=$(mktemp "$AGY_DATA_DIR/.agy-usage.XXXXXX")
cleanup() {
  rm -f -- "$raw_file" "$err_file" "$out_file"
}
trap cleanup EXIT

cd "$AGY_WORKDIR"
if ! timeout 90 "$AGY_BIN" --output-format json --print-timeout 60s -p "/usage" > "$raw_file" 2> "$err_file"; then
  if grep -Eiq '403|tos_violation|suspended|unauthorized|not logged in|login required|sign.?in' "$raw_file" "$err_file" 2>/dev/null; then
    trip_stop_flag "hard_stop" "auth-or-policy-error" "$actual_version"
  fi
  trip_stop_flag "transient" "agy-command-failed" "$actual_version"
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
    *) trip_stop_flag "transient" "validation-failed" "$actual_version" ;;
  esac
fi

chmod 600 "$out_file"
mv -f -- "$out_file" "$AGY_SNAPSHOT_PATH"
if [[ "$AGY_RECOVERY_PROBE" == "1" ]]; then
  rm -f -- "$AGY_STOP_FLAG"
fi
