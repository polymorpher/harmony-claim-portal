/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_DEV_API_TARGET?: string;
  /** Comma-separated JSON-RPC URLs for the vault catalog's chain, tried in order. */
  readonly VITE_ETH_RPC_URLS?: string;
  readonly VITE_VAULT_CATALOG_URL?: string;
}
