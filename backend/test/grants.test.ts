import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimCanRequestConfirmation } from "@hcp/shared";

const grants = readFileSync(new URL("../../db/ops/grants.sql", import.meta.url), "utf8");

describe("confirm grants", () => {
  it("does not give the confirm role a way to change ledger or evidence rows", () => {
    expect(grants).not.toMatch(/GRANT ALL[^;]*claim_confirm/i);
    expect(grants).not.toMatch(/GRANT ALL[^;]*claim_read/i);
    expect(grants).toMatch(/REVOKE ALL ON SCHEMA public FROM PUBLIC/);
    expect(grants).toMatch(/GRANT CONNECT, TEMP, CREATE ON DATABASE %I TO claimapi/);
    expect(grants).toMatch(/GRANT SELECT, INSERT ON confirm\.confirmations TO claim_confirm/);
    expect(grants).not.toMatch(/confirm\.challenges/);
    expect(grants).not.toMatch(/UPDATE ON confirm\.confirmations/i);
    expect(grants).not.toMatch(/DELETE/i);
    expect(grants).not.toMatch(/TRUNCATE/i);
    expect(grants).not.toMatch(/claim_confirm TO claimapi|claimapi TO claim_confirm|GRANT claimapi/i);
  });
});

describe("lookup link eligibility", () => {
  const base = {
    account_type: "ordinary_eoa" as string | null,
    exchange_treatments: [] as unknown[],
    migration_policy: {
      stage: "deferred" as string | null,
      stage_reason: "wallet activity predates initial window",
      issuance_treatment: "issue",
    },
  };

  it("offers confirmation to deferred key-controlled wallets", () => {
    expect(claimCanRequestConfirmation(base)).toBe(true);
    expect(claimCanRequestConfirmation({
      ...base,
      account_type: "validator_account",
      migration_policy: { ...base.migration_policy, stage_reason: "no indexed wallet activity" },
    })).toBe(true);
  });

  it("hides the link for exchanges, contracts, and the initial stage", () => {
    expect(claimCanRequestConfirmation({ ...base, exchange_treatments: [{}] })).toBe(false);
    expect(claimCanRequestConfirmation({ ...base, account_type: "contract" })).toBe(false);
    expect(claimCanRequestConfirmation({
      ...base,
      migration_policy: { ...base.migration_policy, stage: "initial" },
    })).toBe(false);
  });
});
