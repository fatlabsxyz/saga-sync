#!/usr/bin/env bash
# Local publisher — run the orchestrator on this machine and write chunks +
# index.json straight to a GCS bucket via GcsStore. Bucket-only for now (no CDN);
# consumers read https://storage.googleapis.com/$BUCKET/...
#
# Prerequisites:
#   1. npm run build
#   2. npm install @google-cloud/storage        (optional dep; only needed for gs://)
#   3. gcloud auth application-default login     (ADC the SDK picks up), and a
#      service account / user with objectAdmin on the bucket
#   4. a public-read bucket if consumers fetch directly:
#        gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
#          --member=allUsers --role=roles/storage.objectViewer
#
# Usage:
#   BUCKET=pp-state ./publish.sh [extra orchestrator flags...]
#   BUCKET=pp-state/v1 CONFIG=./privacy-pools-config.json ./publish.sh --to-block 0x1811bac
set -euo pipefail
cd "$(dirname "$0")"

[ -f .rpc.env ] && source .rpc.env   # convenience: load RPC if present

: "${BUCKET:?set BUCKET to your GCS bucket (optionally bucket/prefix)}"
: "${RPC:?set RPC (the Ethereum JSON-RPC URL) or provide it via .rpc.env}"
CONFIG="${CONFIG:-./privacy-pools-config.json}"
LOCK_DIR="${LOCK_DIR:-./.locks}"     # lockfile is filesystem-only; keep it local
mkdir -p "$LOCK_DIR"

echo "publishing $CONFIG -> gs://$BUCKET (lock: $LOCK_DIR)"
exec node dist/orchestrator/cli.js \
  --config "$CONFIG" --rpc "$RPC" \
  --output-dir "gs://$BUCKET" \
  --lock-dir "$LOCK_DIR" \
  "$@"
