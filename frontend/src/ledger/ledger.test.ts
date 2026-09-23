import { describe, expect, it } from "vitest";
import { bytesToHex, fromRlp, hexToBytes, keccak256, recoverAddress, stringToBytes, verifyMessage, type Hex } from "viem";
import { HDKey, privateKeyToAccount, sign } from "viem/accounts";
import { harmonyLedgerTx, hexToBech32 } from "@hcp/shared";
import {
  detectApp,
  encodePath,
  ethGetAddress,
  ethSignPersonalMessage,
  ledgerErrorText,
  legacyGetAddress,
  legacySignTx,
  PATH_SCHEMES,
} from "./apps";
import { frameApdu, LedgerStatusError, ResponseAssembler, splitStatus, type Apdu } from "./transport";

const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));

function accountAt(path: string) {
  const key = root.derive(`m/${path}`);
  return privateKeyToAccount(bytesToHex(key.privateKey!));
}

function privateKeyAt(path: string): Hex {
  return bytesToHex(root.derive(`m/${path}`).privateKey!);
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => Array.from(p)));
}

function appNameReply(name: string, version: string): Uint8Array {
  return concat([1, name.length], ascii(name), [version.length], ascii(version), [1, 0]);
}

function decodePath(data: Uint8Array): { path: string; rest: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts: string[] = [];
  for (let i = 0; i < data[0]; i++) {
    const v = view.getUint32(1 + i * 4);
    parts.push(v >= 0x80000000 ? `${v - 0x80000000}'` : `${v}`);
  }
  return { path: parts.join("/"), rest: data.subarray(1 + data[0] * 4) };
}

interface Call {
  cla: number;
  ins: number;
  p1: number;
  p2: number;
  length: number;
}

/** Ethereum-app protocol, as run by the 2025 Harmony app and the Ethereum app. */
function ethAppDevice(name: string) {
  const calls: Call[] = [];
  let pending: { path: string; expected: number; message: Uint8Array } | null = null;
  const apdu: Apdu = async (cla, ins, p1, p2, data = new Uint8Array(0)) => {
    calls.push({ cla, ins, p1, p2, length: data.length });
    if (cla === 0xb0 && ins === 0x01) return appNameReply(name, "1.15.0");
    if (cla !== 0xe0) throw new LedgerStatusError(0x6e00);
    if (ins === 0x06) return Uint8Array.of(0x01, 1, 15, 0);
    if (ins === 0x02) {
      const account = accountAt(decodePath(data).path);
      const publicKey = hexToBytes(account.publicKey);
      return concat([publicKey.length], publicKey, [40], ascii(account.address.slice(2)));
    }
    if (ins === 0x08) {
      if (p1 === 0x00) {
        const { path, rest } = decodePath(data);
        const expected = new DataView(rest.buffer, rest.byteOffset).getUint32(0);
        pending = { path, expected, message: rest.slice(4) };
      } else if (p1 === 0x80 && pending) {
        pending.message = concat(pending.message, data);
      } else {
        throw new LedgerStatusError(0x6b00);
      }
      if (pending.message.length < pending.expected) return new Uint8Array(0);
      const signature = hexToBytes(await accountAt(pending.path).signMessage({ message: { raw: pending.message } }));
      pending = null;
      return concat([signature[64]], signature.subarray(0, 64));
    }
    throw new LedgerStatusError(0x6d00);
  };
  return { apdu, calls };
}

/** Pre-2025 Harmony app: CLA 0xE0 only, fixed path, transaction signing only. */
function legacyAppDevice(bolosName: string | null = null) {
  const calls: Call[] = [];
  const path = "44'/1023'/0'/0/0";
  const account = accountAt(path);
  let buffer: Uint8Array = new Uint8Array(0);
  const apdu: Apdu = async (cla, ins, p1, p2, data = new Uint8Array(0)) => {
    calls.push({ cla, ins, p1, p2, length: data.length });
    if (cla === 0xb0) {
      if (bolosName) return appNameReply(bolosName, "1.6.0");
      throw new LedgerStatusError(0x6e00);
    }
    if (cla !== 0xe0) throw new LedgerStatusError(0x6e00);
    switch (ins) {
      case 0x01:
        return Uint8Array.of(1, 6, 0);
      case 0x02:
        if (p2 !== 0x01) throw new LedgerStatusError(0x6b01);
        return ascii(hexToBech32(account.address.toLowerCase()));
      case 0x08: {
        if (p1 === 0x00) buffer = new Uint8Array(0);
        else if (p1 !== 0x80) throw new LedgerStatusError(0x6b01);
        if (buffer.length + data.length > 1020) throw new LedgerStatusError(0x6807);
        buffer = concat(buffer, data);
        if (p2 === 0x01) return new Uint8Array(0);
        if (p2 !== 0x02) throw new LedgerStatusError(0x6b01);
        const fields = fromRlp(bytesToHex(buffer)) as Hex[];
        expect(fields[5]).toBe(account.address.toLowerCase());
        expect(fields[6]).toBe("0x");
        const { r, s, yParity } = await sign({ hash: keccak256(buffer), privateKey: privateKeyAt(path) });
        return concat(hexToBytes(r, { size: 32 }), hexToBytes(s, { size: 32 }), [yParity ?? 0]);
      }
      default:
        throw new LedgerStatusError(0x6d00);
    }
  };
  return { apdu, calls, account };
}

describe("HID framing", () => {
  it("frames a short APDU into one 64-byte report", () => {
    const [block, ...rest] = frameApdu(0x0101, Uint8Array.of(0xe0, 0x01, 0x00, 0x00, 0x00));
    expect(rest).toHaveLength(0);
    expect(block).toHaveLength(64);
    expect(bytesToHex(block.subarray(0, 12))).toBe("0x010105000000" + "05e001000000");
    expect(block.subarray(12).every((b) => b === 0)).toBe(true);
  });

  it("reassembles replies of any length from the same framing", () => {
    for (const length of [2, 57, 59, 60, 118, 119, 300, 1000]) {
      const reply = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
      const blocks = frameApdu(0xbeef, reply);
      const assembler = new ResponseAssembler(0xbeef);
      let out: Uint8Array | null = null;
      blocks.forEach((block, i) => {
        out = assembler.push(block);
        if (i < blocks.length - 1) expect(out).toBeNull();
      });
      expect(out).toEqual(reply);
    }
  });

  it("rejects a reply on another channel or out of sequence", () => {
    const blocks = frameApdu(0x0101, new Uint8Array(200));
    expect(() => new ResponseAssembler(0x0202).push(blocks[0])).toThrow(/unexpected reply/);
    expect(() => new ResponseAssembler(0x0101).push(blocks[1])).toThrow(/unexpected reply/);
  });

  it("splits the status word", () => {
    expect(splitStatus(Uint8Array.of(0xaa, 0x90, 0x00))).toEqual(Uint8Array.of(0xaa));
    expect(() => splitStatus(Uint8Array.of(0x69, 0x85))).toThrow(LedgerStatusError);
    try {
      splitStatus(Uint8Array.of(0x69, 0x85));
    } catch (err) {
      expect(ledgerErrorText(err)).toBe("The request was rejected on the Ledger.");
    }
  });
});

describe("app detection", () => {
  it("encodes BIP-32 paths", () => {
    expect(bytesToHex(encodePath("44'/1023'/0'/0/0"))).toBe("0x058000002c800003ff800000000000000000000000");
  });

  it("recognizes the 2025 Harmony app and the Ethereum app", async () => {
    expect(await detectApp(ethAppDevice("Harmony").apdu)).toEqual({ kind: "harmony", version: "1.15.0" });
    expect(await detectApp(ethAppDevice("Ethereum").apdu)).toEqual({ kind: "ethereum", version: "1.15.0" });
  });

  it("recognizes the older Harmony app by its command set, whatever it is called", async () => {
    expect(await detectApp(legacyAppDevice().apdu)).toEqual({ kind: "harmony-legacy", version: "1.6.0" });
    for (const name of ["One", "Harmony One", "Harmony"]) {
      expect((await detectApp(legacyAppDevice(name).apdu)).kind).toBe("harmony-legacy");
    }
  });

  it("asks for the Harmony app on the dashboard or another app", async () => {
    const dashboard: Apdu = async (cla) => {
      if (cla === 0xb0) return appNameReply("BOLOS", "2.2.3");
      throw new LedgerStatusError(0x6e01);
    };
    await expect(detectApp(dashboard)).rejects.toThrow("Open the Harmony app");
    const bitcoin: Apdu = async () => appNameReply("Bitcoin", "2.1.0");
    await expect(detectApp(bitcoin)).rejects.toThrow("has the Bitcoin app open");
  });
});


describe("Ethereum-app signing (2025 Harmony app, Ethereum app)", () => {
  it("reads addresses on each path scheme", async () => {
    const device = ethAppDevice("Harmony");
    for (const scheme of ["harmony", "ledger-live", "bip44", "legacy"] as const) {
      const path = PATH_SCHEMES[scheme].path(2);
      expect(await ethGetAddress(device.apdu, path)).toBe(accountAt(path).address);
    }
  });

  it("signs a personal message across several chunks", async () => {
    const device = ethAppDevice("Harmony");
    const path = PATH_SCHEMES.harmony.path(0);
    const message = `Confirm that this wallet is still active.\n${"n".repeat(500)}`;
    const signature = await ethSignPersonalMessage(device.apdu, path, stringToBytes(message));
    expect(await verifyMessage({ address: accountAt(path).address, message, signature })).toBe(true);
    const chunks = device.calls.filter((c) => c.ins === 0x08);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 150)).toBe(true);
    expect(chunks.map((c) => c.p1)).toEqual([0x00, ...Array(chunks.length - 1).fill(0x80)]);
  });

  it("signs a message that fits in the first chunk", async () => {
    const device = ethAppDevice("Ethereum");
    const path = PATH_SCHEMES["ledger-live"].path(1);
    const signature = await ethSignPersonalMessage(device.apdu, path, stringToBytes("short"));
    expect(await verifyMessage({ address: accountAt(path).address, message: "short", signature })).toBe(true);
    expect(device.calls.filter((c) => c.ins === 0x08)).toHaveLength(1);
  });
});

describe("older Harmony app signing", () => {
  it("reads the one1 address and signs the confirmation transaction", async () => {
    const device = legacyAppDevice();
    const address = await legacyGetAddress(device.apdu);
    expect(address).toBe(device.account.address);
    const message = `migrate.country activity confirmation\n\nAddress: ${address}\nNonce: ${"a".repeat(64)}\n${"v".repeat(450)}`;
    const payload = harmonyLedgerTx(address, message);
    const signature = await legacySignTx(device.apdu, payload);
    expect(await recoverAddress({ hash: keccak256(payload), signature })).toBe(address);
    const chunks = device.calls.filter((c) => c.ins === 0x08);
    expect(chunks.map((c) => [c.p1, c.p2])).toEqual([[0x00, 0x01], [0x80, 0x01], [0x80, 0x02]]);
    expect(chunks.map((c) => c.length)).toEqual([255, 255, payload.length - 510]);
  });

  it("marks the last chunk when the payload is an exact multiple of 255 bytes", async () => {
    const device = legacyAppDevice();
    const address = device.account.address;
    let message = "";
    while (harmonyLedgerTx(address, message).length < 510) message += "x";
    const payload = harmonyLedgerTx(address, message);
    expect(payload.length).toBe(510);
    const signature = await legacySignTx(device.apdu, payload);
    expect(await recoverAddress({ hash: keccak256(payload), signature })).toBe(address);
    expect(device.calls.filter((c) => c.ins === 0x08).map((c) => [c.p1, c.p2])).toEqual([[0x00, 0x01], [0x80, 0x02]]);
  });
});
