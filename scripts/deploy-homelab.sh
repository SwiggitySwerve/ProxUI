#!/usr/bin/env bash
# Build and install Prox UI, quota history and usage collection. Never restart either inference proxy.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
# node, npm and bun live in ~/.local/bin, which only login shells add to PATH;
# `systemd-run --user` starts with a bare PATH and fails with `node: command not found`.
export PATH="$HOME/.local/bin:$PATH"
if [[ ! -r "$HOME/.config/proxd/management-key" ]] || \
   [[ ! -s "$HOME/.config/proxd/management-key" ]]; then
  echo 'Missing readable, non-empty proxy management key.' >&2
  exit 1
fi
package_manager=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).packageManager")
npm exec --yes --package="$package_manager" -- bun install --frozen-lockfile
npm exec --yes --package="$package_manager" -- bun run verify
# Hash both entry points: a writer-only change also requires a collector restart. The source
# manifest is baked into the image and the quadlet holds the key mount, so they count too.
usage_hash=$(sha256sum dist/usage/*.js deploy/provider-sources.json deploy/prox-usage.container |
  sha256sum | cut -d ' ' -f 1)
usage_hash_file="$HOME/.local/share/prox-usage/bundle.sha256"
previous_usage_hash=$(cat "$usage_hash_file" 2>/dev/null || true)
revision=$(git rev-parse HEAD)
podman build -f deploy/Dockerfile --label "org.opencontainers.image.revision=$revision" -t localhost/prox:dev .
podman run --rm --network host --entrypoint nginx localhost/prox:dev -t
podman build -f deploy/Dockerfile.history --label "org.opencontainers.image.revision=$revision" -t localhost/prox-history:dev .
# Each file is written beside its target and renamed, so a run that starts meanwhile never reads
# a half-written one.
install_renamed() { # <source> <target>
  local tmp
  tmp=$(mktemp "${2%/*}/.${2##*/}.XXXXXX")
  install -m 644 "$1" "$tmp" && mv -f -- "$tmp" "$2" || { rm -f -- "$tmp"; return 1; }
}
# Runtime hub discovery. Pause its triggers and let a run they started or queued finish, so no
# run of the previous bundle or baked manifest outlives this deploy; they are enabled again at the
# end, and restarted if the deploy fails before then.
# A systemd query that fails stops the deploy rather than reading as "nothing to wait for".
paused=()
for trigger in prox-sources.path prox-sources-apply.timer; do
  trigger_state=$(systemctl --user is-active "$trigger" || true)
  case "$trigger_state" in
    active|activating|reloading) paused+=("$trigger") ;;
    inactive|failed) ;;
    *) echo "Cannot read the state of $trigger: '$trigger_state'" >&2; exit 1 ;;
  esac
done
if ((${#paused[@]})); then
  trap 'systemctl --user start "${paused[@]}"' EXIT
  systemctl --user stop "${paused[@]}"
fi
while :; do
  # Outside the loop condition, so errexit stops the deploy when the query fails.
  apply_jobs=$(systemctl --user list-jobs --no-legend prox-sources-apply.service)
  [[ -n "$apply_jobs" ]] || break
  sleep 1
done
sources_apply_dir="$HOME/.local/share/prox/sources-apply"
install -d -m 755 "$sources_apply_dir"
install_renamed dist/sources-apply/prox-sources-apply.js "$sources_apply_dir/prox-sources-apply.js"
install_renamed deploy/provider-sources.json "$sources_apply_dir/provider-sources.json"
for unit in prox-sources-apply.service prox-sources-apply.timer prox-sources.path; do
  install -D -m 644 "deploy/$unit" "$HOME/.config/systemd/user/$unit"
done
# The prox Quadlet masks the baked routes and mounts this directory, so it must hold a published
# set before prox restarts, or Nginx would start with no hub routes; podman will not start either
# container while the directory is missing, so the Quadlets are installed only after this. The
# first deploy publishes the baked sources alone (no hub probed, Nginx untouched); later ones keep
# the last set until the apply below. The umask matches the service: Nginx's worker reads it.
if [[ ! -e "$HOME/.local/share/prox/sources/effective-manifest.json" ]]; then
  (umask 022 && bun "$sources_apply_dir/prox-sources-apply.js" --seed \
    --base "$sources_apply_dir/provider-sources.json")
fi
install -d -m 700 "$HOME/.local/share/prox-history" "$HOME/.local/share/prox-usage" "$HOME/.config/prox-usage"
# The rate book is re-read on its modification time; no restart is needed for a price change.
install -m 644 deploy/usage-rates.json "$HOME/.local/share/prox-usage/usage-rates.json"
install -D -m 644 deploy/prox-usage.container "$HOME/.config/containers/systemd/prox-usage.container"
install -D -m 644 deploy/prox-history.container "$HOME/.config/containers/systemd/prox-history.container"
install -D -m 644 deploy/prox.container "$HOME/.config/containers/systemd/prox.container"
install -D -m 755 deploy/prox-auth-janitor.sh "$HOME/.local/share/prox/prox-auth-janitor.sh"
install -D -m 644 deploy/prox-auth-janitor.service "$HOME/.config/systemd/user/prox-auth-janitor.service"
install -D -m 644 deploy/prox-auth-janitor.timer "$HOME/.config/systemd/user/prox-auth-janitor.timer"
# Install the self-contained usage job bundles that `bun run verify` just built from this commit.
# The nightly job spawns parity, so parity is replaced first.
usage_jobs_dir="$HOME/.local/share/prox/usage-jobs"
install -d -m 755 "$usage_jobs_dir"
for bundle in usage-parity.js usage-restore-check.js usage-nightly.js; do
  install_renamed "dist/usage-jobs/$bundle" "$usage_jobs_dir/$bundle"
done
# Fail the deploy now, not at 04:20, if the installed nightly cannot start its sibling parity.
bun "$usage_jobs_dir/usage-nightly.js" --check-install
# Ship job schedules disabled. The operator enables them after the migration gates.
install -D -m 755 deploy/prox-usage-job.sh "$HOME/.local/share/prox/prox-usage-job.sh"
install -D -m 644 deploy/prox-usage-job@.service "$HOME/.config/systemd/user/prox-usage-job@.service"
install -D -m 644 deploy/prox-usage-nightly.service "$HOME/.config/systemd/user/prox-usage-nightly.service"
install -D -m 644 deploy/prox-usage-nightly.timer "$HOME/.config/systemd/user/prox-usage-nightly.timer"
install -D -m 644 deploy/prox-usage-parity.service "$HOME/.config/systemd/user/prox-usage-parity.service"
# Retire units no longer shipped (the independent usage timers, and the janitor's path watcher,
# which fired on every proxy cooldown-file write) before reloading the unit graph.
for unit in prox-usage-prune.timer prox-usage-reconcile.timer prox-usage-backup.timer \
  prox-usage-parity.timer prox-auth-janitor.path; do
  if ! retirement_error=$(LC_ALL=C systemctl --user disable --now "$unit" 2>&1); then
    case "$retirement_error" in
      *"not loaded"*|*"does not exist"*|*"not found"*) ;;
      *) printf '%s\n' "$retirement_error" >&2; exit 1 ;;
    esac
  fi
  rm -f -- "$HOME/.config/systemd/user/$unit" \
    "$HOME/.config/systemd/user/timers.target.wants/$unit" \
    "$HOME/.config/systemd/user/default.target.wants/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now prox-auth-janitor.timer
# UI/history deploys leave the live usage subscription alone when its code did not change.
if [[ "$usage_hash" != "$previous_usage_hash" ]]; then
  systemctl --user restart prox-usage.service
  curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
    --max-time 5 http://127.0.0.1:18320/healthz
  printf '%s\n' "$usage_hash" > "$usage_hash_file"
fi
systemctl --user restart prox.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
  --max-time 5 http://127.0.0.1:18318/healthz
# Until this run, the restarted Nginx serves the set published before the deploy. It applies this
# deploy's baked manifest and instances.json to the live Nginx. A failure leaves that previous set
# live, so the deploy still finishes and reports the failure at the end.
sources_failed=0
systemctl --user start prox-sources-apply.service || sources_failed=1
# Only the published routes serve this path. /healthz answers even when the masked baked routes
# left Nginx with no hub routes at all.
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
  --max-time 5 --output /dev/null http://127.0.0.1:18318/prox/routes-revision
# prox-history restarts after the apply: its watcher only adds sources, so a baked source this
# deploy changed or removed reaches it only through a start that reads the new manifest.
systemctl --user restart prox-history.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
  --max-time 5 http://127.0.0.1:18319/healthz
systemctl --user enable --now prox-sources.path prox-sources-apply.timer
trap - EXIT
if ((sources_failed)); then
  echo 'Prox UI deployed, but prox-sources-apply failed; the previous source routes stay live.' \
    'See journalctl --user -u prox-sources-apply.service. The timer retries it; prox-history' \
    'picks up a changed or removed baked source only at its next restart (the next deploy).' >&2
  exit 1
fi
echo 'Prox UI deployed. Cluster routing and Authentik registration are separate; see docs/PROX-SETUP.md.'
