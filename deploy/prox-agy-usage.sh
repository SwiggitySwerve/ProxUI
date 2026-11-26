#!/usr/bin/env bash
# Capture one zero-turn `/usage` snapshot from the official signed-in `agy` CLI and drop it
# atomically for prox-history. Never touches Google OAuth tokens or private endpoints directly.
# Any unexpected error trips the stop flag so a systemd timer never retries a failing account.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}"
AGY_EXPECTED_VERSION="${AGY_EXPECTED_VERSION:-1.5.17}"
AGY_DATA_DIR="${AGY_DATA_DIR:-$HOME/.local/share/prox-history}"
AGY_SNAPSHOT_PATH="${AGY_SNAPSHOT_PATH:-$AGY_DATA_DIR/agy-usage.json}"
AGY_STOP_FLAG="${AGY_STOP_FLAG:-$AGY_DATA_DIR/agy-usage.stopped}"
AGY_WORKDIR="${AGY_WORKDIR:-$AGY_DATA_DIR/agy-cwd}"
AGY_INSTANCE_ID="${AGY_INSTANCE_ID:-gemini-primary}"
AGY_SOURCE_LABEL="${AGY_SOURCE_LABEL:-Gemini}"
AGY_PLAN="${AGY_PLAN:-g1-ultra-tier}"

mkdir -p -m 700 "$AGY_DATA_DIR" "$AGY_WORKDIR"

if [[ -e "$AGY_STOP_FLAG" ]]; then
  echo "prox-agy-usage paused by stop flag ($AGY_STOP_FLAG); clear it manually to resume." >&2
  exit 0
fi

trip_stop_flag() {
  local reason="$1"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  umask 077
  printf '%s %s\n' "$ts" "$reason" > "$AGY_STOP_FLAG"
  echo "prox-agy-usage stopped ($reason); stop flag written to $AGY_STOP_FLAG." >&2
  exit 1
}

if [[ ! -x "$AGY_BIN" ]]; then
  trip_stop_flag "missing-agy-binary"
fi

actual_version=$("$AGY_BIN" --version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
if [[ "$actual_version" != "$AGY_EXPECTED_VERSION" ]]; then
  trip_stop_flag "unexpected-agy-version:${actual_version:-unknown}:expected:${AGY_EXPECTED_VERSION}"
fi

raw_file=$(mktemp "$AGY_DATA_DIR/.agy-raw.XXXXXX")
out_file=$(mktemp "$AGY_DATA_DIR/.agy-usage.XXXXXX")
cleanup() {
  rm -f -- "$raw_file" "$out_file"
}
trap cleanup EXIT

cd "$AGY_WORKDIR"
if ! timeout 90 "$AGY_BIN" --output-format json --print-timeout 60s -p "/usage" > "$raw_file" 2>/dev/null; then
  trip_stop_flag "agy-command-failed"
fi

if ! node - "$raw_file" "$out_file" "$AGY_INSTANCE_ID" "$AGY_SOURCE_LABEL" "$actual_version" "$AGY_PLAN" <<'NODE'
const fs = require('node:fs');

const [rawPath, outPath, instanceId, sourceLabel, agyVersion, plan] = process.argv.slice(2);
const raw = fs.readFileSync(rawPath, 'utf8');
if (!raw.trim() || Buffer.byteLength(raw, 'utf8') > 256 * 1024) {
  console.error('invalid-size');
  process.exit(2);
}
if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(raw)) {
  console.error('unexpected-email-in-output');
  process.exit(3);
}
let usage;
try {
  usage = JSON.parse(raw);
} catch {
  console.error('invalid-json');
  process.exit(4);
}
if (
  !usage ||
  typeof usage !== 'object' ||
  usage.status !== 'SUCCESS' ||
  usage.num_turns !== 0 ||
  !usage.usage ||
  usage.usage.total_tokens !== 0 ||
  !usage.command ||
  usage.command.name !== 'usage' ||
  !usage.command.data ||
  !Array.isArray(usage.command.data.groups)
) {
  console.error('unexpected-usage-envelope');
  process.exit(5);
}

let has5h = false;
let hasWeekly = false;
for (const group of usage.command.data.groups) {
  if (!group || typeof group.name !== 'string' || !Array.isArray(group.buckets)) {
    console.error('invalid-group');
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
      console.error('invalid-bucket');
      process.exit(7);
    }
    if (isGemini && bucket.id.trim() === 'gemini-5h') has5h = true;
    if (isGemini && bucket.id.trim() === 'gemini-weekly') hasWeekly = true;
  }
}
if (!has5h || !hasWeekly) {
  console.error('missing-gemini-pool-buckets');
  process.exit(8);
}

const envelope = {
  schemaVersion: 1,
  instanceId,
  sourceLabel,
  observedAtMs: Date.now(),
  agyVersion,
  ...(plan ? { plan } : {}),
  usage,
};
fs.writeFileSync(outPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
NODE
then
  trip_stop_flag "validation-failed"
fi

chmod 600 "$out_file"
mv -f -- "$out_file" "$AGY_SNAPSHOT_PATH"
