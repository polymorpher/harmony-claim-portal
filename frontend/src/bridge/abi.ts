/** The parts of BridgeClaims (harmony-migration `bridge-claims/src/BridgeClaims.sol`) the page calls. */
export const bridgeClaimsAbi = [
  {
    type: "function",
    name: "claimMany",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "claims",
        type: "tuple[]",
        components: [
          { name: "index", type: "uint256" },
          { name: "account", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "proof", type: "bytes32[]" },
        ],
      },
    ],
    outputs: [{ name: "paid", type: "uint256" }],
  },
  { type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "available", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "error", name: "AlreadyClaimed", inputs: [{ name: "index", type: "uint256" }] },
  {
    type: "error",
    name: "IndexOutOfRange",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "claimCount", type: "uint256" },
    ],
  },
  { type: "error", name: "InvalidProof", inputs: [{ name: "index", type: "uint256" }] },
  { type: "error", name: "NativeNotSupported", inputs: [] },
  {
    type: "error",
    name: "TransferFailed",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
] as const;
