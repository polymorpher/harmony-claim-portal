import { describe, expect, it } from "vitest";
import { attoToOne, formatOne, hexToBech32, bech32ToHex } from "@hcp/shared";
import { buildClaimResponse, buildMeta } from "../src/claims.js";
import { normalizeAddress, InvalidAddressError } from "../src/address.js";
import { ADDR, MemoryRepository, ONE, snapshotMeta } from "./fixtures.js";

const repo = new MemoryRepository();
const opts = { exposeContractAmounts: false };

async function lookup(address: string, exposeContractAmounts = false) {
  const [account, delegations, exceptions, exchangeWallets, texts, meta] = await Promise.all([
    repo.getAccount(address),
    repo.getDelegations(address),
    repo.getExceptions(address),
    repo.getExchangeWallets(address),
    repo.getReasonTexts(),
    repo.getMeta(),
  ]);
  const vaults = await repo.getVaults(delegations.map((d) => d.validator_address));
  return buildClaimResponse(
    address,
    account,
    delegations,
    exceptions,
    exchangeWallets,
    vaults,
    texts,
    meta,
    { exposeContractAmounts },
  );
}

describe("amount formatting", () => {
  it("is exact and BigInt based", () => {
    expect(attoToOne("1000000000000000000000")).toBe("1000");
    expect(attoToOne("1500000000000000000")).toBe("1.5");
    expect(attoToOne("1")).toBe("0.000000000000000001");
    expect(attoToOne("123456789012345678901234567890")).toBe("123456789012.34567890123456789");
    expect(formatOne("1234567890000000000000000")).toBe("1,234,567.89");
    expect(formatOne("1000000000000000000000", 0)).toBe("1,000");
  });
});

describe("address normalization", () => {
  it("accepts 0x lowercase, checksum, and one1", () => {
    const lower = ADDR.eoa;
    const bech = hexToBech32(lower);
    expect(bech.startsWith("one1")).toBe(true);
    expect(bech32ToHex(bech)).toBe(lower);
    expect(normalizeAddress(lower.toUpperCase().replace("0X", "0x"))).toBe(lower);
    expect(normalizeAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(lower);
    expect(normalizeAddress(bech)).toBe(lower);
    expect(normalizeAddress(`  ${bech}  `)).toBe(lower);
  });
  it("rejects malformed input", () => {
    expect(() => normalizeAddress("0x1234")).toThrow(InvalidAddressError);
    expect(() => normalizeAddress("one1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toThrow(InvalidAddressError);
    expect(() => normalizeAddress("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toThrow(/checksum/);
    expect(() => normalizeAddress("hello")).toThrow(InvalidAddressError);
  });
});

describe("meta", () => {
  it("exposes cutoff, threshold, data version", () => {
    const m = buildMeta(snapshotMeta);
    expect(m.cutoff.shard0?.block).toBe(93623067);
    expect(m.cutoff.shard1?.block).toBe(95882100);
    expect(m.threshold_one).toBe("1000");
    expect(m.data_version).toBe("fixture-test");
    expect(m.fixture).toBe(true);
  });
});

describe("claim lookup shape", () => {
  it("ordinary eligible EOA: same-address wallet + one vault position", async () => {
    const r = await lookup(ADDR.eoa);
    expect(r.found).toBe(true);
    expect(r.account_type).toBe("ordinary_eoa");
    expect(r.address.checksum).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(r.address.bech32).toMatch(/^one1/);
    expect(r.eligibility).toEqual({
      total_claim_atto: (7000n * ONE).toString(),
      total_claim_one: "7000",
      gross_total_claim_atto: (7000n * ONE).toString(),
      gross_total_claim_one: "7000",
      not_issued_atto: "0",
      not_issued_one: "0",
      redistributed_atto: "0",
      redistributed_one: "0",
      qualification_total_atto: (7000n * ONE).toString(),
      qualification_total_one: "7000",
      meets_threshold: true,
      status: "prioritized",
    });
    expect(r.wallet_airdrop?.gross_one).toBe("5000");
    expect(r.wallet_airdrop?.issuable_one).toBe("5000");
    expect(r.wallet_airdrop?.destination).toEqual({ address: ADDR.eoa, status: "ready" });
    expect(r.vault_positions).toHaveLength(1);
    const p = r.vault_positions[0];
    expect(p.validator.hex).toBe(ADDR.v1);
    expect(p.validator_name).toBe("Fixture One");
    expect(p.staked_one).toBe("2000");
    expect(p.expected_shares_one).toBe("2000");
    expect(p.status).toBe("ready");
    expect(p.vault?.assets_one).toBe("17005");
    expect(r.adjustments).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it("uses the planned flat *_atto / *_one field names", async () => {
    const r = await lookup(ADDR.excl);
    expect(Object.keys(r.eligibility!)).toEqual([
      "total_claim_atto", "total_claim_one",
      "gross_total_claim_atto", "gross_total_claim_one",
      "not_issued_atto", "not_issued_one",
      "redistributed_atto", "redistributed_one",
      "qualification_total_atto", "qualification_total_one",
      "meets_threshold", "status",
    ]);
    expect(Object.keys(r.wallet_airdrop!)).toEqual([
      "gross_atto", "gross_one", "not_issued_atto", "not_issued_one",
      "redistributed_atto", "redistributed_one", "held_atto", "held_one",
      "net_atto", "net_one", "initial_stage_atto", "initial_stage_one",
      "issuable_atto", "issuable_one", "destination",
    ]);
    const p = r.vault_positions[0];
    for (const k of ["staked_atto", "not_issued_atto", "held_atto", "expected_shares_atto", "staked_one", "expected_shares_one"]) {
      expect(p).toHaveProperty(k);
    }
    for (const k of ["kind", "amount_atto", "amount_one", "reason_code", "title", "user_text", "evidence"]) {
      expect(r.adjustments[0]).toHaveProperty(k);
    }
    for (const k of Object.keys(r.components!)) expect(k).toMatch(/_(atto|one)$/);
    expect(r.meta).toHaveProperty("threshold_atto");
    expect(r.meta).toHaveProperty("threshold_one");
    // every *_atto is a decimal integer string
    const attoValues = JSON.stringify(r).match(/"[a-z_]+_atto":"[^"]*"/g) ?? [];
    expect(attoValues.length).toBeGreaterThan(10);
    for (const kv of attoValues) expect(kv).toMatch(/:"\d+"$/);
  });

  it("below-threshold EOA is deferred with a note", async () => {
    const r = await lookup(ADDR.small);
    expect(r.eligibility?.status).toBe("deferred");
    expect(r.eligibility?.meets_threshold).toBe(false);
    expect(r.notes.some((n) => /below the 1,000 ONE threshold/.test(n))).toBe(true);
    expect(r.vault_positions[0].priority).toBe(false);
    expect(r.migration_policy?.total_allocation_atto).toBe("0");
  });

  it("validator account: same-address adjustments and note", async () => {
    const r = await lookup(ADDR.v1);
    expect(r.account_type).toBe("validator_account");
    expect(r.code_bearing).toBe(true);
    expect(r.adjustments.map((a) => a.kind)).toEqual(["same_address", "same_address"]);
    expect(r.adjustments[0].title).toBe("Verified validator account");
    expect(r.wallet_airdrop?.destination).toEqual({ address: ADDR.v1, status: "ready" });
    expect(r.vault_positions[0].is_self_delegation).toBe(true);
    expect(r.notes.some((n) => /Verified validator account/.test(n))).toBe(true);
  });

  it("excluded account: everything not issued, wallet first then pro-rata vault", async () => {
    const r = await lookup(ADDR.excl);
    expect(r.account_type).toBe("excluded");
    expect(r.wallet_airdrop?.not_issued_one).toBe("1000");
    expect(r.wallet_airdrop?.issuable_one).toBe("0");
    expect(r.wallet_airdrop?.destination).toEqual({ address: null, status: "not_issuing" });
    const byValidator = Object.fromEntries(r.vault_positions.map((p) => [p.validator.hex, p]));
    expect(byValidator[ADDR.v1].not_issued_one).toBe("3000");
    expect(byValidator[ADDR.v1].expected_shares_one).toBe("0");
    expect(byValidator[ADDR.v2].expected_shares_one).toBe("0");
    expect(byValidator[ADDR.v2].vault?.governor_status).toBe("hold");
    expect(r.adjustments.filter((a) => a.kind === "deduction")).toHaveLength(3);
    expect(r.adjustments[0].reason_code).toBe("not_issuing_blacklisted_extra_mint_recipient");
    expect(r.adjustments[0].title).toBe("Deduction: extra-mint");
    expect(r.notes.some((n) => /5,000 ONE is not issued/.test(n))).toBe(true);
    expect(r.eligibility?.total_claim_one).toBe("0");
    expect(r.eligibility?.meets_threshold).toBe(true);
    expect(r.eligibility?.status).toBe("not_issuing");
    expect(r.migration_policy?.issuance_treatment).toBe("not_issued");
    expect(r.notes.some((n) => /vault governor/.test(n))).toBe(true);
  });

  it("partial not-issuing leaves the remainder issuable to the same address", async () => {
    const r = await lookup(ADDR.partial);
    expect(r.wallet_airdrop?.gross_one).toBe("8000");
    expect(r.wallet_airdrop?.not_issued_one).toBe("5000");
    expect(r.wallet_airdrop?.issuable_one).toBe("3000");
    expect(r.eligibility?.gross_total_claim_one).toBe("10000");
    expect(r.eligibility?.total_claim_one).toBe("5000");
    expect(r.wallet_airdrop?.destination).toEqual({ address: ADDR.partial, status: "ready" });
    expect(r.vault_positions[0].expected_shares_one).toBe("2000");
  });

  it("contract: category + note only, amounts hidden by default", async () => {
    const r = await lookup(ADDR.safe);
    expect(r.found).toBe(true);
    expect(r.account_type).toBe("contract");
    expect(r.contract_category).toBe("multisig-wallet");
    expect(r.eligibility).toBeNull();
    expect(r.components).toBeNull();
    expect(r.wallet_airdrop).toBeNull();
    expect(r.adjustments).toEqual([]);
    expect(r.notes[0]).toMatch(/smart contract \(multisig-wallet\)/);
    expect(r.migration_policy?.total_allocation_atto).toBeNull();
  });

  it("contract amounts shown when EXPOSE_CONTRACT_AMOUNTS=true", async () => {
    const r = await lookup(ADDR.safe, true);
    expect(r.wallet_airdrop?.gross_one).toBe("50000");
    expect(r.wallet_airdrop?.held_one).toBe("50000");
    expect(r.wallet_airdrop?.destination).toEqual({ address: null, status: "hold" });
    expect(r.adjustments[0].kind).toBe("hold");
    expect(r.adjustments[0].title).toBe("Held: smart contract");
    expect(r.disposition?.code).toBe("multisig_next_stage");
  });

  it("exposes WONE separately from native wallet value", async () => {
    const r = await lookup(ADDR.wone);
    expect(r.components?.native_wallet_airdrop_one).toBe("800");
    expect(r.components?.wone_balance_one).toBe("300");
    expect(r.components?.wone_airdrop_one).toBe("300");
    expect(r.wallet_airdrop?.net_one).toBe("1100");
    expect(r.eligibility?.qualification_total_one).toBe("1100");
  });

  it("marks a fully deducted claim as not issuing and not prioritized", async () => {
    const r = await lookup(ADDR.deducted);
    expect(r.eligibility?.gross_total_claim_one).toBe("5000");
    expect(r.eligibility?.total_claim_one).toBe("0");
    expect(r.eligibility?.meets_threshold).toBe(true);
    expect(r.eligibility?.status).toBe("not_issuing");
    expect(r.disposition?.code).toBe("not_issuing");
  });

  it("routes non-Gate exchange wallets through the exchange", async () => {
    const r = await lookup(ADDR.exchange);
    expect(r.disposition?.code).toBe("handled_by_exchange");
    expect(r.disposition?.title).toBe("Initial stage — handled by OKX");
    expect(r.disposition?.destination).toEqual({ address: ADDR.eoa, status: "ready" });
    expect(r.eligibility?.status).toBe("handled_by_exchange");
  });

  it("does not let a ready exchange destination promote a deferred stage", async () => {
    const r = await lookup(ADDR.exchangeDeferred);
    expect(r.migration_policy?.stage).toBe("deferred");
    expect(r.disposition?.code).toBe("deferred");
    expect(r.wallet_airdrop?.issuable_atto).toBe("0");
    expect(r.exchange_treatments[0].destination.status).toBe("ready");
  });

  it("keeps Gate initial-stage status explicit without inventing an aggregate route", async () => {
    const r = await lookup(ADDR.gate);
    expect(r.eligibility?.status).toBe("deferred");
    expect(r.disposition?.code).toBe("gate_deferred");
    expect(r.disposition?.detail).toMatch(/no aggregate reroute/);
    expect(r.wallet_airdrop?.issuable_atto).toBe("0");
    expect(r.wallet_airdrop?.held_atto).toBe(r.wallet_airdrop?.net_atto);
    expect(r.wallet_airdrop?.destination).toEqual({ address: null, status: "hold" });
  });

  it("shows exchange identity without inventing entitlement for a no-claim row", async () => {
    const r = await lookup(ADDR.exchangeOnly);
    expect(r.found).toBe(false);
    expect(r.eligibility).toBeNull();
    expect(r.disposition?.code).toBe("exchange_no_claim");
    expect(r.disposition?.destination).toEqual({ address: null, status: "none" });
    expect(r.exchange_treatments[0].destination).toEqual({ address: null, status: "none" });
  });

  it("uses dedicated next-stage wording for reviewed contract classes", async () => {
    const oneWallet = await lookup(ADDR.onewallet);
    expect(oneWallet.disposition?.title).toBe("To be routed to the 1wallet recovery multisig");
    const bridge = await lookup(ADDR.bridge);
    expect(bridge.disposition?.title).toBe("Bridge contract");
    expect(bridge.disposition?.detail).toMatch(/dedicated claim portal/);
  });

  it("does not put a threshold-qualified inactive wallet in the initial stage", async () => {
    const r = await lookup(ADDR.inactive);
    expect(r.eligibility?.meets_threshold).toBe(true);
    expect(r.eligibility?.status).toBe("deferred");
    expect(r.migration_policy?.stage).toBe("deferred");
    expect(r.wallet_airdrop?.initial_stage_atto).toBe("0");
    expect(r.wallet_airdrop?.issuable_atto).toBe("0");
    expect(r.disposition?.code).toBe("deferred");
  });

  it("fails closed when a qualified account has no loaded stage policy", async () => {
    const r = await lookup(ADDR.stageMissing);
    expect(r.eligibility?.meets_threshold).toBe(true);
    expect(r.eligibility?.status).toBe("deferred");
    expect(r.migration_policy?.stage_policy_applied).toBe(false);
    expect(r.migration_policy?.total_allocation_atto).toBe("0");
    expect(r.disposition?.code).toBe("hold");
    expect(r.wallet_airdrop?.issuable_atto).toBe("0");
  });

  it("shows reviewed SmartVault as not issued even when contract amounts are hidden", async () => {
    const r = await lookup(ADDR.smartvault);
    expect(r.account_type).toBe("contract");
    expect(r.eligibility).toBeNull();
    expect(r.migration_policy?.snapshot_qualified).toBe(true);
    expect(r.migration_policy?.issuance_treatment).toBe("not_issued");
    expect(r.migration_policy?.total_allocation_atto).toBeNull();
    expect(r.disposition?.code).toBe("not_issuing");
    expect(r.notes.join(" ")).toMatch(/2050 premint reserve/);
  });

  it("unknown address: found=false with a note and meta", async () => {
    const r = await lookup(ADDR.unknown);
    expect(r.found).toBe(false);
    expect(r.account_type).toBeNull();
    expect(r.notes).toHaveLength(1);
    expect(r.meta.data_version).toBe("fixture-test");
  });

  void opts;
});
