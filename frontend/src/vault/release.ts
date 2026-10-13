export const RELEASE_TEXT =
  "The signer agrees to release Harmony and its staff from all claims. This release covers all costs, losses, and damages arising from 2018 through 2027, including the wallet, bridge, and minting incidents, as well as the token migration.";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const key = (address: string) => `hcp.vault.release.${address.toLowerCase()}`;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether this browser recorded the signer agreeing to the current release text. */
export function hasAcceptedRelease(address: string, storage: Storage | null = browserStorage()): boolean {
  const saved = storage?.getItem(key(address));
  if (!saved) return false;
  try {
    return (JSON.parse(saved) as { text?: string }).text === RELEASE_TEXT;
  } catch {
    return false;
  }
}

export function recordRelease(address: string, storage: Storage | null = browserStorage(), now = new Date()): void {
  storage?.setItem(key(address), JSON.stringify({ text: RELEASE_TEXT, accepted_utc: now.toISOString() }));
}
