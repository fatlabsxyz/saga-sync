#!/bin/sh
# Cloud Run Job entrypoint: fetch the config from GCS, then run the orchestrator
# to the finalized tip, writing chunks + (signed) index.json straight to the
# bucket. The orchestrator resumes from the published manifest's lastCoveredBlock,
# so the job is stateless across runs and safe to re-run.
#
# Env (set on the Cloud Run Job):
#   CONFIG_URI            gs://bucket/publish-config.json   config object in GCS
#   OUTPUT_URI            gs://bucket[/prefix]              where chunks + index.json land
#   RPC                   Ethereum JSON-RPC URL             (Secret Manager)
#   MANIFEST_SIGNING_KEY  0x<ed25519 secret>                (Secret Manager; signs when set)
# Extra args are passed through to the orchestrator.
set -eu

: "${CONFIG_URI:?set CONFIG_URI to the gs:// config object}"
: "${OUTPUT_URI:?set OUTPUT_URI to the gs:// output bucket}"
: "${RPC:?set RPC to the Ethereum JSON-RPC URL}"

CONFIG_LOCAL=/tmp/config.json
node /app/docker/fetch-config.mjs "$CONFIG_URI" "$CONFIG_LOCAL"

if [ -n "${MANIFEST_SIGNING_KEY:-}" ]; then
  echo "[entrypoint] manifest signing ENABLED"
else
  echo "[entrypoint] manifest signing DISABLED (set MANIFEST_SIGNING_KEY to sign)"
fi

echo "[entrypoint] orchestrator -> ${OUTPUT_URI} (scanning to finalized tip)"
# No --lock-dir: on a gs:// target the lock harmlessly defaults to cwd; on Cloud
# Run, single-execution scheduling is the real concurrency guard.
exec node /app/packages/producer/dist/orchestrator/cli.js \
  --config "$CONFIG_LOCAL" \
  --rpc "$RPC" \
  --output-dir "$OUTPUT_URI" \
  "$@"
