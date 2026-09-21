import type pg from "pg";

const LEDGER_TABLES = [
  "accounts",
  "delegations",
  "validator_vaults",
  "routing_exceptions",
  "routing_destinations",
  "exchange_wallets",
  "snapshot_meta",
  "reason_texts",
  "load_runs",
  "schema_migrations",
] as const;

export interface PrivilegeProbe {
  role_name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolinherit: boolean;
  member_of_claimapi: boolean;
  accounts_present: boolean;
  accounts_select: boolean;
  ledger_write: boolean;
  public_schema_usage: boolean;
  confirm_schema_usage: boolean;
  confirmations_insert: boolean;
  confirmations_update: boolean;
  confirmations_delete: boolean;
  candidates_insert: boolean;
  reviews_insert: boolean;
}

// Resolve every object by OID. has_*_privilege(name) looks the name up through
// the schema, and that lookup requires USAGE on the schema. Each API role is
// denied USAGE on the other schema, so a name-based probe crashes startup.
export const PRIVILEGE_PROBE_SQL = `
SELECT
  r.rolname AS role_name,
  r.rolsuper,
  r.rolbypassrls,
  r.rolinherit,
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimapi')
      THEN pg_has_role(current_user, 'claimapi', 'member') AND current_user <> 'claimapi'
    ELSE false
  END AS member_of_claimapi,
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'accounts' AND c.relkind = 'r'
  ) AS accounts_present,
  COALESCE((
    SELECT has_table_privilege(current_user, c.oid, 'SELECT')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'accounts' AND c.relkind = 'r'
  ), false) AS accounts_select,
  COALESCE((
    SELECT bool_or(has_table_privilege(current_user, c.oid, perm.privilege))
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS perm(privilege)
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname = ANY ($1::text[])
  ), false) AS ledger_write,
  COALESCE((
    SELECT has_schema_privilege(current_user, n.oid, 'USAGE')
      FROM pg_namespace n
     WHERE n.nspname = 'public'
  ), false) AS public_schema_usage,
  COALESCE((
    SELECT has_schema_privilege(current_user, n.oid, 'USAGE')
      FROM pg_namespace n
     WHERE n.nspname = 'confirm'
  ), false) AS confirm_schema_usage,
  COALESCE((
    SELECT has_table_privilege(current_user, c.oid, 'INSERT')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'confirm' AND c.relname = 'confirmations' AND c.relkind = 'r'
  ), false) AS confirmations_insert,
  COALESCE((
    SELECT has_table_privilege(current_user, c.oid, 'UPDATE')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'confirm' AND c.relname = 'confirmations' AND c.relkind = 'r'
  ), false) AS confirmations_update,
  COALESCE((
    SELECT has_table_privilege(current_user, c.oid, 'DELETE')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'confirm' AND c.relname = 'confirmations' AND c.relkind = 'r'
  ), false) AS confirmations_delete,
  COALESCE((
    SELECT has_table_privilege(current_user, c.oid, 'INSERT')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'confirm' AND c.relname = 'candidates' AND c.relkind = 'r'
  ), false) AS candidates_insert,
  COALESCE((
    SELECT has_table_privilege(current_user, c.oid, 'INSERT')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'confirm' AND c.relname = 'reviews' AND c.relkind = 'r'
  ), false) AS reviews_insert
FROM pg_roles r
WHERE r.rolname = current_user
`;

export function privilegeFailures(kind: "read" | "confirm", probe: PrivilegeProbe): string[] {
  const failures: string[] = [];
  const expected = kind === "read" ? "claim_read" : "claim_confirm";
  if (probe.role_name !== expected) failures.push(`connected as ${probe.role_name}, expected ${expected}`);
  if (probe.rolsuper) failures.push("role is superuser");
  if (probe.rolbypassrls) failures.push("role bypasses row security");
  if (probe.rolinherit) failures.push("role inherits other roles");
  if (probe.member_of_claimapi) failures.push("role is a member of claimapi");
  if (!probe.accounts_present) failures.push("public.accounts is missing");
  if (probe.ledger_write) failures.push("role can modify a ledger table");

  if (kind === "read") {
    if (!probe.accounts_select) failures.push("role cannot select public.accounts");
    if (!probe.public_schema_usage) failures.push("role cannot use schema public");
    if (probe.confirm_schema_usage) failures.push("role can use schema confirm");
    if (probe.confirmations_insert || probe.confirmations_update || probe.confirmations_delete) {
      failures.push("role can modify confirmations");
    }
  } else {
    if (probe.accounts_select) failures.push("role can select public.accounts");
    if (probe.public_schema_usage) failures.push("role can use schema public");
    if (!probe.confirm_schema_usage) failures.push("role cannot use schema confirm");
    if (!probe.confirmations_insert) failures.push("role cannot insert confirmations");
    if (probe.confirmations_update || probe.confirmations_delete) failures.push("role can modify confirmations");
    if (probe.candidates_insert) failures.push("role can modify candidates");
    if (probe.reviews_insert) failures.push("role can write reviews");
  }
  return failures;
}

export async function readPrivilegeProbe(pool: pg.Pool): Promise<PrivilegeProbe> {
  const res = await pool.query<PrivilegeProbe>(PRIVILEGE_PROBE_SQL, [LEDGER_TABLES]);
  const row = res.rows[0];
  if (!row) throw new Error("privilege probe returned no role");
  return row;
}

export async function assertPrivileges(pool: pg.Pool, kind: "read" | "confirm"): Promise<void> {
  const failures = privilegeFailures(kind, await readPrivilegeProbe(pool));
  if (failures.length > 0) {
    throw new Error(`database privilege check failed: ${failures.join("; ")}`);
  }
}
