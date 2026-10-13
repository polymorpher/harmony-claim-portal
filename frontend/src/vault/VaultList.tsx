import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { one } from "../format";
import { onNavigate } from "../router";
import { AgreementBadge } from "./AgreementBadge";
import { agreementStatus, AGREEMENTS_SITE, type AgreementInfo } from "./agreements";
import type { Catalog } from "./catalog";
import { publicClient, readFunding, readVaultStates } from "./chain";
import { formatRounded } from "./breakdown";
import { effectiveFee } from "./format";

export function VaultList({ catalog, account, agreements }: { catalog: Catalog; account: Address | undefined; agreements: AgreementInfo }) {
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

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.vaults
      .map((v) => ({ v, s: states.data?.get(v.vault) }))
      .filter(({ v, s }) => {
        if (!s) return false;
        if (!s.deployed && !showPlanned) return false;
        if (onlyMine && !(s.held && s.held > 0n)) return false;
        if (!needle) return true;
        return (
          v.name.toLowerCase().includes(needle) ||
          v.validator_one1.includes(needle) ||
          v.validator.toLowerCase().includes(needle) ||
          v.vault.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        const x = a.s?.size ?? 0n;
        const y = b.s?.size ?? 0n;
        return x === y ? a.v.name.localeCompare(b.v.name) : x > y ? -1 : 1;
      });
  }, [catalog.vaults, states.data, query, showPlanned, onlyMine]);

  return (
    <section className="card">
      <h2>All governor vaults</h2>
      <p className="small">
        {deployedCount === null ? (
          "Reading the vaults on Ethereum…"
        ) : (
          <>
            {deployedCount} of {catalog.vaults.length} planned governor vaults are deployed
            {fundedCount === null ? "" : `, ${fundedCount} of them funded`}
            {signedCount === null
              ? ""
              : `; ${signedCount} of their governors ${signedCount === 1 ? "has" : "have"} signed the governor agreement`}{" "}
            (
            <a href={AGREEMENTS_SITE} target="_blank" rel="noreferrer">
              governors.country
            </a>
            ). Each vault is named after its validator on Harmony mainnet at the cutoff.
          </>
        )}
      </p>
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
          <input type="checkbox" checked={showPlanned} onChange={(e) => setShowPlanned(e.target.checked)} /> Include vaults not
          deployed yet
        </label>
        {account && (
          <label>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Only vaults where I have
            a balance
          </label>
        )}
      </div>
      {states.error && <p className="error">Could not read the vaults from Ethereum. Try again in a moment.</p>}
      {states.data && rows.length === 0 && <p className="muted">No vault matches.</p>}
      {rows.length > 0 && (
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
            {rows.map(({ v, s }) => {
              const href = `/vault/${v.vault}`;
              const fee = s?.feeBps !== null && s?.feeBps !== undefined ? effectiveFee(s.feeBps, v.commission_rate) : null;
              const waiting = s?.deployed && funding.data !== undefined && !funding.data.has(v.vault.toLowerCase());
              return (
                <tr key={v.vault} className={s?.deployed ? undefined : "planned"}>
                  <td>
                    <a href={href} onClick={onNavigate(href)}>
                      {v.name || v.validator_one1}
                    </a>
                    <div className="small">
                      <code>{v.validator_one1}</code>
                      {!s?.deployed && " · not deployed yet"}
                    </div>
                    <AgreementBadge status={agreementStatus(v, agreements.live)} asOf={agreements.asOf} />
                  </td>
                  <td className="num">
                    {!s?.deployed ? (
                      <span className="muted">Not deployed</span>
                    ) : waiting ? (
                      <span className="muted">Waiting for funding</span>
                    ) : s.size !== null ? (
                      formatRounded(s.size)
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="num">{fee ? `${fee.percent}%` : "-"}</td>
                  {account && <td className="num">{s?.held ? one(s.held.toString(), 2) : "-"}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
