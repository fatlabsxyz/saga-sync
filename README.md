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
                "topics": ["0x...", "0x..."],
                "data": "${gibberish}",
                "blockNumber": "0x1",
                "logIndex": "0x1",
                "transactionHash": "0x...",
                "blockHash": "0x..."
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
