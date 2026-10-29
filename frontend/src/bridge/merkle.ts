import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

const ROW = [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }] as const;

/** BridgeClaims.leaf: keccak256(keccak256(abi.encode(index, account, token, amount))). */
export function claimLeaf(index: number | bigint, account: Address, token: Address, amount: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters(ROW, [BigInt(index), account, token, amount])));
}

/** keccak256 of the pair, smaller value first. */
export function hashPair(a: Hex, b: Hex): Hex {
  const x = a.toLowerCase() as Hex;
  const y = b.toLowerCase() as Hex;
  return keccak256(x < y ? concat([x, y]) : concat([y, x]));
}

/** BridgeClaims._verify: hash the leaf with each sibling in turn and compare with the root. */
export function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let node = leaf;
  for (const sibling of proof) node = hashPair(node, sibling);
  return node.toLowerCase() === root.toLowerCase();
}
