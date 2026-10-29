/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_DEV_API_TARGET?: string;
  /** Comma-separated JSON-RPC URLs for the vault catalog's chain, tried in order. */
  readonly VITE_ETH_RPC_URLS?: string;
  readonly VITE_VAULT_CATALOG_URL?: string;
  /** Comma-separated JSON-RPC URLs for each bridge claim chain besides Ethereum, tried in order. */
  readonly VITE_BSC_RPC_URLS?: string;
  readonly VITE_ARBITRUM_RPC_URLS?: string;
  readonly VITE_BASE_RPC_URLS?: string;
  readonly VITE_LINEA_RPC_URLS?: string;
  /** Where the bridge claim proof files are served; defaults to the run's folder in the public claims bucket. */
  readonly VITE_BRIDGE_PROOFS_URL?: string;
}
