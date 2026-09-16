import { getAddress, isAddress } from "viem";
import { bech32ToHex, hexToBech32, isBech32Address, isHexAddress, type AddressForms } from "@hcp/shared";

export class InvalidAddressError extends Error {
  constructor(message = "address must be a 0x hex or one1 bech32 address") {
    super(message);
    this.name = "InvalidAddressError";
  }
}

/** Accepts `0x...` (any case) or `one1...`; returns the lowercase hex form. */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (isHexAddress(value)) {
    // Reject wrong mixed-case checksums but allow all-lower / all-upper.
    const body = value.slice(2);
    if (body !== body.toLowerCase() && body !== body.toUpperCase()) {
      if (!isAddress(value, { strict: true })) {
        throw new InvalidAddressError("invalid EIP-55 checksum");
      }
    }
    return value.toLowerCase();
  }
  if (isBech32Address(value)) {
    try {
      return bech32ToHex(value);
    } catch {
      throw new InvalidAddressError("invalid one1 address checksum");
    }
  }
  throw new InvalidAddressError();
}

export function addressForms(hexLower: string): AddressForms {
  return {
    hex: hexLower,
    checksum: getAddress(hexLower),
    bech32: hexToBech32(hexLower),
  };
}
