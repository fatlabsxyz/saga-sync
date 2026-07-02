#!/usr/bin/env bash
# Provision + deploy the daily scraper as a Cloud Run Job triggered by Cloud
# Scheduler. Idempotent: describes-then-create-or-update for each resource.
# Run from the repo root. Requires: gcloud, an authenticated account with
# project-owner-ish rights, and the two secrets created first (see SECRETS below).
set -euo pipefail

# ---- fill these in (or export before running) ----
PROJECT="${PROJECT:?set PROJECT=your-gcp-project-id}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-scraper}"                                  # Artifact Registry repo
IMAGE="${IMAGE:-$REGION-docker.pkg.dev/$PROJECT/$REPO/scraper}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
BUILD="${BUILD:-cloud}"                                  # cloud | local | skip

BUCKET="${BUCKET:?set BUCKET=your-state-bucket (output; e.g. pp-state)}"
OUTPUT_URI="gs://$BUCKET"
CONFIG_URI="${CONFIG_URI:-gs://$BUCKET/publish-config.json}"

JOB="${JOB:-scraper-daily}"
SCHED="${SCHED:-scraper-daily}"
CRON="${CRON:-0 6 * * *}"                                # 06:00 UTC daily
SA="${SA:-scraper-job@$PROJECT.iam.gserviceaccount.com}"
SA_NAME="${SA%%@*}"
ALERT_EMAIL="${ALERT_EMAIL:-}"                           # set to wire a failure alert
# Canonical read endpoint shown in the summary. Defaults to the public bucket
# URL; set CDN_BASE to the Cloud CDN endpoint (http://<lb-ip>/, deploy/cdn.sh).
CDN_BASE="${CDN_BASE:-https://storage.googleapis.com/$BUCKET/}"
CDN_BASE="${CDN_BASE%/}/"

# SECRETS — create these once with YOUR values (never committed):
#   printf '%s' "$ALCHEMY_RPC_URL" | gcloud secrets create scraper-rpc \
#     --project "$PROJECT" --replication-policy=automatic --data-file=-
#   printf '%s' "0x<stable-ed25519-secret>" | gcloud secrets create scraper-signing-key \
#     --project "$PROJECT" --replication-policy=automatic --data-file=-
# Generate a stable signing key once with:  node packages/producer/dist/keygen.js

echo "==> enabling APIs"
gcloud services enable --project "$PROJECT" \
  run.googleapis.com cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com

echo "==> Artifact Registry repo ($REPO)"
gcloud artifacts repositories describe "$REPO" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --project "$PROJECT" --location "$REGION" \
       --repository-format docker

echo "==> build + push image ($IMAGE:$TAG) [BUILD=$BUILD]"
case "$BUILD" in
  cloud)  # build on Cloud Build (needs cloudbuild.builds.editor + the build SA's builder role)
    gcloud builds submit --project "$PROJECT" --tag "$IMAGE:$TAG" . ;;
  local)  # build + push with the local Docker daemon (needs only artifactregistry.writer).
          # --platform linux/amd64: Cloud Run needs amd64 even on an arm64 Mac.
          # --provenance=false: emit a plain image manifest, not an OCI index with
          # attestations (Cloud Run rejects the index type).
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
    docker build --platform linux/amd64 --provenance=false -t "$IMAGE:$TAG" .
    docker push "$IMAGE:$TAG" ;;
  skip)   # image already in Artifact Registry at this tag — just verify it's there
    gcloud artifacts docker images describe "$IMAGE:$TAG" --project "$PROJECT" >/dev/null \
      || { echo "  !! BUILD=skip but $IMAGE:$TAG not found in Artifact Registry"; exit 1; }
    echo "  using existing image $IMAGE:$TAG" ;;
  *) echo "  !! BUILD must be cloud|local|skip (got '$BUILD')"; exit 1 ;;
esac

echo "==> service account ($SA)"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" \
       --display-name "Daily privacy-protocol scraper job"

echo "==> output bucket (gs://$BUCKET)"
gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" \
       --location "$REGION" --uniform-bucket-level-access

echo "==> bucket access for the job SA (read config + write chunks)"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null

echo "==> secret access for the job SA"
MISSING=0
for S in scraper-rpc scraper-signing-key; do
  if gcloud secrets describe "$S" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT" \
      --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  else
    echo "  !! secret '$S' missing — create it (see SECRETS in this script), then re-run"
    MISSING=1
  fi
done
[ "$MISSING" = 1 ] && exit 1

echo "==> upload config to the bucket"
gcloud storage cp ./publish-config.json "$CONFIG_URI"

echo "==> Cloud Run Job ($JOB)"
JOB_FLAGS=(
  --project "$PROJECT" --region "$REGION"
  --image "$IMAGE:$TAG"
  --service-account "$SA"
  --set-env-vars "CONFIG_URI=$CONFIG_URI,OUTPUT_URI=$OUTPUT_URI"
  --set-secrets "RPC=scraper-rpc:latest,MANIFEST_SIGNING_KEY=scraper-signing-key:latest"
  # The orchestrator scrapes protocols in parallel (default --concurrency 4).
  # Each in-flight protocol buffers up to ~10 MiB, so give the job headroom;
  # raise memory and concurrency together (and mind the RPC rate limit) to go
  # faster. Pass a different value by appending `--args=--concurrency=N` here.
  --memory 1Gi --cpu 1
  --task-timeout 1800 --max-retries 1
)
if gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update "$JOB" "${JOB_FLAGS[@]}"
else
  gcloud run jobs create "$JOB" "${JOB_FLAGS[@]}"
fi

echo "==> let the scheduler SA invoke the job"
gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$SA" --role roles/run.invoker >/dev/null

echo "==> Cloud Scheduler trigger ($SCHED, '$CRON' UTC)"
RUN_URI="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT/jobs/$JOB:run"
SCHED_FLAGS=(
  --project "$PROJECT" --location "$REGION"
  --schedule "$CRON" --time-zone "Etc/UTC"
  --uri "$RUN_URI" --http-method POST
  --oauth-service-account-email "$SA"
)
if gcloud scheduler jobs describe "$SCHED" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHED" "${SCHED_FLAGS[@]}"
else
  gcloud scheduler jobs create http "$SCHED" "${SCHED_FLAGS[@]}"
fi

echo "==> failure alert"
if [ -z "$ALERT_EMAIL" ]; then
  echo "  (skipped — set ALERT_EMAIL=you@example.com to wire a Cloud Monitoring email alert)"
else
  CH_DISPLAY="scraper-daily alerts"
  # grep '^projects/' guards against gcloud printing component-update / warning
  # noise to stdout (e.g. on first alpha/beta use) being mistaken for a resource.
  # NB: the enum value MUST be quoted — `type=email` (bare) matches nothing in
  # gcloud's filter parser, so an unquoted guard never finds the existing channel
  # and every run creates a duplicate. `type="email"` works.
  CHANNEL=$(gcloud beta monitoring channels list --project "$PROJECT" \
    --filter="type=\"email\" AND displayName=\"$CH_DISPLAY\"" --format="value(name)" 2>/dev/null \
    | grep '^projects/' | head -1) || true   # no match => empty (set -e/pipefail safe)
  if [ -z "$CHANNEL" ]; then
    CHANNEL=$(gcloud beta monitoring channels create --project "$PROJECT" \
      --type=email --display-name="$CH_DISPLAY" \
      --channel-labels="email_address=$ALERT_EMAIL" --format="value(name)")
  fi

  POLICY_DISPLAY="$JOB job failed"
  EXISTING_POLICY=$(gcloud alpha monitoring policies list --project "$PROJECT" \
    --filter="displayName=\"$POLICY_DISPLAY\"" --format="value(name)" 2>/dev/null \
    | grep '^projects/' | head -1) || true   # no match => empty (set -e/pipefail safe)
  if [ -n "$EXISTING_POLICY" ]; then
    echo "  (policy '$POLICY_DISPLAY' already exists — leaving it)"
  else
    # Fire when a job execution finishes with result=failed. ALIGN_DELTA over a
    # 10m window counts the failed completions in each period; >0 alerts.
    POLICY_FILE="$(mktemp)"
    cat > "$POLICY_FILE" <<JSON
{
  "displayName": "$POLICY_DISPLAY",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "Cloud Run Job execution failed",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"$JOB\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "trigger": { "count": 1 },
        "aggregations": [
          { "alignmentPeriod": "600s", "perSeriesAligner": "ALIGN_DELTA" }
        ]
      }
    }
  ],
  "notificationChannels": ["$CHANNEL"],
  "alertStrategy": { "autoClose": "604800s" }
}
JSON
    gcloud alpha monitoring policies create --project "$PROJECT" --policy-from-file="$POLICY_FILE"
    rm -f "$POLICY_FILE"
  fi

  # Absence-of-success: the failure alert above only fires when an execution
  # *runs and exits non-zero*. It can't catch the job ceasing to run at all
  # (Scheduler misfire, trigger/job deleted, IAM broken) — there's simply no
  # failed-execution metric to threshold on. Alert when no *succeeded*
  # execution lands within ~a day. Monitoring caps the absence window at 25h
  # (1d1h) — both conditionAbsence and MQL absent_for; longer values are
  # rejected (INVALID_ARGUMENT). 25h = the 24h daily cadence + 1h slack for
  # scheduler jitter: a genuinely dead job pages by the next day while a
  # slightly-late run doesn't. (Cold start: absent_for only tracks once the
  # series has existed, i.e. after the first successful run — that's the baseline.)
  ABSENCE_DISPLAY="$JOB no successful run"
  EXISTING_ABSENCE=$(gcloud alpha monitoring policies list --project "$PROJECT" \
    --filter="displayName=\"$ABSENCE_DISPLAY\"" --format="value(name)" 2>/dev/null \
    | grep '^projects/' | head -1) || true   # no match => empty (set -e/pipefail safe)
  if [ -n "$EXISTING_ABSENCE" ]; then
    echo "  (policy '$ABSENCE_DISPLAY' already exists — leaving it)"
  else
    ABSENCE_FILE="$(mktemp)"
    cat > "$ABSENCE_FILE" <<JSON
{
  "displayName": "$ABSENCE_DISPLAY",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "No successful execution in 25h",
      "conditionMonitoringQueryLanguage": {
        "query": "fetch cloud_run_job | metric 'run.googleapis.com/job/completed_execution_count' | filter (resource.job_name == '$JOB') && (metric.result == 'succeeded') | align rate(1m) | absent_for 25h",
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "notificationChannels": ["$CHANNEL"],
  "alertStrategy": { "autoClose": "604800s" }
}
JSON
    gcloud alpha monitoring policies create --project "$PROJECT" --policy-from-file="$ABSENCE_FILE"
    rm -f "$ABSENCE_FILE"
  fi
fi

echo "==> done."
echo "    one-off run now : gcloud run jobs execute $JOB --project $PROJECT --region $REGION"
echo "    logs            : gcloud run jobs executions list --job $JOB --project $PROJECT --region $REGION"
echo "    consumers read  : ${CDN_BASE}index.json"
