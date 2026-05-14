# privacy-protocol-state-distribution (WIP)

This project aims to solve state distribution for privacy protocols in the least opinionated way. We provide a spec and a reasonable implementation, but other implementations are welcomed.

## Index file
```json
{
  "specVersion": "1.0.0",

  "generatedAt": "...",

  "protocols": {
    "tornado-1-main": {

      "chainId": 1,

      "latestFinalizedBlock": "0x",

      "chunks": [
        {
          "fromBlock": "0x",
          "toBlock": "0x",

          "uri": "...",

          "digest": {
            "type": "blake3",
            "value": "0x..."
          },

          "sizeCompressed": 0,
          "sizeUncompressed": 0
        }
      ]
    }
  }
}
```

## protocol state chunk (normalized logs)
```json
{
  "chainId": 1,
  "chainType": "evm",

  "blockNumber": "0x1234",
  "blockHash": "0xabcd",

  "transactionHash": "0x5678",
  "transactionIndex": "0x2",

  "logIndex": "0x5",

  "address": "0xcontract",

  "topics": [
    "0xtopic0",
    "0xtopic1"
  ],

  "data": "0xdeadbeef",

  "removed": false
}
```
Sort by:
1. blockNumber ASC
2. transactionIndex ASC
3. logIndex ASC

## scrapper config
```json
{
  "version": "1.0.0",

  "jobs": {
    "tornado-eth-mainnet": {

      "chain": {
        "type": "evm",

        "chainId": 1,

        "rpc": {
          "urls": [
            "https://rpc-1",
            "https://rpc-2"
          ],

          "retryPolicy": {
            "maxRetries": 5,
            "backoffMs": 1000
          }
        },

        "finality": {
          "confirmationDepth": 64
        }
      },

      "sync": {
        "mode": "batch",

        "schedule": {
          "type": "cron",

          "expression": "0 */6 * * *"
        },

        "startBlock": 0,

        "batchSize": 5000,

        "checkpointing": {
          "enabled": true,

          "storage": {
            "driver": "disk",

            "settings": {
              "path": "./checkpoints"
            }
          },

          "saveStrategy": {
            "type": "onChunkFinalize"
          }
        },

        "parallelism": {
          "historicalWorkers": 8,

          "strategy": "block-range"
        }
      },

      "events": [
        {
          "address": "0x1111111111111111111111111111111111111111",

          "topics": [
            "0xtopic0"
          ]
        }
      ],

      "chunking": {

        "maxUncompressedBytes": 134217728,

        "encoding": "jsonl",

        "compression": "zstd",

        "hash": {
          "algorithm": "blake3",

          "target": "uncompressed-canonical-bytes"
        }
      },

      "storage": {
        "driver": "s3",

        "pathTemplate":
          "chunks/{protocol}/{chainId}/{fromBlock}-{toBlock}.jsonl.zst",

        "settings": {
          "bucket": "privacy-state",

          "region": "us-east-1"
        }
      },

      "manifest": {
        "path":
          "manifests/{protocol}/{chainId}/index.json",

        "integrity": {
          "hashAlgorithm": "blake3"
        },

        "signing": {
          "enabled": true,

          "algorithm": "ed25519"
        }
      }
    }
  }
}
```
