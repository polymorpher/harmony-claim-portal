/**
 * Proof format for the pre-2025 Harmony Ledger app ("Harmony One"). That app
 * cannot sign a message; it only signs Harmony transfers, and it signs
 * keccak256 of whatever bytes it receives after parsing and displaying the
 * leading fields (recipient, amount, shards).
 *
 * The bytes are the EIP-155 signing form of a Harmony transaction:
 *
 *   rlp([nonce 0, gas price 0, gas limit 0, shard 0, to shard 0,
 *        to = the confirming address, amount 0, data = UTF-8 message,
 *        chain id 1, 0, 0])
 *
 * A gas limit of 0 is below intrinsic gas, so every Harmony node rejects the
 * transaction and a block that contains it is invalid. The 11-field shape
 * cannot collide with an Ethereum transaction or a personal_sign digest.
 */

declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };

/** Harmony mainnet chain id for native (sharded) transactions. */
export const HARMONY_LEDGER_TX_CHAIN_ID = 1;

/** The app buffers at most four 255-byte APDU chunks. */
export const HARMONY_LEDGER_TX_MAX_BYTES = 1020;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(offset + 55 + bytes.length, ...bytes);
}

function rlpBytes(value: Uint8Array): Uint8Array {
  if (value.length === 1 && value[0] < 0x80) return value;
  return concat([lengthPrefix(value.length, 0x80), value]);
}

function rlpList(items: Uint8Array[]): Uint8Array {
  const body = concat(items.map(rlpBytes));
  return concat([lengthPrefix(body.length, 0xc0), body]);
}

function addressBytes(address: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("expected a 20-byte hex address");
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(address.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

const EMPTY = new Uint8Array(0);

/** Bytes the old Harmony Ledger app signs for a confirmation. */
export function harmonyLedgerTx(address: string, message: string): Uint8Array {
  const payload = rlpList([
    EMPTY,
    EMPTY,
    EMPTY,
    EMPTY,
    EMPTY,
    addressBytes(address),
    EMPTY,
    new TextEncoder().encode(message),
    Uint8Array.of(HARMONY_LEDGER_TX_CHAIN_ID),
    EMPTY,
    EMPTY,
  ]);
  if (payload.length > HARMONY_LEDGER_TX_MAX_BYTES) {
    throw new Error(`confirmation transaction is ${payload.length} bytes; the Harmony Ledger app accepts at most ${HARMONY_LEDGER_TX_MAX_BYTES}`);
  }
  return payload;
}
