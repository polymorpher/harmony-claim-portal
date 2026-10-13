import { createPublicClient, erc20Abi, fallback, http, type Address, type Chain, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { depositEvent, vaultAbi, vaultEvents } from "./abi";
import type { VaultLog } from "./activity";
import type { Catalog } from "./catalog";

// Public endpoints that answer eth_getLogs from the browser. Tenderly's gateway serves full history over
// wide ranges; dRPC's free tier caps a request at 10,000 blocks and publicnode only serves recent blocks,
// so they are fallbacks for the chunked reads below.
const DEFAULT_RPC_URLS: Record<number, string[]> = {
  [mainnet.id]: ["https://mainnet.gateway.tenderly.co", "https://eth.drpc.org", "https://ethereum-rpc.publicnode.com"],
  [sepolia.id]: [
    "https://sepolia.gateway.tenderly.co",
    "https://sepolia.drpc.org",
    "https://ethereum-sepolia-rpc.publicnode.com",
  ],
};

const EXPLORERS: Record<number, string> = {
  [mainnet.id]: "https://etherscan.io",
  [sepolia.id]: "https://sepolia.etherscan.io",
};

export function chainById(chainId: number): Chain {
  if (chainId === mainnet.id) return mainnet;
  if (chainId === sepolia.id) return sepolia;
  throw new Error(`Unsupported chain ${chainId}`);
}

export function explorer(chainId: number): string {
  return EXPLORERS[chainId] ?? EXPLORERS[mainnet.id];
}

function rpcUrls(chainId: number): string[] {
  const configured = (import.meta.env.VITE_ETH_RPC_URLS ?? "")
    .split(",")
    .map((u: string) => u.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_RPC_URLS[chainId];
}

const clients = new Map<number, PublicClient>();

export function publicClient(chainId: number): PublicClient {
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({
      chain: chainById(chainId),
      transport: fallback(rpcUrls(chainId).map((url) => http(url, { retryCount: 1, timeout: 20_000 }))),
    });
    clients.set(chainId, client);
  }
  return client;
}

export interface VaultState {
  deployed: boolean;
  governor: Address | null;
  feeBps: number | null;
  /** Token balance the vault holds. */
  size: bigint | null;
  /** The account's balance in the vault, when an account was given. */
  held: bigint | null;
}

const MULTICALL_BATCH_BYTES = 32_768;

/** Reads every catalog vault in a few eth_calls. A vault without code fails its governor() read. */
export async function readVaultStates(client: PublicClient, catalog: Catalog, account?: Address): Promise<Map<Address, VaultState>> {
  const perVault = account ? 4 : 3;
  const contracts = catalog.vaults.flatMap((v) => [
    { address: v.vault, abi: vaultAbi, functionName: "governor" } as const,
    { address: v.vault, abi: vaultAbi, functionName: "feeBps" } as const,
    { address: catalog.token, abi: erc20Abi, functionName: "balanceOf", args: [v.vault] } as const,
    ...(account ? [{ address: v.vault, abi: vaultAbi, functionName: "balanceOf", args: [account] } as const] : []),
  ]);
  const results = await client.multicall({ contracts, allowFailure: true, batchSize: MULTICALL_BATCH_BYTES });
  const out = new Map<Address, VaultState>();
  catalog.vaults.forEach((v, i) => {
    const [governor, fee, size, held] = results.slice(i * perVault, (i + 1) * perVault);
    const deployed = governor.status === "success";
    out.set(v.vault, {
      deployed,
      governor: deployed ? (governor.result as Address) : null,
      feeBps: deployed && fee.status === "success" ? Number(fee.result) : null,
      size: size.status === "success" ? (size.result as bigint) : null,
      held: deployed && held?.status === "success" ? (held.result as bigint) : null,
    });
  });
  return out;
}

export interface VaultDetail extends VaultState {
  asset: Address | null;
  /** The account's token balance, allowance to the vault, and balance in the vault. */
  wallet: { tokens: bigint; allowance: bigint; held: bigint } | null;
}

export async function readVaultDetail(client: PublicClient, catalog: Catalog, vault: Address, account?: Address): Promise<VaultDetail> {
  const [[governor, fee, asset, size], mine] = await Promise.all([
    client.multicall({
      contracts: [
        { address: vault, abi: vaultAbi, functionName: "governor" },
        { address: vault, abi: vaultAbi, functionName: "feeBps" },
        { address: vault, abi: vaultAbi, functionName: "asset" },
        { address: catalog.token, abi: erc20Abi, functionName: "balanceOf", args: [vault] },
      ],
      allowFailure: true,
    }),
    account
      ? client.multicall({
          contracts: [
            { address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] },
            { address: catalog.token, abi: erc20Abi, functionName: "balanceOf", args: [account] },
            { address: catalog.token, abi: erc20Abi, functionName: "allowance", args: [account, vault] },
          ],
          allowFailure: true,
        })
      : null,
  ]);
  const deployed = governor.status === "success";
  const held = mine?.[0].status === "success" ? mine[0].result : null;
  return {
    deployed,
    governor: governor.result ?? null,
    feeBps: fee.result ?? null,
    asset: asset.result ?? null,
    size: size.result ?? null,
    held,
    wallet:
      mine && deployed
        ? { held: held ?? 0n, tokens: mine[1].result ?? 0n, allowance: mine[2].result ?? 0n }
        : null,
  };
}

const MIN_LOG_SPAN = 2_000n;

async function logsBetween(client: PublicClient, vault: Address, from: bigint, to: bigint): Promise<VaultLog[]> {
  try {
    const logs = await client.getLogs({ address: vault, events: vaultEvents, fromBlock: from, toBlock: to, strict: true });
    return logs as unknown as VaultLog[];
  } catch (err) {
    // Endpoints cap the block range differently; halve until one answers.
    if (to - from < MIN_LOG_SPAN) throw err;
    const mid = from + (to - from) / 2n;
    return [...(await logsBetween(client, vault, from, mid)), ...(await logsBetween(client, vault, mid + 1n, to))];
  }
}

async function reserveDepositsBetween(
  client: PublicClient,
  vaults: Address[],
  reserve: Address,
  from: bigint,
  to: bigint,
): Promise<{ address: Address; args: { assets: bigint } }[]> {
  try {
    return await client.getLogs({ address: vaults, event: depositEvent, args: { caller: reserve }, fromBlock: from, toBlock: to, strict: true });
  } catch (err) {
    if (to - from < MIN_LOG_SPAN) throw err;
    const mid = from + (to - from) / 2n;
    return [
      ...(await reserveDepositsBetween(client, vaults, reserve, from, mid)),
      ...(await reserveDepositsBetween(client, vaults, reserve, mid + 1n, to)),
    ];
  }
}

/** How much the reserve has deposited into each vault (lower-case address); vaults it has not funded are absent. */
export async function readFunding(client: PublicClient, vaults: Address[], reserve: Address, fromBlock: number): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (vaults.length === 0) return out;
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  for (const log of await reserveDepositsBetween(client, vaults, reserve, BigInt(fromBlock), toBlock)) {
    const vault = log.address.toLowerCase();
    out.set(vault, (out.get(vault) ?? 0n) + log.args.assets);
  }
  return out;
}

/** Every event the vault emitted since `fromBlock`, oldest first, and the block read up to. */
export async function readVaultLogs(client: PublicClient, vault: Address, fromBlock: number): Promise<{ logs: VaultLog[]; toBlock: bigint }> {
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  const logs = await logsBetween(client, vault, BigInt(fromBlock), toBlock);
  return { logs, toBlock };
}

/** Block timestamps (seconds) for the given blocks, a few requests at a time. */
export async function readBlockTimes(client: PublicClient, blocks: bigint[]): Promise<Map<bigint, number>> {
  const unique = [...new Set(blocks)];
  const out = new Map<bigint, number>();
  for (let i = 0; i < unique.length; i += 6) {
    const batch = unique.slice(i, i + 6);
    const got = await Promise.all(batch.map((blockNumber) => client.getBlock({ blockNumber })));
    got.forEach((b, j) => out.set(batch[j], Number(b.timestamp)));
  }
  return out;
}
