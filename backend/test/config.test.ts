import { describe, expect, it } from "vitest";
import { loadConfig, loadConfirmConfig } from "../src/config.js";
import { upstreamFor } from "../src/proxy.js";

describe("process configuration", () => {
  it("routes only confirmation paths to the confirm process", () => {
    expect(upstreamFor("/api/v1/confirmations")).toBe("confirm");
    expect(upstreamFor("/api/v1/confirmations/challenges")).toBe("confirm");
    expect(upstreamFor("/api/v1/confirmations/0xabc")).toBe("confirm");
    expect(upstreamFor("/api/health")).toBe("claim");
    expect(upstreamFor("/api/v1/claims/0xabc")).toBe("claim");
    expect(upstreamFor("/api/v1/confirmations-other")).toBe("claim");
  });

  it("refuses the owner URL on a production API process", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://claimapi:secret@127.0.0.1/claims",
      CLAIM_READ_URL: "postgres://claim_read:secret@127.0.0.1/claims",
    })).toThrow(/DATABASE_URL/);
    expect(() => loadConfirmConfig({
      NODE_ENV: "production",
      CONFIRM_DATABASE_URL: "postgres://claim_confirm:secret@127.0.0.1/claims",
      CONFIRM_DOMAIN: "migrate.country",
      ENFORCE_DB_PRIVILEGES: "false",
    })).toThrow(/ENFORCE_DB_PRIVILEGES/);
  });

  it("loads the split URLs", () => {
    const read = loadConfig({ CLAIM_READ_URL: "postgres://claim_read@127.0.0.1/claims", PORT: "8081" });
    expect(read.databaseUrl).toContain("claim_read");
    expect(read.host).toBe("127.0.0.1");
    const confirm = loadConfirmConfig({
      CONFIRM_DATABASE_URL: "postgres://claim_confirm@127.0.0.1/claims",
      CONFIRM_DOMAIN: "migrate.country",
    });
    expect(confirm.domain).toBe("migrate.country");
    expect(confirm.challengeTtlSeconds).toBe(600);
  });
});
