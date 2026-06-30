#!/usr/bin/env bash
# Local publisher — run the orchestrator on this machine and write chunks +
# index.json straight to a GCS bucket via GcsStore. Consumers read the bucket
# directly (https://storage.googleapis.com/$BUCKET/...) or, once provisioned, the
# Cloud CDN endpoint in front of it — set CDN_BASE to switch the printed URLs.
#
# Prerequisites:
#   1. npm run build
#   2. npm install @google-cloud/storage        (optional dep; only needed for gs://)
#   3. gcloud auth application-default login     (ADC the SDK reads — NOT `gcloud auth login`)
#   4. a public-read bucket if consumers fetch directly:
#        gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
#          --member=allUsers --role=roles/storage.objectViewer
#
# Usage:
#   BUCKET=pp-state ./publish.sh [extra orchestrator flags...]
#   BUCKET=pp-state/v1 CONFIG=./privacy-pools-config.json ./publish.sh --dry-run
#
# Signing (recommended): the orchestrator signs index.json → index.json.sig when
# MANIFEST_SIGNING_KEY is set. Use a STABLE secret so the public key consumers pin
# does not change between runs:
#   MANIFEST_SIGNING_KEY=0x<ed25519-secret> BUCKET=pp-state ./publish.sh
# Mint a throwaway key for a one-off publish (its public key is printed):
#   GEN_KEY=1 BUCKET=pp-state ./publish.sh
# Generate a stable keypair once with:  node packages/producer/dist/keygen.js
#
# The orchestrator always scans to the current finalized tip (no --to-block).
set -uo pipefail
cd "$(dirname "$0")"

log()  { printf '[publish %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
fail() { printf '[publish %s] ERROR: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

[ -f .rpc.env ] && source .rpc.env   # convenience: load RPC if present

: "${BUCKET:?set BUCKET to your GCS bucket (optionally bucket/prefix)}"
: "${RPC:?set RPC (the Ethereum JSON-RPC URL) or provide it via .rpc.env}"
CONFIG="${CONFIG:-./privacy-pools-config.json}"
LOCK_DIR="${LOCK_DIR:-./.locks}"
# Canonical read endpoint shown to consumers. Defaults to the public bucket URL;
# set CDN_BASE to the Cloud CDN endpoint (http://<lb-ip>/, see deploy/cdn.sh)
# once it's provisioned so every printed command points at the CDN.
CDN_BASE="${CDN_BASE:-https://storage.googleapis.com/$BUCKET/}"
CDN_BASE="${CDN_BASE%/}/"
mkdir -p "$LOCK_DIR"

BUCKET_NAME="${BUCKET%%/*}"                  # bucket without any /prefix
PREFIX="${BUCKET#"$BUCKET_NAME"}"; PREFIX="${PREFIX#/}"

# ---- preflight: fail fast, before the multi-minute scrape ----
log "preflight: checking build, package, credentials, bucket access…"
[ -f packages/producer/dist/orchestrator/cli.js ] || fail "not built — run: npm run build"
[ -f "$CONFIG" ]                || fail "config not found: $CONFIG"
node -e 'import("@google-cloud/storage").catch(()=>process.exit(1))' 2>/dev/null \
  || fail '@google-cloud/storage not installed — run: npm install @google-cloud/storage'
gcloud auth application-default print-access-token >/dev/null 2>&1 \
  || fail 'no Application Default Credentials — run: gcloud auth application-default login'

# Real write probe through the SDK+ADC path the orchestrator uses (writes then
# deletes a tiny object), so auth / bucket / permission problems surface now.
node -e '
import("@google-cloud/storage").then(async ({Storage}) => {
  const f = new Storage().bucket(process.argv[1]).file(process.argv[2]);
  await f.save(Buffer.from("ok"), { resumable: false });
  await f.delete({ ignoreNotFound: true });
}).catch(e => { console.error(e.message); process.exit(1); })
' "$BUCKET_NAME" "${PREFIX:+$PREFIX/}.publish-preflight" \
  || fail "cannot write to gs://$BUCKET — does the bucket exist and your account have objectAdmin?"
log "preflight OK — build, @google-cloud/storage, ADC, and bucket write all verified"

# ---- manifest signing (the orchestrator signs when MANIFEST_SIGNING_KEY is set) ----
PUBLIC_KEY=""
if [ -n "${MANIFEST_SIGNING_KEY:-}" ]; then
  PUBLIC_KEY=$(node -e 'import("@saga-sync/core").then(m=>console.log(m.publicKeyFromSecret(process.argv[1]))).catch(e=>{console.error(e.message);process.exit(1)})' "$MANIFEST_SIGNING_KEY") \
    || fail "MANIFEST_SIGNING_KEY is not a valid 0x-hex Ed25519 secret"
  export MANIFEST_SIGNING_KEY
  log "signing ENABLED — public key: $PUBLIC_KEY"
elif [ "${GEN_KEY:-0}" = "1" ]; then
  eval "$(node packages/producer/dist/keygen.js | grep -E '^(MANIFEST_SIGNING_KEY|PUBLIC_KEY)=')"
  [ -n "${MANIFEST_SIGNING_KEY:-}" ] || fail "key generation failed"
  export MANIFEST_SIGNING_KEY
  log "signing ENABLED with a FRESH EPHEMERAL key — save the secret to reuse it next run:"
  log "    MANIFEST_SIGNING_KEY=$MANIFEST_SIGNING_KEY"
  log "  public key (consumers pin this): $PUBLIC_KEY"
else
  log "signing DISABLED — manifest will be unsigned."
  log "  set MANIFEST_SIGNING_KEY=0x<ed25519-secret> (stable) or GEN_KEY=1 to sign."
fi

# ---- run, with a heartbeat so a silent multi-minute scrape still shows life ----
log "starting orchestrator → gs://$BUCKET (scans to the finalized tip; the scrape can take minutes)"
START=$(date +%s)
node packages/producer/dist/orchestrator/cli.js \
  --config "$CONFIG" --rpc "$RPC" \
  --output-dir "gs://$BUCKET" \
  --lock-dir "$LOCK_DIR" \
  "$@" &
PID=$!
# Heartbeat in its own loop so we can `wait` on the orchestrator directly — a
# quick exit (e.g. lock contention) is reported the instant it happens, not after
# the next 30s tick.
( while kill -0 "$PID" 2>/dev/null; do
    sleep 30
    kill -0 "$PID" 2>/dev/null && log "still running… ($(( $(date +%s) - START ))s elapsed)"
  done ) &
HB=$!
wait "$PID"; CODE=$?
kill "$HB" 2>/dev/null; wait "$HB" 2>/dev/null
ELAPSED=$(( $(date +%s) - START ))
[ "$CODE" -eq 0 ] || fail "orchestrator exited $CODE after ${ELAPSED}s"
log "orchestrator finished in ${ELAPSED}s"

# ---- post-run: show what actually landed in the bucket ----
log "objects now under gs://$BUCKET:"
gcloud storage ls -l "gs://$BUCKET/**" 2>/dev/null | sed 's/^/  /' >&2 \
  || log "  (could not list bucket — check gcloud)"
log "done. consumers read: ${CDN_BASE}index.json"
if [ -n "$PUBLIC_KEY" ]; then
  log "signed manifest — consumers verify with --public-key $PUBLIC_KEY, e.g.:"
  log "  node packages/client/dist/cli.js stream $CDN_BASE <protocolId> --public-key $PUBLIC_KEY"
fi
