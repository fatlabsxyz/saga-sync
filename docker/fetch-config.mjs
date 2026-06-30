// Download the orchestrator config from GCS to a local path, using the same
// @google-cloud/storage + Application Default Credentials the orchestrator uses
// for its gs:// output. Keeps the config out of the image so the protocol set
// can change without a rebuild.
//
// Usage: node fetch-config.mjs <gs://bucket/object> <local-dest>
import { Storage } from "@google-cloud/storage";

const [uri, dest] = process.argv.slice(2);
if (!uri || !dest) {
  console.error("usage: fetch-config.mjs <gs://bucket/object> <dest>");
  process.exit(2);
}

const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
if (!m) {
  console.error(`fetch-config: not a gs:// uri: ${uri}`);
  process.exit(2);
}
const [, bucket, object] = m;

try {
  await new Storage().bucket(bucket).file(object).download({ destination: dest });
  console.error(`[entrypoint] config fetched: ${uri} -> ${dest}`);
} catch (e) {
  console.error(`[entrypoint] config fetch failed: ${e.message}`);
  process.exit(1);
}
