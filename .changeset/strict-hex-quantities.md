---
"@saga-sync/client": minor
---

`verifyChunkEvents` now rejects a record whose `blockNumber`, `logIndex`, `transactionIndex` or `opIndex` is not the minimal lowercase `0x`-hex SPEC §3.3 requires, or whose in-block index is past `Number.MAX_SAFE_INTEGER`. `BigInt` used to accept decimal strings, JSON numbers and empty strings, so such records passed the range and ordering checks and reached the consumer; non-hex text threw a bare `SyntaxError` instead of `CanonicalFormError`. Every record published today already conforms.
