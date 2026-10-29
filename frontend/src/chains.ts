import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import { arbitrum, base, bsc, linea, mainnet, sepolia } from "viem/chains";

function urls(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

interface ChainInfo {
  chain: Chain;
  /** Short name for the page, e.g. "BNB Chain". */
  name: string;
  explorer: string;
  rpcUrls: string[];
}

// Public endpoints that answer from the browser. Tenderly's gateway serves full Ethereum history over
// wide ranges; dRPC's free tier caps a request at 10,000 blocks and publicnode only serves recent blocks,
// so they are fallbacks for the chunked log reads. VITE_ETH_RPC_URLS replaces the Ethereum list for the
// vault catalog's chain, mainnet or Sepolia.
const ETH_RPC_URLS = urls(import.meta.env.VITE_ETH_RPC_URLS);

const CHAINS: Record<number, ChainInfo> = {
  [mainnet.id]: {
    chain: mainnet,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    rpcUrls: ETH_RPC_URLS.length > 0 ? ETH_RPC_URLS : ["https://mainnet.gateway.tenderly.co", "https://eth.drpc.org", "https://ethereum-rpc.publicnode.com"],
  },
  [sepolia.id]: {
    chain: sepolia,
    name: "Sepolia",
    explorer: "https://sepolia.etherscan.io",
    rpcUrls:
      ETH_RPC_URLS.length > 0
        ? ETH_RPC_URLS
        : ["https://sepolia.gateway.tenderly.co", "https://sepolia.drpc.org", "https://ethereum-sepolia-rpc.publicnode.com"],
  },
  [bsc.id]: {
    chain: bsc,
    name: "BNB Chain",
    explorer: "https://bscscan.com",
    rpcUrls: orDefault(import.meta.env.VITE_BSC_RPC_URLS, ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org", "https://bsc.drpc.org"]),
  },
  [arbitrum.id]: {
    chain: arbitrum,
    name: "Arbitrum",
    explorer: "https://arbiscan.io",
    rpcUrls: orDefault(import.meta.env.VITE_ARBITRUM_RPC_URLS, ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"]),
  },
  [base.id]: {
    chain: base,
    name: "Base",
    explorer: "https://basescan.org",
    rpcUrls: orDefault(import.meta.env.VITE_BASE_RPC_URLS, ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"]),
  },
  [linea.id]: {
    chain: linea,
    name: "Linea",
    explorer: "https://lineascan.build",
    rpcUrls: orDefault(import.meta.env.VITE_LINEA_RPC_URLS, ["https://rpc.linea.build", "https://linea-rpc.publicnode.com", "https://linea.drpc.org"]),
  },
};

function orDefault(value: string | undefined, defaults: string[]): string[] {
  const configured = urls(value);
  return configured.length > 0 ? configured : defaults;
}

function info(chainId: number): ChainInfo {
  const found = CHAINS[chainId];
  if (!found) throw new Error(`Unsupported chain ${chainId}`);
  return found;
}

export function chainById(chainId: number): Chain {
  return info(chainId).chain;
}

export function chainName(chainId: number): string {
  return info(chainId).name;
}

export function explorer(chainId: number): string {
  return CHAINS[chainId]?.explorer ?? CHAINS[mainnet.id].explorer;
}

const clients = new Map<number, PublicClient>();

export function publicClient(chainId: number): PublicClient {
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({
      chain: chainById(chainId),
      transport: fallback(info(chainId).rpcUrls.map((url) => http(url, { retryCount: 1, timeout: 20_000 }))),
    });
    clients.set(chainId, client);
  }
  return client;
}
