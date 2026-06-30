#!/usr/bin/env bash
# Put Cloud CDN in front of the public state bucket via an external HTTP(S) load
# balancer with a CDN-enabled backend bucket. Idempotent: describe-then-create
# for each resource. Run from the repo root. Requires gcloud + an account with
# compute-network admin rights on the project.
#
# Why HTTP-only on the anycast IP (no domain / no TLS): the manifest is
# Ed25519-signed and every chunk is content-hash-verified on read, so the client
# already guarantees integrity end-to-end — transport TLS adds nothing here, and
# the payload is public on-chain data. To put a domain + HTTPS in front later,
# add a managed cert + target-https-proxy + :443 forwarding rule pointed at the
# same IP; nothing below changes.
set -euo pipefail

# ---- fill these in (or export before running) ----
PROJECT="${PROJECT:?set PROJECT=your-gcp-project-id}"
BUCKET="${BUCKET:?set BUCKET=your-state-bucket (e.g. pp-state)}"

IP_NAME="${IP_NAME:-pp-state-ip}"                        # reserved global anycast IP
BACKEND="${BACKEND:-pp-state-backend}"                   # CDN-enabled backend bucket
URLMAP="${URLMAP:-pp-state-urlmap}"
PROXY="${PROXY:-pp-state-http-proxy}"
RULE="${RULE:-pp-state-fwd}"                             # global forwarding rule

echo "==> enabling compute API"
gcloud services enable --project "$PROJECT" compute.googleapis.com

echo "==> reserved global IP ($IP_NAME)"
gcloud compute addresses describe "$IP_NAME" --project "$PROJECT" --global >/dev/null 2>&1 \
  || gcloud compute addresses create "$IP_NAME" --project "$PROJECT" --global
IP=$(gcloud compute addresses describe "$IP_NAME" --project "$PROJECT" --global \
       --format="value(address)")

echo "==> CDN backend bucket ($BACKEND -> gs://$BUCKET)"
# USE_ORIGIN_HEADERS makes Cloud CDN honour the per-object Cache-Control that
# GcsStore writes (sealed chunks immutable/1y, manifest+hot 30s) instead of
# imposing one blanket TTL. See src/storage/gcs-store.ts:cacheControlFor.
if gcloud compute backend-buckets describe "$BACKEND" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute backend-buckets update "$BACKEND" --project "$PROJECT" \
    --gcs-bucket-name "$BUCKET" --enable-cdn --cache-mode USE_ORIGIN_HEADERS
else
  gcloud compute backend-buckets create "$BACKEND" --project "$PROJECT" \
    --gcs-bucket-name "$BUCKET" --enable-cdn --cache-mode USE_ORIGIN_HEADERS
fi

echo "==> URL map ($URLMAP)"
gcloud compute url-maps describe "$URLMAP" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute url-maps create "$URLMAP" --project "$PROJECT" \
       --default-backend-bucket "$BACKEND"

echo "==> target HTTP proxy ($PROXY)"
gcloud compute target-http-proxies describe "$PROXY" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud compute target-http-proxies create "$PROXY" --project "$PROJECT" \
       --url-map "$URLMAP"

echo "==> global forwarding rule ($RULE, :80 -> $IP)"
gcloud compute forwarding-rules describe "$RULE" --project "$PROJECT" --global >/dev/null 2>&1 \
  || gcloud compute forwarding-rules create "$RULE" --project "$PROJECT" --global \
       --address "$IP_NAME" --target-http-proxy "$PROXY" --ports 80

echo "==> done. canonical endpoint (allow a few min for the LB to go live):"
echo "    CDN base        : http://$IP/"
echo "    consumers read  : http://$IP/index.json"
echo "    smoke-test      : curl -sI http://$IP/index.json   # expect Cache-Control: public, max-age=30"
echo "    cache split chk : curl -sI \"http://$IP/<a-sealed-chunk>.jsonl.gz\"  # expect max-age=31536000, immutable"
