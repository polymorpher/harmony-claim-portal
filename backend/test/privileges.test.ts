import { describe, expect, it } from "vitest";
import { PRIVILEGE_PROBE_SQL, privilegeFailures, type PrivilegeProbe } from "../src/privileges.js";

function probe(overrides: Partial<PrivilegeProbe> = {}): PrivilegeProbe {
  return {
    role_name: "claim_read",
    rolsuper: false,
    rolbypassrls: false,
    rolinherit: false,
    member_of_claimapi: false,
    accounts_present: true,
    accounts_select: true,
    ledger_write: false,
    public_schema_usage: true,
    confirm_schema_usage: false,
    confirmations_insert: false,
    confirmations_update: false,
    confirmations_delete: false,
    candidates_insert: false,
    reviews_insert: false,
    ...overrides,
  };
}

describe("privilege checks", () => {
  it("looks up objects by OID so a role without schema USAGE can run the probe", () => {
    expect(PRIVILEGE_PROBE_SQL).not.toMatch(/to_regclass\s*\(/);
    expect(PRIVILEGE_PROBE_SQL).not.toMatch(/has_table_privilege\(\s*current_user\s*,\s*'/);
    expect(PRIVILEGE_PROBE_SQL).not.toMatch(/has_schema_privilege\(\s*current_user\s*,\s*'/);
    expect(PRIVILEGE_PROBE_SQL).not.toMatch(/has_column_privilege\(\s*current_user\s*,\s*'/);
    expect(PRIVILEGE_PROBE_SQL).toMatch(/has_table_privilege\(current_user, c\.oid/);
    expect(PRIVILEGE_PROBE_SQL).toMatch(/has_schema_privilege\(current_user, n\.oid/);
  });

  it("accepts the lookup role", () => {
    expect(privilegeFailures("read", probe())).toEqual([]);
  });

  it("accepts the confirm role", () => {
    expect(privilegeFailures("confirm", probe({
      role_name: "claim_confirm",
      accounts_select: false,
      public_schema_usage: false,
      confirm_schema_usage: true,
      confirmations_insert: true,
    }))).toEqual([]);
  });

  it("rejects a confirm role that can write the ledger or replace evidence", () => {
    const failures = privilegeFailures("confirm", probe({
      role_name: "claim_confirm",
      accounts_select: false,
      public_schema_usage: false,
      confirm_schema_usage: true,
      confirmations_insert: true,
      confirmations_update: true,
      ledger_write: true,
      rolsuper: true,
    }));
    expect(failures.join(" ")).toMatch(/ledger/);
    expect(failures.join(" ")).toMatch(/modify confirmations/);
    expect(failures.join(" ")).toMatch(/superuser/);
  });

  it("rejects a lookup role that can use the confirm schema", () => {
    const failures = privilegeFailures("read", probe({ confirm_schema_usage: true, confirmations_insert: true }));
    expect(failures.join(" ")).toMatch(/schema confirm/);
    expect(failures.join(" ")).toMatch(/modify confirmations/);
  });
});
