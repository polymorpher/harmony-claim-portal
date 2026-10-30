import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestClient, erc20Abi, getAddress, http, parseAbi, parseEther, publicActions, walletActions, type Address, type PublicClient } from "viem";
import { chainById } from "../chains";
import { bridgeClaimsAbi } from "./abi";
import { awaitClaim, ClaimError } from "./claim";
import { contractByLabel, NATIVE } from "./deployments";
import { claimManyArgs, claimManyData, payableRows } from "./model";
import { rowsFromShard, type BridgeRow } from "./proofs";
import { readContractState } from "./state";

// Claims one payee's rows on an anvil fork of a claim chain with this page's code, after approving
// them from the custody Safe as its approval batch would. Skipped unless the fork and the proof files
// are given:
//   anvil --fork-url "$BASE_RPC" --port 8545
//   BRIDGE_FORK_LABEL=base BRIDGE_FORK_RPC_URL=http://127.0.0.1:8545 \
//     BRIDGE_FORK_PROOFS=$PWD/injector/out/bridge-proofs/<run>/proofs pnpm --filter @hcp/frontend test
// BRIDGE_FORK_PAYEE picks the payee; otherwise the first one with a row on that chain.
const LABEL = process.env.BRIDGE_FORK_LABEL;
const RPC = process.env.BRIDGE_FORK_RPC_URL;
const PROOFS = process.env.BRIDGE_FORK_PROOFS;
// Anvil's first funded development account.
const SENDER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const wrappedAbi = parseAbi(["function deposit() payable"]);

function payeeRows(label: string, dir: string, wanted?: string): BridgeRow[] {
  const contract = contractByLabel(label)!;
  const files = wanted ? [`${wanted.slice(2, 6).toLowerCase()}.json`] : readdirSync(dir).filter((f) => /^[0-9a-f]+\.json$/.test(f)).sort();
  for (const file of files) {
    const shard = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const [account, chains] of Object.entries(shard.accounts as Record<string, Record<string, unknown[]>>)) {
      if (wanted && account !== wanted.toLowerCase()) continue;
      if (!chains[contract.label]) continue;
      return rowsFromShard(shard, getAddress(account)).filter((r) => r.contract.label === contract.label);
    }
  }
  throw new Error(`no payee with a ${label} row in ${dir}`);
}

describe.skipIf(!LABEL || !RPC || !PROOFS)("claims on a fork", () => {
  it("pays every row of a payee once the custody Safe approves, only once, and not when cancelled", { timeout: 180_000 }, async () => {
    const contract = contractByLabel(LABEL!)!;
    const client = createTestClient({ chain: chainById(contract.chain_id), mode: "anvil", transport: http(RPC) })
      .extend(publicActions)
      .extend(walletActions);
    const reader = client as unknown as PublicClient;
    const rows = payeeRows(contract.label, PROOFS!, process.env.BRIDGE_FORK_PAYEE);
    const payee = rows[0].account;

    const before = await readContractState(contract, rows, reader);
    expect(before.code).toBe("ok");
    expect(rows.every((r) => before.claimed.get(r.index) === false)).toBe(true);

    // The custody Safe wraps the native total and approves exactly each asset's rows.
    const safe = contract.funder;
    await client.impersonateAccount({ address: safe });
    await client.setBalance({ address: safe, value: parseEther("1000") });
    const native = rows.filter((r) => r.asset.token === NATIVE).reduce((n, r) => n + r.amount, 0n);
    if (native > 0n) {
      await client.setBalance({ address: safe, value: parseEther("1000") + native });
      await client.writeContract({ account: safe, address: contract.wrapped_native!, abi: wrappedAbi, functionName: "deposit", value: native, chain: null });
    }
    for (const row of rows) {
      const token = row.asset.token === NATIVE ? contract.wrapped_native! : row.asset.token;
      await client.writeContract({ account: safe, address: token, abi: erc20Abi, functionName: "approve", args: [contract.address, row.amount], chain: null });
    }
    await client.stopImpersonatingAccount({ address: safe });

    const opened = await readContractState(contract, rows, reader);
    expect(payableRows(rows, opened)).toEqual(rows);

    // The wallet cancels the claim before it is mined: viem returns the cancellation's successful
    // receipt, which must not count as a claim.
    let cancelled: unknown;
    await client.setAutomine(false);
    try {
      const sent = await client.sendTransaction({ account: SENDER, to: contract.address, data: claimManyData(rows), chain: null });
      const pending = await client.getTransaction({ hash: sent });
      const following = awaitClaim(reader, contract, rows, sent, 60_000).catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const tip = pending.maxPriorityFeePerGas! * 2n + 1n;
      const cap = pending.maxFeePerGas! * 2n;
      await client.sendTransaction({
        account: SENDER,
        to: SENDER,
        value: 0n,
        nonce: pending.nonce,
        maxFeePerGas: cap > tip ? cap : tip,
        maxPriorityFeePerGas: tip,
        chain: null,
      });
      await client.mine({ blocks: 1 });
      cancelled = await following;
    } finally {
      await client.setAutomine(true);
    }
    expect(cancelled).toBeInstanceOf(ClaimError);
    expect((cancelled as ClaimError).message).toMatch(/cancelled in the wallet/);
    expect((await readContractState(contract, rows, reader)).claimed).toEqual(opened.claimed);

    const balances = () =>
      Promise.all(
        rows.map(async (r) =>
          r.asset.token === NATIVE
            ? (await client.getBalance({ address: payee })) +
              (await client.readContract({ address: contract.wrapped_native!, abi: erc20Abi, functionName: "balanceOf", args: [payee] }))
            : client.readContract({ address: r.asset.token, abi: erc20Abi, functionName: "balanceOf", args: [payee] }),
        ),
      );
    const start = await balances();
    const { result } = await client.simulateContract({ account: SENDER, address: contract.address, abi: bridgeClaimsAbi, functionName: "claimMany", args: claimManyArgs(rows) });
    expect(result).toBe(BigInt(rows.length));
    const hash = await client.sendTransaction({ account: SENDER, to: contract.address, data: claimManyData(rows), chain: null });
    expect(await awaitClaim(reader, contract, rows, hash)).toEqual({ hash, paid: rows.length });
    const end = await balances();
    rows.forEach((r, i) => expect(end[i] - start[i]).toBe(r.amount));

    const paid = await readContractState(contract, rows, reader);
    expect(rows.every((r) => paid.claimed.get(r.index))).toBe(true);
    expect(payableRows(rows, paid)).toEqual([]);
    const again = await client.simulateContract({ account: SENDER, address: contract.address, abi: bridgeClaimsAbi, functionName: "claimMany", args: claimManyArgs(rows) });
    expect(again.result).toBe(0n);
  });
});
