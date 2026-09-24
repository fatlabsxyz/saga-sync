import type { AbiParameter } from "viem";

// The RAILGUN structs, from contracts/logic/Globals.sol. Needed in full because
// `boundParamsHash` is `keccak256(abi.encode(boundParams)) % SNARK_SCALAR_FIELD`
// (Verifier.sol) — reproducing it requires encoding the struct exactly as Solidity
// does, so every field and its width has to be right.

export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// enum UnshieldType { NONE, NORMAL, REDIRECT }
export const UNSHIELD_NONE = 0;

const commitmentCiphertext: AbiParameter = {
  name: "commitmentCiphertext",
  type: "tuple[]",
  components: [
    { name: "ciphertext", type: "bytes32[4]" },
    { name: "blindedSenderViewingKey", type: "bytes32" },
    { name: "blindedReceiverViewingKey", type: "bytes32" },
    { name: "annotationData", type: "bytes" },
    { name: "memo", type: "bytes" },
  ],
};

// Exported on its own: hashBoundParams encodes THIS tuple and nothing else.
export const boundParamsAbi: AbiParameter = {
  name: "boundParams",
  type: "tuple",
  components: [
    { name: "treeNumber", type: "uint16" },
    { name: "minGasPrice", type: "uint72" },
    { name: "unshield", type: "uint8" },
    { name: "chainID", type: "uint64" },
    { name: "adaptContract", type: "address" },
    { name: "adaptParams", type: "bytes32" },
    commitmentCiphertext,
  ],
};

const transactionsAbi: AbiParameter = {
  name: "_transactions",
  type: "tuple[]",
  components: [
    {
      name: "proof",
      type: "tuple",
      components: [
        { name: "a", type: "tuple", components: [
          { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] },
        { name: "b", type: "tuple", components: [
          { name: "x", type: "uint256[2]" }, { name: "y", type: "uint256[2]" }] },
        { name: "c", type: "tuple", components: [
          { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] },
      ],
    },
    { name: "merkleRoot", type: "bytes32" },
    { name: "nullifiers", type: "bytes32[]" },
    { name: "commitments", type: "bytes32[]" },
    boundParamsAbi,
    {
      name: "unshieldPreimage",
      type: "tuple",
      components: [
        { name: "npk", type: "bytes32" },
        { name: "token", type: "tuple", components: [
          { name: "tokenType", type: "uint8" },
          { name: "tokenAddress", type: "address" },
          { name: "tokenSubID", type: "uint256" },
        ]},
        { name: "value", type: "uint120" },
      ],
    },
  ],
};

// The two entry points that carry a Transaction[]. RelayAdapt's `relay` takes the
// IDENTICAL array as its first argument and adds an ActionData tail, so one
// decoder serves both — the wrapper only changes where the array sits.
//
// `relay`'s trailing parameter is decoded but unused; it has to be present or the
// decode fails.
export const TRANSACT_ABI = [
  {
    type: "function",
    name: "transact",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [transactionsAbi],
  },
  {
    type: "function",
    name: "relay",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      transactionsAbi,
      {
        name: "_actionData",
        type: "tuple",
        components: [
          { name: "random", type: "bytes31" },
          { name: "requireSuccess", type: "bool" },
          { name: "minGasLimit", type: "uint256" },
          { name: "calls", type: "tuple[]", components: [
            { name: "to", type: "address" },
            { name: "data", type: "bytes" },
            { name: "value", type: "uint256" },
          ]},
        ],
      },
    ],
  },
] as const;

// --- V1 (pre-November-2022) --------------------------------------------------
//
// The proxy was upgraded in place and `transact` changed shape. V1's BoundParams
// has no minGasPrice and no chainID, its ciphertext is uint256-based, and its
// Transaction carries a trailing `overrideOutput` address. Nullifiers and
// commitments are uint256[] rather than bytes32[] — the same values, a different
// ABI type.
//
// hashBoundParams is the SAME formula (keccak of the abi-encoded struct, reduced
// mod the scalar field) — verified against the earliest V1 operation on chain.

export const boundParamsAbiV1: AbiParameter = {
  name: "boundParams",
  type: "tuple",
  components: [
    { name: "treeNumber", type: "uint16" },
    { name: "withdraw", type: "uint8" }, // V2 renamed this `unshield`
    { name: "adaptContract", type: "address" },
    { name: "adaptParams", type: "bytes32" },
    { name: "commitmentCiphertext", type: "tuple[]", components: [
      { name: "ciphertext", type: "uint256[4]" },
      { name: "ephemeralKeys", type: "uint256[2]" },
      { name: "memo", type: "uint256[]" },
    ]},
  ],
};

const transactionsAbiV1: AbiParameter = {
  name: "_transactions",
  type: "tuple[]",
  components: [
    {
      name: "proof",
      type: "tuple",
      components: [
        { name: "a", type: "tuple", components: [
          { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] },
        { name: "b", type: "tuple", components: [
          { name: "x", type: "uint256[2]" }, { name: "y", type: "uint256[2]" }] },
        { name: "c", type: "tuple", components: [
          { name: "x", type: "uint256" }, { name: "y", type: "uint256" }] },
      ],
    },
    { name: "merkleRoot", type: "uint256" },
    { name: "nullifiers", type: "uint256[]" },
    { name: "commitments", type: "uint256[]" },
    boundParamsAbiV1,
    {
      name: "withdrawPreimage",
      type: "tuple",
      components: [
        { name: "npk", type: "uint256" },
        { name: "token", type: "tuple", components: [
          { name: "tokenType", type: "uint8" },
          { name: "tokenAddress", type: "address" },
          { name: "tokenSubID", type: "uint256" },
        ]},
        { name: "value", type: "uint120" },
      ],
    },
    { name: "overrideOutput", type: "address" },
  ],
};

export const TRANSACT_ABI_V1 = [
  {
    type: "function",
    name: "transact",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [transactionsAbiV1],
  },
] as const;

// Selector -> which ABI decodes it. Anything else reaching the contract is
// resolved by tracing (see CalldataSource); only a trace that also fails is fatal.
export type EntryPoint = { era: "v1" | "v2"; fn: "transact" | "relay" };

export const KNOWN_SELECTORS: Record<string, EntryPoint> = {
  "0xd8ae136a": { era: "v2", fn: "transact" }, // RailgunSmartWallet.transact(Transaction[])
  "0x28223a77": { era: "v2", fn: "relay" }, //    RelayAdapt.relay(Transaction[], ActionData)
  "0x4489999c": { era: "v1", fn: "transact" }, // pre-V2 transact(Transaction[])
};
