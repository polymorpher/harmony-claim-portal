import { concat, getAddress, getContractAddress, isAddress, isHex, keccak256, pad, type Address, type Hex } from "viem";

/** keccak256 of the audited GovernorDelegator creation code (hiddenstate.xyz audit, 2026-10-06). */
export const AUDITED_CREATION_KECCAK = "0x72dad98e0eda48dc4d8aae1760b3a11b664c7005dd13f6719d2209355128d4f2";
/** Arachnid's deterministic deployment proxy; the vault salt is the validator address. */
export const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const CATALOG_FORMAT = "vault-catalog/v1";
/** The ERC-20 ONE token per chain: mainnet, and the staging token the Sepolia rehearsal used. */
export const ONE_TOKENS: Record<number, Address> = {
  1: "0xFf74317E948695297acb79Cb2De06111F5Cc16b3",
  11155111: "0x6dF02e9a623f9d11d6c73B1fc2aBfAbb63f11E72",
};
/** Block each of those tokens was deployed in; the reserve paid nothing before it. */
export const ONE_TOKEN_BLOCKS: Record<number, number> = {
  1: 25_936_466,
  11155111: 11_664_601,
};

export interface StageTotal {
  count: number;
  atto: string;
}

export interface CutoffDelegations {
  delegators: number;
  stake_atto: string;
  initial: StageTotal;
  /** Inactive stake whose delegator confirmed on the portal and was approved; absent when no export was given. */
  confirmed?: StageTotal;
  inactive: StageTotal;
  below_threshold: StageTotal;
  exchange: StageTotal;
  next_stage: StageTotal;
  not_issued: StageTotal;
  manual_review: StageTotal;
}

export interface CatalogVault {
  validator: Address;
  validator_one1: string;
  name: string;
  governor: Address;
  vault: Address;
  /** Harmony commission at the cutoff, a decimal fraction such as "0.07". */
  commission_rate: string;
  cutoff: CutoffDelegations;
  /** The validator's governor agreement on governors.country; `signed` is the snapshot when the catalog was built. */
  agreement?: { id: Hex; signed: boolean };
}

export interface Catalog {
  format: string;
  generated_utc: string;
  chain_id: number;
  token: Address;
  reserve: Address;
  factory: Address;
  creation_code: Hex;
  start_block: number;
  harmony_cutoff: { block: number; time_utc: string };
  threshold_atto: string;
  /** Portal confirmation exports the confirmed totals come from. */
  portal_exports?: { name: string; sha256: string; time_utc: string }[];
  /** Where the agreement ids came from and when their `signed` snapshot was taken. */
  governor_agreements?: { source: string; sha256: string; count: number; checked_utc: string };
  vaults: CatalogVault[];
}

/** When the newest portal export used for the confirmed totals was taken, if any. */
export function confirmedAsOf(catalog: Catalog): string | null {
  const times = (catalog.portal_exports ?? []).map((e) => e.time_utc).sort();
  return times.length > 0 ? times[times.length - 1] : null;
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

export function vaultAddress(creationCode: Hex, token: Address, validator: Address, governor: Address): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: CREATE2_FACTORY,
    salt: pad(validator),
    bytecodeHash: keccak256(concat([creationCode, pad(token), pad(governor)])),
  });
}

/**
 * Accepts a catalog only if its creation code is the audited build and every
 * vault address is the CREATE2 address of that code for its validator and
 * governor, so a wrong or tampered file cannot point the page elsewhere.
 */
export function checkCatalog(raw: unknown): Catalog {
  const c = raw as Catalog;
  if (!c || c.format !== CATALOG_FORMAT) throw new CatalogError("The vault list has an unknown format.");
  if (!isHex(c.creation_code) || keccak256(c.creation_code) !== AUDITED_CREATION_KECCAK) {
    throw new CatalogError("The vault list does not carry the audited vault contract.");
  }
  if (getAddress(c.factory) !== CREATE2_FACTORY) throw new CatalogError("The vault list names another deployer.");
  if (!isAddress(c.token) || !isAddress(c.reserve)) throw new CatalogError("The vault list has a bad token or reserve.");
  if (getAddress(c.token) !== ONE_TOKENS[c.chain_id]) throw new CatalogError("The vault list names another token.");
  const vaults = c.vaults.map((v) => {
    const expected = vaultAddress(c.creation_code, c.token, v.validator, v.governor);
    if (getAddress(v.vault) !== expected) {
      throw new CatalogError(`The vault list gives ${v.vault} for ${v.name}; the audited contract would be at ${expected}.`);
    }
    if (v.agreement && !/^0x[0-9a-fA-F]{64}$/.test(v.agreement.id)) {
      throw new CatalogError(`The vault list has a bad governor agreement id for ${v.name}.`);
    }
    return { ...v, validator: getAddress(v.validator), governor: getAddress(v.governor), vault: expected };
  });
  return { ...c, token: getAddress(c.token), reserve: getAddress(c.reserve), vaults };
}

export const CATALOG_URL = import.meta.env.VITE_VAULT_CATALOG_URL || "/vault-catalog.json";

export async function loadCatalog(url = CATALOG_URL): Promise<Catalog> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new CatalogError(`The vault list could not be loaded (HTTP ${res.status}).`);
  return checkCatalog(await res.json());
}

export function findVault(catalog: Catalog, address: string): CatalogVault | undefined {
  const target = address.toLowerCase();
  return catalog.vaults.find((v) => v.vault.toLowerCase() === target);
}
