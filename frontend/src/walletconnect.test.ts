import { describe, expect, it } from "vitest";
import { getAddress, verifyMessage, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { deriveHarmonyKeys } from "./keytool/derive";
import { walletErrorText } from "./wallet";
import { checkSigner, chooseAccount, requestChainId, sessionAccounts, signWithSession, type SessionRequester } from "./walletconnect";

const PHRASE = "test test test test test test test test test test test junk";
const ethereumKey = mnemonicToAccount(PHRASE);
const harmonyKey = privateKeyToAccount(deriveHarmonyKeys(PHRASE, "", 0, 1)[0].privateKey);
const E = ethereumKey.address;
const H = harmonyKey.address;
const HARMONY = 1666600000;

/** A wallet that shares its 44'/60' account on Ethereum and its 44'/1023' account on Harmony. */
function wallet(signWith?: typeof ethereumKey) {
  const calls: { method: string; params: unknown; chain?: string }[] = [];
  const keys = new Map([E, H].map((a, i) => [a.toLowerCase(), i === 0 ? ethereumKey : harmonyKey]));
  const session: SessionRequester = {
    async request({ method, params }, chain) {
      calls.push({ method, params, chain });
      const [data, address] = params as [Hex, string];
      const key = signWith ?? keys.get(address.toLowerCase());
      if (!key) throw new Error("unknown account");
      return key.signMessage({ message: { raw: data } });
    },
  };
  return { session, calls };
}

describe("WalletConnect session accounts", () => {
  it("lists each address once with every chain it is shared on", () => {
    const accounts = sessionAccounts({
      eip155: {
        accounts: [`eip155:1:${E.toLowerCase()}`, `eip155:${HARMONY}:${H.toLowerCase()}`, `eip155:11155111:${E}`],
      },
      "eip155:56": { accounts: [`eip155:56:${E}`] },
    });
    expect(accounts).toEqual([
      { address: E, chainIds: [1, 11155111, 56] },
      { address: H, chainIds: [HARMONY] },
    ]);
  });

  it("skips other namespaces and malformed account ids", () => {
    const accounts = sessionAccounts({
      solana: { accounts: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv"] },
      eip155: {
        accounts: [`eip155:1:${E}`, `eip155:1:${E}`, "eip155:1:one1xyz", `eip155::${H}`, `eip155:0x1:${H}`, `cosmos:1:${H}`],
      },
    });
    expect(accounts).toEqual([{ address: E, chainIds: [1] }]);
    expect(sessionAccounts(undefined)).toEqual([]);
  });

  it("acts for the chosen address, else the one shared on Harmony, else the wallet's current one", () => {
    const both = [
      { address: E, chainIds: [1] },
      { address: H, chainIds: [HARMONY] },
    ];
    expect(chooseAccount(both, E, E)?.address).toBe(E);
    expect(chooseAccount(both, null, E)?.address).toBe(H);
    expect(chooseAccount(both, getAddress("0x000000000000000000000000000000000000dEaD"), E)?.address).toBe(H);
    const ethereumOnly = [
      { address: H, chainIds: [1] },
      { address: E, chainIds: [1] },
    ];
    expect(chooseAccount(ethereumOnly, null, E)?.address).toBe(E);
    expect(chooseAccount(ethereumOnly, null, undefined)?.address).toBe(H);
    expect(chooseAccount([], null, E)).toBeUndefined();
  });

  it("sends on the current chain when the account is shared there, else on its first chain", () => {
    const account = { address: H, chainIds: [HARMONY, 1] };
    expect(requestChainId(account, 1)).toBe(1);
    expect(requestChainId(account, 56)).toBe(HARMONY);
    expect(requestChainId(account, undefined)).toBe(HARMONY);
  });
});

describe("signing over a WalletConnect session", () => {
  it("signs with a Harmony-path account on the Harmony chain while the session is on Ethereum", async () => {
    const { session, calls } = wallet();
    const message = "Confirm activity";
    const signature = await signWithSession(session, { address: H, chainIds: [HARMONY] }, 1, message);
    expect(calls).toEqual([{ method: "personal_sign", params: ["0x436f6e6669726d206163746976697479", H], chain: `eip155:${HARMONY}` }]);
    expect(await verifyMessage({ address: H, message, signature })).toBe(true);
    await expect(checkSigner(message, signature, H)).resolves.toBeUndefined();
  });

  it("rejects a signature from another account the wallet holds", async () => {
    const { session } = wallet(ethereumKey);
    const signature = await signWithSession(session, { address: H, chainIds: [HARMONY] }, 1, "hello");
    await expect(checkSigner("hello", signature, H)).rejects.toThrow(`The wallet signed with ${E}, not ${H}.`);
    await expect(checkSigner("hello", "0x1234", H)).rejects.toThrow(`not from ${H}`);
  });

  it("reports a rejection in the wallet as one", async () => {
    const session: SessionRequester = {
      request: () => Promise.reject(Object.assign(new Error("User rejected."), { code: 5000 })),
    };
    const err = await signWithSession(session, { address: H, chainIds: [HARMONY] }, 1, "hello").catch((e: unknown) => e);
    expect(walletErrorText(err)).toBe("The signature request was rejected in the wallet.");
  });
});
