# Deploying the scraper as a daily Cloud Run Job

The orchestrator resumes from the **published manifest's `lastCoveredBlock`** (see
`src/orchestrator/cli.ts`), so a run carries no durable local state — the GCS
bucket is both the output and the source of truth. That makes it a clean fit for
scheduled, scale-to-zero batch:

```
Cloud Scheduler (daily cron)
   └─► Cloud Run Job ──► scrape to finalized tip ──► chunks + signed index.json ──► gs://BUCKET
            ▲                                                                            │
       Secret Manager (RPC, signing key)                              consumers read over HTTPS
            ▲
       gs://BUCKET/publish-config.json  (the 3-protocol config, fetched at startup)
```

## Pieces

| File | Role |
|---|---|
| `Dockerfile` | Multi-stage build → slim runtime image (`npm ci --omit=dev` keeps the optional GCS SDK). |
| `docker/entrypoint.sh` | Fetches config from GCS, then runs the orchestrator → `gs://BUCKET`. No `--lock-dir` (single-execution scheduling is the guard). |
| `docker/fetch-config.mjs` | Downloads `CONFIG_URI` to `/tmp/config.json` via the same ADC the orchestrator uses. |
| `publish-config.json` | The three protocols (privacy-pools, tornado, railgun). Uploaded to the bucket; **not** baked into the image, so the protocol set changes without a rebuild. |
| `deploy/cloud-run-job.sh` | Idempotent provisioning: Artifact Registry, image build, service account + IAM, Cloud Run Job, Cloud Scheduler. |

## One-time setup

1. **Secrets** (your values, never committed) — a *stable* Ed25519 key so the public
   key consumers pin never changes:
   ```sh
   node dist/keygen.js     # prints MANIFEST_SIGNING_KEY + PUBLIC_KEY; save both
   printf '%s' "$ALCHEMY_RPC_URL" | gcloud secrets create scraper-rpc \
     --project "$PROJECT" --replication-policy=automatic --data-file=-
   printf '%s' "0x<the-ed25519-secret>" | gcloud secrets create scraper-signing-key \
     --project "$PROJECT" --replication-policy=automatic --data-file=-
   ```
2. **Deploy** everything else:
   ```sh
   PROJECT=my-proj BUCKET=pp-state ./deploy/cloud-run-job.sh
   ```
3. **Smoke test** a one-off run, then watch it land:
   ```sh
   gcloud run jobs execute scraper-daily --project "$PROJECT" --region us-central1
   gcloud storage ls -l gs://pp-state/**
   ```

## Serving + caching caveat

For an MVP, make the bucket public-read and consumers fetch
`https://storage.googleapis.com/$BUCKET/index.json`:
```sh
gcloud storage buckets add-iam-policy-binding gs://pp-state \
  --member=allUsers --role=roles/storage.objectViewer
```
Note: **public GCS objects get a default `Cache-Control: public, max-age=3600`**, so
`index.json` and the hot head can be served up to an hour stale. Acceptable for a
daily feed. If you put **Cloud CDN** in front, this becomes load-bearing: sealed
chunks are digest-addressed and immutable (`max-age` long, `immutable`), but
`index.json`/`index.json.sig`/the hot head mutate and need `no-cache`. The clean
fix is to set per-object `Cache-Control` in `GcsStore` at write time (sealed vs.
hot/manifest) — a small follow-up, not required for the bucket-direct MVP.

## Operability

- **Logs** stream to Cloud Logging automatically (`gcloud run jobs executions list …`).
- **Alert on failure** — the real silent failure is `lastCoveredBlock` ceasing to
  advance. The deploy script wires a Cloud Monitoring alert on the Job's
  `completed_execution_count{result="failed"}` metric when you pass an email:
  ```sh
  PROJECT=my-proj BUCKET=pp-state ALERT_EMAIL=you@example.com ./deploy/cloud-run-job.sh
  ```
  It creates an email notification channel + alert policy (idempotent by display
  name). Omit `ALERT_EMAIL` to skip. Uses `gcloud alpha/beta monitoring` — run
  `gcloud components install alpha beta` if those surfaces aren't installed.
- **Manual / local runs** still go through `publish.sh` (which keeps its local
  `.locks/`); the Job and the local publisher write the same bucket safely because
  both scan only to the finalized tip.
