import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { bridgeClaimsAbi } from "./abi";
import { BRIDGE, checkDeployments, NATIVE, type BridgeDeployments } from "./deployments";
import { claimLeaf, verifyProof } from "./merkle";
import { claimManyArgs, claimManyData, formatAmount, payableRows, rowsByContract, rowStatus } from "./model";
import { ProofError, rowsFromShard, shardPrefix, shardUrl, type BridgeRow } from "./proofs";
import { countedOn, describeBasis, formatMoment, remoteHoldersAt, snapshotBases } from "./snapshots";
import type { ContractState } from "./state";

/** harmony-migration bridge-claims/test/fixtures/claim-tree.json: a list TreeFixture.t.sol pays in full against the contract. */
const FIXTURE = JSON.parse(readFileSync(new URL("./testdata/claim-tree.json", import.meta.url), "utf8")) as {
  root: Hex;
  claim_count: number;
  funder: Address;
  wrapped_native: Address;
  tokens: Address[];
  address: Address;
  accounts: Address[];
  row_tokens: Address[];
  amounts: string[];
  leaves: Hex[];
  proofs: Hex[][];
};

const RUN = "bridge-allocations-test";

const HARMONY_POOL = [{ id: "pool", holders: "harmony", snapshot: "cutoff" }];

function fixtureDeployments(): BridgeDeployments {
  return checkDeployments({
    format: "bridge-deployments/v1",
    run: RUN,
    published_url: "https://example.test/run",
    published_index_sha256: "00".repeat(32),
    proof_prefix_digits: 4,
    snapshots: {
      blocks: {
        harmony: { cutoff: { number: 100, time: "2026-09-10T14:00:00Z" }, rollback: { number: 90, time: "2026-08-11T23:25:37Z" } },
        ethereum: { rollback: { number: 50, time: "2026-08-11T23:25:35Z" } },
      },
      orphaned_one_deliveries: { ethereum: 2 },
    },
    contracts: [
      {
        label: "ethereum",
        chain_id: 1,
        address: FIXTURE.address,
        funder: FIXTURE.funder,
        wrapped_native: FIXTURE.wrapped_native,
        root: FIXTURE.root,
        claim_count: FIXTURE.claim_count,
        list_sha256: "11".repeat(32),
        manifest_sha256: "22".repeat(32),
        runtime_keccak256: `0x${"33".repeat(32)}`,
        deploy_tx: `0x${"44".repeat(32)}`,
        deploy_block: 1,
        assets: [
          { token: NATIVE, symbol: "ETH", decimals: 18, pools: HARMONY_POOL },
          { token: FIXTURE.tokens[0], symbol: "T1", decimals: 6, pools: [{ id: "one", holders: "ethereum", snapshot: "rollback" }] },
          ...FIXTURE.tokens.slice(1).map((token, i) => ({ token, symbol: `T${i + 2}`, decimals: 6, pools: HARMONY_POOL })),
        ],
      },
      {
        label: "base",
        chain_id: 8453,
        address: "0x00000000000000000000000000000000000000b5",
        funder: FIXTURE.funder,
        wrapped_native: null,
        root: `0x${"55".repeat(32)}`,
        claim_count: 100,
        list_sha256: "66".repeat(32),
        manifest_sha256: "77".repeat(32),
        runtime_keccak256: `0x${"88".repeat(32)}`,
        deploy_tx: `0x${"99".repeat(32)}`,
        deploy_block: 1,
        assets: [{ token: FIXTURE.tokens[0], symbol: "T1", decimals: 6, pools: HARMONY_POOL }],
      },
    ],
  });
}

const fixtureRow = (i: number) => ({ index: i, token: FIXTURE.row_tokens[i], amount: FIXTURE.amounts[i], proof: FIXTURE.proofs[i] });

/** Fixture rows of one account, in the proof-file layout. */
function shardFor(account: Address, over: Partial<{ run: string; prefix: string; rows: unknown[]; label: string }> = {}) {
  const key = account.toLowerCase();
  const rows = over.rows ?? FIXTURE.accounts.flatMap((a, i) => (a.toLowerCase() === key ? [fixtureRow(i)] : []));
  return {
    format: "bridge-proofs/v1",
    run: over.run ?? RUN,
    prefix: over.prefix ?? key.slice(2, 6),
    accounts: { [key]: { [over.label ?? "ethereum"]: rows } },
  };
}

// account-0 has rows 0 and 29: a native row and a token row.
const PAYEE = getAddress(FIXTURE.accounts[0]);

describe("Merkle tree", () => {
  it("computes the contract's leaf for every fixture row", () => {
    FIXTURE.accounts.forEach((account, i) => {
      expect(claimLeaf(i, account, FIXTURE.row_tokens[i], BigInt(FIXTURE.amounts[i]))).toBe(FIXTURE.leaves[i]);
    });
  });

  it("accepts every fixture proof and rejects altered ones", () => {
    FIXTURE.leaves.forEach((leaf, i) => expect(verifyProof(FIXTURE.proofs[i], FIXTURE.root, leaf)).toBe(true));
    const altered = claimLeaf(0, FIXTURE.accounts[0], FIXTURE.row_tokens[0], BigInt(FIXTURE.amounts[0]) + 1n);
    expect(verifyProof(FIXTURE.proofs[0], FIXTURE.root, altered)).toBe(false);
    const proof = [...FIXTURE.proofs[1]];
    proof[0] = FIXTURE.leaves[5];
    expect(verifyProof(proof, FIXTURE.root, FIXTURE.leaves[1])).toBe(false);
    expect(verifyProof(FIXTURE.proofs[2], FIXTURE.root, FIXTURE.leaves[3])).toBe(false);
  });
});

describe("proof files", () => {
  const deployments = fixtureDeployments();

  it("names the file by the address's first hex digits", () => {
    expect(shardPrefix("0xAbCd000000000000000000000000000000000001", 4)).toBe("abcd");
    expect(shardUrl("0xAbCd000000000000000000000000000000000001", "https://x.test/p", 4)).toBe("https://x.test/p/abcd.json");
  });

  it("returns the account's rows with their assets once every proof leads to the root", () => {
    const rows = rowsFromShard(shardFor(PAYEE), PAYEE, deployments);
    expect(rows.map((r) => r.index)).toEqual([0, 29]);
    expect(rows.map((r) => r.asset.symbol)).toEqual(["ETH", "T1"]);
    expect(rows[0].amount).toBe(BigInt(FIXTURE.amounts[0]));
    expect(rows[0].account).toBe(PAYEE);
    expect(rows.every((r) => r.contract.label === "ethereum")).toBe(true);
  });

  it("returns nothing for an address the file does not list", () => {
    const other = getAddress(`0x${PAYEE.slice(2, 6)}${"0".repeat(36)}`);
    expect(rowsFromShard(shardFor(PAYEE), other, deployments)).toEqual([]);
  });

  it("refuses another run, another prefix, or an unknown format", () => {
    expect(() => rowsFromShard(shardFor(PAYEE, { run: "bridge-allocations-old" }), PAYEE, deployments)).toThrow(ProofError);
    expect(() => rowsFromShard(shardFor(PAYEE, { prefix: "ffff" }), PAYEE, deployments)).toThrow(/does not cover/);
    expect(() => rowsFromShard({ ...shardFor(PAYEE), format: "v0" }, PAYEE, deployments)).toThrow(/unknown format/);
    expect(() => rowsFromShard(null, PAYEE, deployments)).toThrow(ProofError);
  });

  it("refuses a row whose amount, token, index, or proof was changed", () => {
    const row = fixtureRow(0);
    const bad = (r: object) => () => rowsFromShard(shardFor(PAYEE, { rows: [r] }), PAYEE, deployments);
    expect(bad({ ...row, amount: (BigInt(row.amount) + 1n).toString() })).toThrow(/does not match/);
    expect(bad({ ...row, token: FIXTURE.tokens[2] })).toThrow(/does not match/);
    expect(bad({ ...row, token: "0x00000000000000000000000000000000000000ee" })).toThrow(/does not pay/);
    expect(bad({ ...row, index: 1 })).toThrow(/does not match/);
    expect(bad({ ...row, index: FIXTURE.claim_count })).toThrow(/row number/);
    expect(bad({ ...row, proof: [...row.proof.slice(1)] })).toThrow(/does not match/);
    expect(bad({ ...row, proof: [row.proof[0].slice(0, 64), ...row.proof.slice(1)] })).toThrow(/bad proof/);
    expect(bad({ ...row, amount: "01" })).toThrow(/bad amount/);
    expect(bad({ ...row, amount: "0" })).toThrow(/bad amount/);
  });

  it("refuses a repeated row and an unknown chain", () => {
    expect(() => rowsFromShard(shardFor(PAYEE, { rows: [fixtureRow(0), fixtureRow(0)] }), PAYEE, deployments)).toThrow(/row number/);
    expect(() => rowsFromShard(shardFor(PAYEE, { label: "polygon" }), PAYEE, deployments)).toThrow(/unknown chain/);
  });

  it("refuses a fixture row under a contract with another root", () => {
    expect(() => rowsFromShard(shardFor(PAYEE, { label: "base", rows: [fixtureRow(29)] }), PAYEE, deployments)).toThrow(/does not match/);
  });
});

describe("claims", () => {
  const deployments = fixtureDeployments();
  const rows: BridgeRow[] = rowsFromShard(shardFor(PAYEE), PAYEE, deployments);
  const [native, token] = rows;
  const state = (claimed: number[], available: [Address, bigint][]): ContractState => ({
    code: "ok",
    claimed: new Map(rows.map((r) => [r.index, claimed.includes(r.index)])),
    available: new Map(available.map(([t, v]) => [t.toLowerCase(), v])),
  });

  it("marks rows claimed, ready, or not open yet", () => {
    const s = state([0], [[token.asset.token, token.amount - 1n]]);
    expect(rowStatus(native, s)).toBe("claimed");
    expect(rowStatus(token, s)).toBe("waiting");
    expect(rowStatus(token, state([], [[token.asset.token, token.amount]]))).toBe("ready");
  });

  it("pays only unclaimed rows that what is available covers", () => {
    expect(payableRows(rows, state([], [[NATIVE, native.amount], [token.asset.token, token.amount]]))).toEqual(rows);
    expect(payableRows(rows, state([0], [[NATIVE, native.amount], [token.asset.token, token.amount]]))).toEqual([token]);
    expect(payableRows(rows, state([], [[token.asset.token, token.amount]]))).toEqual([token]);
    expect(payableRows(rows, state([], []))).toEqual([]);
  });

  it("counts every row of one asset against what is available", () => {
    const twice = [token, { ...token, index: 30 }];
    const s: ContractState = { code: "ok", claimed: new Map(), available: new Map([[token.asset.token.toLowerCase(), token.amount * 2n - 1n]]) };
    expect(payableRows(twice, s)).toEqual([token]);
  });

  it("encodes claimMany((uint256,address,address,uint256,bytes32[])[])", () => {
    const data = claimManyData(rows);
    expect(data.slice(0, 10)).toBe(keccak256(stringToBytes("claimMany((uint256,address,address,uint256,bytes32[])[])")).slice(0, 10));
    const decoded = decodeFunctionData({ abi: bridgeClaimsAbi, data });
    if (decoded.functionName !== "claimMany") throw new Error(`decoded ${decoded.functionName}`);
    expect(decoded.args).toEqual(claimManyArgs(rows));
    expect(decoded.args[0][0]).toEqual({ index: 0n, account: PAYEE, token: NATIVE, amount: native.amount, proof: native.proof });
  });

  it("groups rows by contract in the contract list's order", () => {
    const base = { ...token, contract: deployments.contracts[1] };
    expect(rowsByContract([base, native, token], deployments.contracts).map((g) => [g.contract.label, g.rows.length])).toEqual([
      ["ethereum", 2],
      ["base", 1],
    ]);
  });
});

describe("snapshots", () => {
  const deployments = fixtureDeployments();
  const rows = rowsFromShard(shardFor(PAYEE), PAYEE, deployments);

  it("groups a card's assets by the balances they start from", () => {
    expect(snapshotBases(rows, deployments).map((b) => [b.key, b.symbols])).toEqual([
      ["harmony:cutoff", ["ETH"]],
      ["ethereum:rollback", ["T1"]],
    ]);
  });

  it("names the balances, the moment, and every block", () => {
    const [harmony, one] = snapshotBases(rows, deployments).map((b) => describeBasis(b, deployments));
    expect(harmony).toEqual({
      what: "balances of the bridged token on Harmony",
      when: "at the cutoff",
      moment: "2026-09-10T14:00:00Z",
      blocks: "Harmony block 100 (2026-09-10 14:00:00 UTC)",
    });
    expect(one).toEqual({
      what: "balances of bridged T1 on Ethereum",
      when: "just before Harmony's rollback",
      moment: "2026-08-11T23:25:37Z",
      blocks: "Ethereum block 50 (2026-08-11 23:25:35 UTC)",
    });
    expect(formatMoment("2026-09-10T14:00:00Z")).toBe("10 September 2026, 14:00:00 UTC");
  });

  it("refuses an asset whose pool has no snapshot block", () => {
    const raw = JSON.parse(JSON.stringify(BRIDGE));
    const withPool = (pool: object) => ({ ...raw, contracts: [{ ...raw.contracts[3], assets: [{ ...raw.contracts[3].assets[0], pools: [pool] }] }] });
    expect(() => checkDeployments(withPool({ id: "x", holders: "polygon", snapshot: "cutoff" }))).toThrow(/no snapshot block/);
    expect(() => checkDeployments(withPool({ id: "x", holders: "base", snapshot: "state" }))).toThrow(/no snapshot block/);
    expect(() => checkDeployments({ ...raw, snapshots: { blocks: {}, orphaned_one_deliveries: {} } })).toThrow(/Harmony cutoff/);
  });
});

describe("amounts", () => {
  it("shows whole tokens, truncated to six decimals, and tiny amounts in full", () => {
    expect(formatAmount(1_234_567_890n, 6)).toBe("1,234.56789");
    expect(formatAmount(2n, 6)).toBe("0.000002");
    expect(formatAmount(1n, 18)).toBe("0.000000000000000001");
    expect(formatAmount(5n * 10n ** 18n, 18)).toBe("5");
    expect(formatAmount(123_456_789_012_345_678_901n, 18)).toBe("123.456789");
    expect(formatAmount(1_000_000_000_000n, 8)).toBe("10,000");
  });
});

describe("the published contract list", () => {
  // hiddenstate.xyz BridgeClaims audit, 29 October 2026: deployment commitments and expected runtime hashes.
  const AUDITED: [string, number, string, string, string][] = [
    ["ethereum", 1, "0xcc0407394a4d7eb59f894abbb9c005631183d49a", "0x964894effbc2fcaa5e87b9583ae6636959dd23fc1d4f2c3cd97db12d52f2523b", "0xed9957a85f2ff3d089aa2f5cd760ce4afbdb1743b3d66770caeddfda26bdd2d3"],
    ["bsc", 56, "0xaffa52187721fb4165071349bbd8c55c8d4356fc", "0x734794900e6066eac22a05de2031fa848fcf59ac6f8da10fac1de211bb9c81c4", "0xdb4763abb510a261308e26bd3a80e5fa1d32b6f9eabcb08e011858d4311ffc93"],
    ["arbitrum", 42161, "0x2cf2afd2b8be95f9ba5e8a6b021e7895d6729469", "0x39e92752231cebd64190cb5cf44e63ae75d38a1d42b63b85c3dbae48ae1037df", "0xccde05f46873541165bd89c0c6fd06c2cb00a13b5ddb3423a5acbc1f198ba0b9"],
    ["base", 8453, "0xa2bddf296a5a945f0bb92e71629a3e78f401adbb", "0x183e4b527d29eea5426e643c22ba0d21be7488d207db4cdfdd7278e68dcefe06", "0xa301f9ed766c50c19b603208641a535e15d534c023a11e127b031a4825f33db7"],
    ["linea", 59144, "0x8a5607026b92977c34aba988c5e22fc8b615ceaf", "0xa891a83a107cba0d21c67e9038061be945b2c62e3af6b7bd2299456bb7902772", "0x62b4fc5e0faff1ed42efd514607ac655ac09bdaadebdb29efda5719ff753301d"],
  ];

  it("names the audited contracts, roots, and runtime code", () => {
    expect(BRIDGE.run).toBe("bridge-allocations-20261029");
    expect(BRIDGE.published_index_sha256).toBe("718c44d94c5105b5e36603c226ce46f1231d6368d96b2ac59c573d8a72cc46fb");
    expect(BRIDGE.contracts.map((c) => [c.label, c.chain_id, c.address.toLowerCase(), c.root, c.runtime_keccak256])).toEqual(AUDITED);
  });

  it("counts bridged tokens on Harmony at the cutoff, and bridged ONE on BNB Chain and Ethereum before the rollback", () => {
    const b = BRIDGE.snapshots.blocks;
    expect([b.harmony?.cutoff, b.harmony?.rollback, b.bsc?.rollback, b.ethereum?.rollback]).toEqual([
      { number: 93_623_067, time: "2026-09-10T14:00:00Z" },
      { number: 92_730_034, time: "2026-08-11T23:25:37Z" },
      { number: 115_400_306, time: "2026-08-11T23:25:37Z" },
      { number: 25_735_028, time: "2026-08-11T23:25:35Z" },
    ]);
    const assets = BRIDGE.contracts.flatMap((c) => c.assets);
    const one = BRIDGE.contracts[0].assets.find((a) => a.symbol === "ONE")!;
    expect(one.pools.map((p) => `${p.holders}:${p.snapshot}`)).toEqual(["bsc:rollback", "ethereum:rollback"]);
    expect(assets.filter((a) => a !== one).every((a) => a.pools.every((p) => p.holders === "harmony" && p.snapshot === "cutoff"))).toBe(true);
    expect(countedOn("harmony")).toBe("bridged tokens at the cutoff");
    expect(countedOn("bsc")).toBe("bridged ONE before the rollback");
    expect(countedOn("arbitrum")).toBeNull();
    expect(remoteHoldersAt("rollback")).toEqual(["ethereum", "bsc"]);
    expect(BRIDGE.snapshots.orphaned_one_deliveries).toEqual({ bsc: 19, ethereum: 9 });
  });

  it("lists each asset once, the native coin only with a wrapped coin", () => {
    for (const c of BRIDGE.contracts) {
      const tokens = c.assets.map((a) => a.token);
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens.includes(NATIVE)).toBe(c.wrapped_native !== null);
    }
  });

  it("refuses a list that repeats a chain or names an unsupported one", () => {
    const raw = JSON.parse(JSON.stringify(BRIDGE));
    expect(() => checkDeployments({ ...raw, contracts: [raw.contracts[0], raw.contracts[0]] })).toThrow(/twice/);
    expect(() => checkDeployments({ ...raw, contracts: [{ ...raw.contracts[0], chain_id: 31337 }] })).toThrow(/Unsupported chain/);
    expect(() => checkDeployments({ ...raw, contracts: [{ ...raw.contracts[3], wrapped_native: raw.contracts[0].wrapped_native }] })).toThrow(
      /native coin/,
    );
  });
});
