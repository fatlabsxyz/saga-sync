# Deploying the scraper as a daily Cloud Run Job

The orchestrator resumes from the **published manifest's `lastCoveredBlock`** (see
`packages/producer/src/orchestrator/cli.ts`), so a run carries no durable local state — the GCS
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

1. **Authenticate the `gcloud` CLI** and pin the project (interactive, opens a
   browser). This is the *CLI* login — distinct from `gcloud auth
   application-default login`, which authenticates the SDK for local `publish.sh`
   runs and is not needed to provision the Job:
   ```sh
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

2. **Create the two secrets** (your values, never committed). The deploy script
   expects them named exactly `scraper-rpc` and `scraper-signing-key`. Use
   `printf` (no trailing newline) and `--data-file=-` (value via stdin, so it
   never hits shell history or `ps`):
   ```sh
   # a) Alchemy RPC URL
   printf '%s' "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY" \
     | gcloud secrets create scraper-rpc \
         --project "$PROJECT" --replication-policy=automatic --data-file=-

   # b) Ed25519 signing key — an IDENTITY: consumers pin its public key, so
   #    generate it ONCE and keep it stable forever (rotating breaks old-manifest
   #    verification). keygen prints MANIFEST_SIGNING_KEY (the secret) and
   #    PUBLIC_KEY (publish this; consumers pass it to --public-key).
   node packages/producer/dist/keygen.js
   printf '%s' "0x<the-MANIFEST_SIGNING_KEY-value>" \
     | gcloud secrets create scraper-signing-key \
         --project "$PROJECT" --replication-policy=automatic --data-file=-
   ```
   IAM is handled for you — the deploy script grants the job's service account
   `secretAccessor` on both and binds them as the `RPC` / `MANIFEST_SIGNING_KEY`
   env vars (`:latest`). To rotate the RPC later without touching the signing key,
   add a new version (the next run picks up `:latest` automatically):
   ```sh
   printf '%s' "https://eth-mainnet.g.alchemy.com/v2/NEW_KEY" \
     | gcloud secrets versions add scraper-rpc --project "$PROJECT" --data-file=-
   ```

3. **Deploy** everything else:
   ```sh
   PROJECT=my-proj BUCKET=pp-state ./deploy/cloud-run-job.sh
   ```
4. **Smoke test** a one-off run, then watch it land:
   ```sh
   gcloud run jobs execute scraper-daily --project "$PROJECT" --region us-central1
   gcloud storage ls -l gs://pp-state/**
   ```

## Serving + caching

The bucket is public-read and the canonical read endpoint is **Cloud CDN** in
front of it. Make the bucket public once:
```sh
gcloud storage buckets add-iam-policy-binding gs://pp-state \
  --member=allUsers --role=roles/storage.objectViewer
```
Caching is handled at write time: `GcsStore` sets per-object `Cache-Control` on
every `put` (`cacheControlFor` in `packages/producer/src/storage/gcs-store.ts`): sealed chunks are
digest-addressed and immutable → `public, max-age=31536000, immutable`;
`index.json`/`index.json.sig`/the hot head mutate every run → `public,
max-age=30`. These explicit headers override GCS's default 1-hour cache on
public objects, so a fresh manifest is visible within ~30s.

### Cloud CDN (`deploy/cdn.sh`)
Provision an external HTTP load balancer with a CDN-enabled backend bucket:
```sh
PROJECT=privacy-protocols BUCKET=pp-state ./deploy/cdn.sh
```
The script is idempotent (describe-then-create) and prints the canonical
endpoint `http://<lb-ip>/index.json` on completion. It sets cache mode
**`USE_ORIGIN_HEADERS`** so Cloud CDN honours the immutable/short-TTL split above
rather than imposing one blanket TTL. The load balancer adds no auth — it reads
the public bucket as its origin.

**No TLS / no domain by design.** Integrity is guaranteed by the signed manifest
+ content-hash-verified chunks (the client enforces both regardless of
transport), and the payload is public on-chain data — so plain HTTP on the
anycast IP is sufficient. To front it with a custom domain over HTTPS later, add
a Google-managed cert + `target-https-proxy` + a `:443` forwarding rule pointed
at the same reserved IP; nothing else changes.

Once provisioned, point the deploy/publish scripts at it by exporting
`CDN_BASE=http://<lb-ip>/` — `publish.sh` and `deploy/cloud-run-job.sh` then
print that as the consumer read URL. The client CLI takes the endpoint as its
`<manifest-url>` argument, so there's no hardcoded URL to change in code.

## Operability

- **Logs** stream to Cloud Logging automatically (`gcloud run jobs executions list …`).
- **Alerts** — pass an email and the deploy script wires two Cloud Monitoring
  policies (email notification channel + policies, all idempotent by display name):
  ```sh
  PROJECT=my-proj BUCKET=pp-state ALERT_EMAIL=you@example.com ./deploy/cloud-run-job.sh
  ```
  1. **`<job> job failed`** — fires on `completed_execution_count{result="failed"}`,
     i.e. an execution ran and exited non-zero.
  2. **`<job> no successful run`** — fires when no `result="succeeded"` execution
     lands within 25h (MQL `absent_for`). Catches the case the failure alert
     can't: the job ceasing to run at all (Scheduler misfire, trigger/job deleted,
     broken IAM) — no failed-execution metric is ever emitted, so only absence of
     *success* reveals it. 25h = the 24h daily cadence + 1h slack for scheduler
     jitter; it's also the ceiling — Monitoring rejects absence windows over 25h.

  Still **not** alerted: the job succeeds (exit 0) but `lastCoveredBlock` doesn't
  advance — a genuine silent stall. Covering that needs either a producer-side
  freshness check that fails the run (folding into alert #1) or a custom
  manifest-age metric + policy; deferred for now.

  Omit `ALERT_EMAIL` to skip both. Uses `gcloud alpha/beta monitoring` — run
  `gcloud components install alpha beta` if those surfaces aren't installed.
- **Manual / local runs** still go through `publish.sh` (which keeps its local
  `.locks/`); the Job and the local publisher write the same bucket safely because
  both scan only to the finalized tip.
