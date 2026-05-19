# privacy-protocol-state-distribution (WIP)

This project aims to solve state distribution for privacy protocols in the least opinionated way. We provide a spec and a reasonable implementation, but other implementations are welcomed.

## Index file
```json
{
    "availableStates": {
        "${protocol}-${chainId}-${protocolInstanceId}": [{
            "fromBlock": "0x0",
            "toBlock": "0x123434235",
            "file": "${protocol}-${chainId}-${protocolInstanceIdentifier}-[${fromBlock},${toBlock}).jsonl.gz",
            "size": "0xBytes",
            "digest": {
                "type": "blake3",
                "data": "0x..."
            }
        }]
    },
    "hotHeads": {
        "${protocol}-${chainId}-${protocolInstanceId}": {
            "fromBlock": "0x123434235",
            "toBlock": "0x123434500",
            "file": "${protocol}-${chainId}-${protocolInstanceIdentifier}-[${fromBlock},${toBlock}).hot.jsonl.gz",
            "size": "0xBytes",
            "digest": {
                "type": "blake3",
                "data": "0x..."
            }
        }
    }
}
```

`availableStates[id]` holds **immutable** chunks (cache forever; verified by their blake3 digest). `hotHeads[id]` holds at most one **mutable** entry per protocol — the trailing partial that has not yet reached the chunk size limit. Each `hotHeads[id]` rewrite produces a new file under a new range-derived URL (so any given URL is itself immutable and CDN-cacheable); only the manifest pointer changes. The hotHeads field may be absent entirely on a manifest with no in-progress tails.

Together the sealed chunks and the hot head partition `[firstSealed.fromBlock, hotHead.toBlock)` with no gaps — each entry's `toBlock` equals the next entry's `fromBlock`.

## protocol state chunk

Each chunk file (sealed or hot) is JSONL + gzip — one normalized event per line:

```
{"contractAddress":"0x...","eventTopic":"0x...","topics":["0x...","0x..."],"data":"0x...","blockNumber":"0x1","logIndex":"0x1","transactionHash":"0x...","blockHash":"0x..."}
{"contractAddress":"0x...","eventTopic":"0x...","topics":["0x...","0x..."],"data":"0x...","blockNumber":"0x2","logIndex":"0x0","transactionHash":"0x...","blockHash":"0x..."}
```

The `digest.data` recorded in the manifest is the blake3 of the **uncompressed** JSONL bytes — verifiable by `gunzip <file> | blake3`. `contractAddress` and `eventTopic` are stored on every event rather than as outer grouping keys, so each line is self-describing.

## scrapper config
```json
{
    "protocols": {
        "${protocol}-${chainId}-${protocolInstanceId}": {
            "chainId": "0x...",
            "fromBlock": "0x...",
            "cronString": "* * * * *",
            "chunkSettings": {
                "criteria": "block|size",
                "criteriaSettings": "maxSizeBytes|maxBlockRange"
            },
            "storeSettings": {
                "fileNameTemplate": "${protocol}-${chainId}-${protocolInstanceIdentifier}-[${fromBlock},${toBlock})).json",
                "protocol": "ftp|s3|http|disk",
                "protocolSettings": {}
            },
            "events": [{
                "contractAddress": "0x...",
                "eventTopic": "0x...",
                "filter?": ["0x..."]
            }]
        }
    }
}
```
