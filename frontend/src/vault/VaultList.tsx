import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { one } from "../format";
import { onNavigate } from "../router";
import { AgreementBadge } from "./AgreementBadge";
import { agreementStatus, AGREEMENTS_SITE, type AgreementInfo, type AgreementStatus } from "./agreements";
import type { Catalog, CatalogVault } from "./catalog";
import { publicClient, readFunding, readVaultStates, type VaultState } from "./chain";
import { CompensationNotice } from "./CompensationNotice";
import { formatRounded } from "./breakdown";
import { effectiveFee } from "./format";
import { displayVaultName, vaultMatchesQuery } from "./names";

type Row = { v: CatalogVault; s: VaultState | undefined; signed: boolean; display: string };

export function VaultList({
  catalog,
  account,
  agreements,
  names,
}: {
  catalog: Catalog;
  account: Address | undefined;
  agreements: AgreementInfo;
  names: ReadonlyMap<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [showPlanned, setShowPlanned] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const states = useQuery({
    queryKey: ["vault-states", catalog.chain_id, account ?? null],
    queryFn: () => readVaultStates(publicClient(catalog.chain_id), catalog, account),
    refetchInterval: 60_000,
  });

  const deployed = useMemo(
    () => (states.data ? catalog.vaults.filter((v) => states.data.get(v.vault)?.deployed).map((v) => v.vault) : null),
    [catalog.vaults, states.data],
  );
  const funding = useQuery({
    queryKey: ["vault-funding", catalog.chain_id, deployed?.join(",") ?? ""],
    queryFn: () => readFunding(publicClient(catalog.chain_id), deployed ?? [], catalog.reserve, catalog.start_block),
    enabled: deployed !== null,
    refetchInterval: 60_000,
  });
  const deployedCount = deployed?.length ?? null;
  const fundedCount = funding.data ? funding.data.size : null;
  const signedCount = useMemo(() => {
    if (!deployed) return null;
    const set = new Set(deployed);
    return catalog.vaults.filter((v) => set.has(v.vault) && agreementStatus(v, agreements.live).state === "signed").length;
  }, [catalog.vaults, deployed, agreements.live]);

  const needle = query.trim().toLowerCase();
  const { signed, unsigned } = useMemo(() => {
    const rows = catalog.vaults
      .map((v) => {
        const s = states.data?.get(v.vault);
        const display = displayVaultName(v, names);
        return { v, s, signed: agreementStatus(v, agreements.live).state === "signed", display };
      })
      .filter(({ v, s, display }) => {
        if (!s) return false;
        if (!s.deployed && !showPlanned) return false;
        if (onlyMine && !(s.held && s.held > 0n)) return false;
        return vaultMatchesQuery(v, display, needle);
      })
      .sort((a, b) => {
        const x = a.s?.size ?? 0n;
        const y = b.s?.size ?? 0n;
        return x === y ? a.display.localeCompare(b.display) : x > y ? -1 : 1;
      });
    return { signed: rows.filter((row) => row.signed), unsigned: rows.filter((row) => !row.signed) };
  }, [catalog.vaults, states.data, needle, showPlanned, onlyMine, agreements.live, names]);

  return (
    <section className="card">
      <h2>All governor vaults</h2>
      <p className="small">
        {deployedCount === null ? (
          "Reading the vaults on Ethereum…"
        ) : (
          <>
            {deployedCount} governor {deployedCount === 1 ? "vault is" : "vaults are"} deployed
            {fundedCount === null ? "" : `, ${fundedCount} of them funded`}
            {signedCount === null
              ? ""
              : `; ${signedCount} of their governors ${signedCount === 1 ? "has" : "have"} signed the governor agreement`}{" "}
            (
            <a href={AGREEMENTS_SITE} target="_blank" rel="noreferrer">
              governors.country
            </a>
            ). A vault was deployed only for a validator with at least 10,000 ONE. Validators with less were not given a
            vault. A vault starts with its validator's name on Harmony at the cutoff. The governor can change that name.
          </>
        )}
      </p>
      <CompensationNotice />
      <div className="lookup">
        <label htmlFor="vault-search">Search by name or address</label>
        <input
          id="vault-search"
          className="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. Fortune"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="filters">
        <label>
          <input type="checkbox" checked={showPlanned} onChange={(e) => setShowPlanned(e.target.checked)} /> Include
          validators with less than 10,000 ONE
        </label>
        {account && (
          <label>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Only vaults where I have
            a balance
          </label>
        )}
      </div>
      {states.error && <p className="error">Could not read the vaults from Ethereum. Try again in a moment.</p>}
      {states.data && signed.length === 0 && unsigned.length === 0 && <p className="muted">No vault matches.</p>}
      {signed.length > 0 && (
        <VaultTable rows={signed} account={account} agreements={agreements} fundingKnown={funding.data} />
      )}
      {unsigned.length > 0 && needle && (
        <>
          <h3 className="vault-fold-title">Without a signed governor agreement</h3>
          <p className="small">Delegators in these vaults do not receive quarterly compensation.</p>
          <VaultTable rows={unsigned} account={account} agreements={agreements} fundingKnown={funding.data} />
        </>
      )}
      {unsigned.length > 0 && !needle && (
        <details className="vault-fold">
          <summary>
            Vaults without a signed governor agreement ({unsigned.length})
          </summary>
          <p className="small">Delegators in these vaults do not receive quarterly compensation.</p>
          <VaultTable rows={unsigned} account={account} agreements={agreements} fundingKnown={funding.data} />
        </details>
      )}
    </section>
  );
}

function VaultTable({
  rows,
  account,
  agreements,
  fundingKnown,
}: {
  rows: Row[];
  account: Address | undefined;
  agreements: AgreementInfo;
  fundingKnown: ReadonlyMap<string, bigint> | undefined;
}) {
  return (
    <table className="vaults">
      <thead>
        <tr>
          <th>Governor vault</th>
          <th className="num">Vault size (ONE)</th>
          <th className="num">Fee</th>
          {account && <th className="num">Your balance</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ v, s, display }) => (
          <VaultRow key={v.vault} entry={v} state={s} display={display} account={account} agreements={agreements} fundingKnown={fundingKnown} />
        ))}
      </tbody>
    </table>
  );
}

function VaultRow({
  entry,
  state,
  display,
  account,
  agreements,
  fundingKnown,
}: {
  entry: CatalogVault;
  state: VaultState | undefined;
  display: string;
  account: Address | undefined;
  agreements: AgreementInfo;
  fundingKnown: ReadonlyMap<string, bigint> | undefined;
}) {
  const href = `/vault/${entry.vault}`;
  const fee = state?.feeBps !== null && state?.feeBps !== undefined ? effectiveFee(state.feeBps, entry.commission_rate) : null;
  const waiting = state?.deployed && fundingKnown !== undefined && !fundingKnown.has(entry.vault.toLowerCase());
  const status: AgreementStatus = agreementStatus(entry, agreements.live);
  return (
    <tr className={state?.deployed ? undefined : "planned"}>
      <td>
        <a href={href} onClick={onNavigate(href)}>
          {display}
        </a>
        <div className="small">
          <code>{entry.validator_one1}</code>
          {!state?.deployed && " · no vault deployed"}
          {display !== entry.name && entry.name && ` · ${entry.name} at the cutoff`}
        </div>
        <AgreementBadge status={status} asOf={agreements.asOf} />
      </td>
      <td className="num">
        {!state?.deployed ? (
          <span className="muted">No vault deployed</span>
        ) : waiting ? (
          <span className="muted">Waiting for funding</span>
        ) : state.size !== null ? (
          formatRounded(state.size)
        ) : (
          "-"
        )}
      </td>
      <td className="num">{fee ? `${fee.percent}%` : "-"}</td>
      {account && <td className="num">{state?.held ? one(state.held.toString(), 2) : "-"}</td>}
    </tr>
  );
}
