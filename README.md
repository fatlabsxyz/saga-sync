# privacy-protocol-state-distribution (WIP)

This project aims to solve state distribution for privacy protocols in the least opinionated way. We provide a spec and a reasonable implementation, but other implementations are welcomed.

## Index file
```json
{
    "availableStates": {
        "${protocol}-${chainId}-${protocolInstanceId}": [{
            "fromBlock": "0x0",
            "toBlock": "0x123434235",
            "file": "${protocol}-${chainId}-${protocolInstanceIdentifier}-[${fromBlock},${toBlock})).json",
            "size": "0xBytes",
            "digest": {
                "type": "md5",
                "data": "0x..."
            }
        }]
    }
}
```

## protocol state chunk
```json
{
    "events": {
        "${contractAddress}": {
            "${eventTopic}": [{
                "data": "${gibberish}",
                "blockNumber": "0x1",
                "logIndex": "0x1"
            }]
        }
    }
}
```

## scrapper config
```json
{
    "protocols": {
        "${protocol}-${chainId}-${protocolInstanceId}": {
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
