import { describe, expect, it } from "vitest";
import { deriveHarmonyKeys, normalizePhrase, phraseProblem } from "./derive";

// Public test phrases; expected keys from Foundry's `cast wallet private-key --mnemonic-derivation-path`.
const TEST = "test test test test test test test test test test test junk";
const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("recovery phrase", () => {
  it("normalizes spacing and case", () => {
    expect(normalizePhrase("  Test TEST\ttest\n test test test test test test test test   junk ")).toBe(TEST);
  });

  it("accepts valid phrases and explains invalid ones", () => {
    expect(phraseProblem(TEST)).toBeNull();
    expect(phraseProblem(ABANDON)).toBeNull();
    expect(phraseProblem("legal winner thank year wave sausage worth useful legal winner thank yellow")).toBeNull();
    expect(phraseProblem("test test test")).toMatch(/12, 18 or 24 words; this has 3/);
    expect(phraseProblem(TEST.replace("junk", "junq"))).toMatch(/word list: junq/);
    expect(phraseProblem(TEST.replace("junk", "test"))).toMatch(/checksum does not match/);
    expect(phraseProblem("")).toMatch(/this has 0/);
  });
});

describe("Harmony path keys", () => {
  it("matches an independent derivation on m/44'/1023'/0'/0/N", () => {
    const keys = deriveHarmonyKeys(TEST, "", 0, 8);
    expect(keys[0]).toEqual({
      index: 0,
      path: "m/44'/1023'/0'/0/0",
      address: "0x52d41FeC358F541013e77069043ACb87e605a9A2",
      one1: expect.stringMatching(/^one1[02-9ac-hj-np-z]{38}$/),
      privateKey: "0x68b26d7bd32ab052eaa8201fd0908302446edd5d46662f52b15dfb3b16dc5eba",
    });
    expect(keys[7].address).toBe("0xe5471A3199932ED4E59D637b99d1518eCE1cE51F");
    expect(keys[7].privateKey).toBe("0xc079a821faefa9ac01e7cfe3a841addd14ea87a125cd9fc39b6bb565f3767d72");
  });

  it("uses the BIP-39 passphrase exactly as typed", () => {
    const [zero] = deriveHarmonyKeys(ABANDON, "TREZOR", 0, 1);
    expect(zero.address).toBe("0x098431982Acb693A0b7C952761e9D59296BF5C1c");
    expect(zero.privateKey).toBe("0x9999cb32ff487996fcc25597cc061f1621b2f3214c39fb751854f28146f55e6a");
    const [three] = deriveHarmonyKeys(ABANDON, "TREZOR", 3, 1);
    expect(three.address).toBe("0xfC4314Bd1CA0aeb54D92d034E4616006d57a6e34");
    expect(three.privateKey).toBe("0xb4def8f19f67bdcd113dae47b37c9843029e7f955700d7191c95420ae63eecb2");
    expect(deriveHarmonyKeys(ABANDON, "TREZOR ", 0, 1)[0].address).not.toBe(zero.address);
  });
});
