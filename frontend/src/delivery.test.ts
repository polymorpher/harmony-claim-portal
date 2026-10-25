import { describe, expect, it } from "vitest";
import type { ClaimResponse, Destination, VaultPosition } from "@hcp/shared";
import { getAddress, type Address, type Hex } from "viem";
import { deliveryState, deliveryTargets, matchPayments, uniqueAddresses } from "./delivery";
import type { Catalog } from "./vault/catalog";
import type { ReservePayment } from "./vault/chain";

const ONE = 10n ** 18n;
const WALLET = getAddress("0x05fd27b7bc1205fb0d546306c8b6a89c83057fda");
const OTHER = getAddress("0x00000000000000000000000000000000000000b2");
const LEGION: Address = "0x1AbE65566F48538Bfb0025f18CD8096E9B6F152F";
const LEGION_VAULT: Address = "0xB4b49D2630278f0BfeA6a8bebd04be192bb9B98c";
const FORTUNE: Address = "0x63e7E9BB58aA72739a7CEc06f6EA9Fe73eb7A598";
const FORTUNE_VAULT: Address = "0xb75B9f48CF1e66e89727364c4df1d90FD84F6ba8";
const UNLISTED: Address = "0xafebF82EA09ECa9cE1913D68fe053226deF85732";

const ready = (address: string): Destination => ({ address: address.toLowerCase(), status: "ready" });

function position(validator: Address, shares: bigint, over: Partial<VaultPosition> = {}): VaultPosition {
  return {
    validator: { hex: validator.toLowerCase(), checksum: validator, bech32: "" },
    validator_name: `validator ${validator.slice(2, 6)}`,
    expected_shares_atto: (shares * ONE).toString(),
    status: "ready",
    destination: ready(WALLET),
    ...over,
  } as VaultPosition;
}

function claim(over: { wallet?: bigint; walletDestination?: Destination; treatment?: string; positions?: VaultPosition[] } = {}): ClaimResponse {
  return {
    found: true,
    address: { hex: WALLET.toLowerCase(), checksum: WALLET, bech32: "" },
    migration_policy: {
      issuance_treatment: over.treatment ?? "issue",
      wallet_allocation_atto: ((over.wallet ?? 100n) * ONE).toString(),
    },
    wallet_airdrop: { destination: over.walletDestination ?? ready(WALLET) },
    vault_positions: over.positions ?? [],
  } as unknown as ClaimResponse;
}

const catalog = {
  vaults: [
    { validator: LEGION, vault: LEGION_VAULT },
    { validator: FORTUNE, vault: FORTUNE_VAULT },
  ],
} as unknown as Catalog;

let block = 1n;
function payment(address: Address, recipient: Address, one: bigint): ReservePayment {
  block += 1n;
  return { address, recipient, amount: one * ONE, blockNumber: block, transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex };
}

describe("delivery targets", () => {
  it("lists the wallet part and every ready vault position, with its catalog vault", () => {
    const targets = deliveryTargets(
      claim({ positions: [position(LEGION, 601_560n), position(FORTUNE, 601_561n), position(UNLISTED, 802_081n)] }),
      catalog,
    );
    expect(targets.map((t) => [t.kind, t.key, t.vault, t.recipient, t.expected])).toEqual([
      ["wallet", "wallet", null, WALLET, 100n * ONE],
      ["vault", LEGION.toLowerCase(), LEGION_VAULT, WALLET, 601_560n * ONE],
      ["vault", FORTUNE.toLowerCase(), FORTUNE_VAULT, WALLET, 601_561n * ONE],
      ["vault", UNLISTED.toLowerCase(), null, WALLET, 802_081n * ONE],
    ]);
  });

  it("pays the wallet part to its routed destination", () => {
    const [wallet] = deliveryTargets(claim({ walletDestination: ready(OTHER) }), catalog);
    expect(wallet.recipient).toBe(OTHER);
  });

  it("leaves out exchange wallets, unissued claims, held parts and nothing to send", () => {
    expect(deliveryTargets(claim({ treatment: "manual_from_reserve", positions: [position(LEGION, 5n)] }), catalog)).toEqual([]);
    expect(deliveryTargets(claim({ treatment: "not_issued" }), catalog)).toEqual([]);
    expect(deliveryTargets({ ...claim(), found: false }, catalog)).toEqual([]);
    const held = deliveryTargets(
      claim({
        wallet: 0n,
        walletDestination: { address: null, status: "hold" },
        positions: [position(LEGION, 5n, { status: "hold", destination: { address: null, status: "hold" } }), position(FORTUNE, 0n)],
      }),
      catalog,
    );
    expect(held).toEqual([]);
  });

  it("works without the vault list, with no vault for any position", () => {
    const targets = deliveryTargets(claim({ positions: [position(LEGION, 5n)] }), null);
    expect(targets.map((t) => t.vault)).toEqual([null, null]);
  });
});

describe("matching payments", () => {
  it("classifies received against expected", () => {
    expect(deliveryState(10n, 0n)).toBe("not_sent");
    expect(deliveryState(10n, 10n)).toBe("sent");
    expect(deliveryState(10n, 4n)).toBe("partial");
    expect(deliveryState(10n, 11n)).toBe("over");
  });

  it("counts transfers by recipient and deposits by vault and delegator", () => {
    const targets = deliveryTargets(
      claim({ wallet: 110n, positions: [position(LEGION, 600n), position(FORTUNE, 600n), position(UNLISTED, 9n)] }),
      catalog,
    );
    const transfers = [payment("0xFf74317E948695297acb79Cb2De06111F5Cc16b3", WALLET, 110n), payment("0xFf74317E948695297acb79Cb2De06111F5Cc16b3", OTHER, 7n)];
    const deposits = [
      payment(LEGION_VAULT, WALLET, 400n),
      payment(LEGION_VAULT, WALLET, 200n),
      payment(LEGION_VAULT, OTHER, 600n),
      payment(FORTUNE_VAULT, OTHER, 600n),
    ];
    const rows = matchPayments(targets, transfers, deposits);
    expect(rows.map((r) => [r.key, r.payments.length, r.received, r.state])).toEqual([
      ["wallet", 1, 110n * ONE, "sent"],
      [LEGION.toLowerCase(), 2, 600n * ONE, "sent"],
      [FORTUNE.toLowerCase(), 0, 0n, "not_sent"],
      [UNLISTED.toLowerCase(), 0, 0n, "not_sent"],
    ]);
  });

  it("matches addresses in any case and lists each once", () => {
    const rows = matchPayments(deliveryTargets(claim({ wallet: 5n }), catalog), [payment(OTHER, WALLET.toLowerCase() as Address, 2n)], []);
    expect(rows[0].state).toBe("partial");
    expect(uniqueAddresses([WALLET, WALLET.toLowerCase() as Address, null, OTHER])).toHaveLength(2);
  });
});
