import type { Address, Hex } from "viem";

interface LogBase {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export type VaultLog = LogBase &
  (
    | { eventName: "Deposit"; args: { caller: Address; delegator: Address; assets: bigint } }
    | { eventName: "Withdraw"; args: { caller: Address; delegator: Address; assets: bigint } }
    | { eventName: "GovernorTransferred"; args: { previous: Address; next: Address } }
    | { eventName: "FeeUpdated"; args: { previousFeeBps: number; newFeeBps: number } }
  );

export interface Change<T> {
  previous: T;
  next: T;
  blockNumber: bigint;
  transactionHash: Hex;
}

export interface ActivityRow {
  key: string;
  kind: "deposit" | "withdraw";
  blockNumber: bigint;
  transactionHash: Hex;
  /** Deposit: who paid. Withdraw: whose vault balance paid. */
  caller: Address;
  /** Deposit: the credited delegator. Withdraw: who received the tokens. Null for a batch of several delegators. */
  counterparty: Address | null;
  /** Deposits grouped into this row (one transaction, one caller). */
  count: number;
  amount: bigint;
  fromReserve: boolean;
}

export interface Totals {
  count: number;
  atto: bigint;
}

export interface VaultSummary {
  /** Lower-case delegator address to vault balance. */
  balances: Map<string, bigint>;
  delegatorsNow: number;
  /** Distinct delegators the reserve Safe has credited, and the total. */
  reserveCredits: Totals;
  /** The reserve's first deposit, which funded the vault; null while it waits for funding. */
  funded: { blockNumber: bigint; transactionHash: Hex } | null;
  /** Reserve transactions that deposited into the vault (funding runs). */
  fundingRuns: number;
  /** Deposits from anyone but the reserve: number of deposits and total. */
  otherDeposits: Totals;
  /** Withdrawals: number and total. */
  withdrawals: Totals;
  governorChanges: Change<Address>[];
  feeChanges: Change<number>[];
  /** Newest first. */
  activity: ActivityRow[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function summarize(logs: VaultLog[], reserve: Address): VaultSummary {
  const ordered = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  const balances = new Map<string, bigint>();
  const credited = new Set<string>();
  let creditedAtto = 0n;
  let funded: VaultSummary["funded"] = null;
  const fundingTxs = new Set<string>();
  const otherDeposits: Totals = { count: 0, atto: 0n };
  const withdrawals: Totals = { count: 0, atto: 0n };
  const governorChanges: Change<Address>[] = [];
  const feeChanges: Change<number>[] = [];
  const rows: ActivityRow[] = [];
  const add = (who: string, delta: bigint) => balances.set(who, (balances.get(who) ?? 0n) + delta);

  for (const log of ordered) {
    const at = { blockNumber: log.blockNumber, transactionHash: log.transactionHash };
    switch (log.eventName) {
      case "GovernorTransferred":
        governorChanges.push({ previous: log.args.previous, next: log.args.next, ...at });
        break;
      case "FeeUpdated":
        feeChanges.push({ previous: log.args.previousFeeBps, next: log.args.newFeeBps, ...at });
        break;
      case "Deposit": {
        const { caller, delegator, assets } = log.args;
        add(delegator.toLowerCase(), assets);
        const fromReserve = same(caller, reserve);
        if (fromReserve) {
          credited.add(delegator.toLowerCase());
          creditedAtto += assets;
          funded ??= at;
          fundingTxs.add(log.transactionHash);
        } else {
          otherDeposits.count += 1;
          otherDeposits.atto += assets;
        }
        const last = rows[rows.length - 1];
        if (last && last.kind === "deposit" && last.transactionHash === log.transactionHash && same(last.caller, caller)) {
          last.count += 1;
          last.amount += assets;
          if (last.counterparty && !same(last.counterparty, delegator)) last.counterparty = null;
        } else {
          rows.push({ key: `${log.transactionHash}:${log.logIndex}`, kind: "deposit", ...at, caller, counterparty: delegator, count: 1, amount: assets, fromReserve });
        }
        break;
      }
      case "Withdraw": {
        const { caller, delegator, assets } = log.args;
        add(caller.toLowerCase(), -assets);
        withdrawals.count += 1;
        withdrawals.atto += assets;
        rows.push({ key: `${log.transactionHash}:${log.logIndex}`, kind: "withdraw", ...at, caller, counterparty: delegator, count: 1, amount: assets, fromReserve: false });
        break;
      }
    }
  }

  let delegatorsNow = 0;
  for (const balance of balances.values()) if (balance > 0n) delegatorsNow++;
  return {
    balances,
    delegatorsNow,
    reserveCredits: { count: credited.size, atto: creditedAtto },
    funded,
    fundingRuns: fundingTxs.size,
    otherDeposits,
    withdrawals,
    governorChanges,
    feeChanges,
    activity: rows.reverse(),
  };
}
