---
"@saga-sync/core": minor
"@saga-sync/producer": minor
"@saga-sync/client": minor
---

Streams can opt in to a `transactionHash` on every log record via `extraLogFields: ["transactionHash"]` in config. The declaration is recorded in the manifest entry (write-once), and the client now checks each log's field set against it. Streams without the declaration serialize byte-for-byte as before.
