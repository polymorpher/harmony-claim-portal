import { useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { hexToBech32, type ArchiveMetaResponse, type ArchiveRecord } from "@hcp/shared";
import { ApiRequestError, fetchArchiveAddress, fetchArchiveMeta, fetchArchiveTx } from "../api";
import { formatUtc, one, shortAddress } from "../format";
import { Nav } from "../Nav";
import { navigate, onNavigate } from "../router";
import {
  calldataLines,
  calldataSize,
  callLabel,
  destinationText,
  direction,
  historyPath,
  isCreation,
  isMalformedHistoryLocation,
  parseHistoryLocation,
  parseQuery,
  recordFlags,
  recordLabel,
  shardText,
  type HistoryQuery,
} from "./model";

function errorText(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return `Too many lookups from your connection. Try again in ${err.retryAfterSeconds ?? 60} seconds.`;
    if (err.status === 404) return "No archived record has this hash.";
    if (err.status === 400) return "That is not a valid address or transaction hash.";
    if (err.status === 503) return "The lookup service is temporarily unavailable.";
    return err.message;
  }
  return "Network error while contacting the lookup service.";
}

function AddressLink({ address }: { address: string | null }) {
  if (!address) return <span className="muted">-</span>;
  const path = historyPath({ type: "address", value: address });
  return (
    <a href={path} onClick={onNavigate(path)} title={`${address}\n${hexToBech32(address)}`}>
      <code>{shortAddress(address)}</code>
    </a>
  );
}

function TxLink({ hash }: { hash: string }) {
  const path = historyPath({ type: "tx", value: hash });
  return (
    <a href={path} onClick={onNavigate(path)} title={hash}>
      <code>{shortAddress(hash)}</code>
    </a>
  );
}

function Flags({ record }: { record: ArchiveRecord }) {
  const flags = recordFlags(record);
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map((flag) => (
        <span key={flag} className="tag warn-tag">
          {flag}
        </span>
      ))}
    </>
  );
}

function AddressHistory({ address }: { address: string }) {
  const query = useInfiniteQuery({
    queryKey: ["archive-address", address.toLowerCase()],
    queryFn: ({ pageParam }) => fetchArchiveAddress(address, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_before,
    retry: false,
    staleTime: 300_000,
  });
  if (query.isLoading) return <p className="muted">Loading…</p>;
  const error = errorText(query.error);
  if (error) return <p className="error">{error}</p>;
  const pages = query.data?.pages ?? [];
  const forms = pages[0]?.address;
  const records = pages.flatMap((p) => p.records);
  return (
    <>
      {forms && (
        <p className="history-id">
          <code>{forms.checksum}</code>
          <br />
          <code>{forms.bech32}</code>
        </p>
      )}
      {records.length === 0 ? (
        <p className="muted">No archived record of at least the minimum value involves this address.</p>
      ) : (
        <div className="history-table">
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Type</th>
                <th></th>
                <th>Counterparty</th>
                <th className="num">Amount (ONE)</th>
                <th>Shard</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const dir = direction(r, forms?.hex ?? address);
                const fn = callLabel(r);
                return (
                  <tr key={r.id} className={r.branch === "rolled_back" || r.status === "failed" ? "dim" : undefined}>
                    <td className="small">{formatUtc(r.time_utc)}</td>
                    <td>
                      {recordLabel(r)}
                      {fn && (
                        <code className="small fn-label" title={r.method_name ?? undefined}>
                          {fn}
                        </code>
                      )}{" "}
                      <Flags record={r} />
                    </td>
                    <td>
                      <span className={`dir dir-${dir}`}>{dir === "in" ? "In" : dir === "out" ? "Out" : "Self"}</span>
                    </td>
                    <td>
                      <AddressLink address={dir === "in" ? r.from : r.to} />
                    </td>
                    <td className="num">{one(r.value_atto)}</td>
                    <td>{shardText(r)}</td>
                    <td>
                      <TxLink hash={r.tx_hash} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {query.hasNextPage && (
        <button type="button" className="ghost" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? "Loading…" : "Load older records"}
        </button>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th>{label}</th>
      <td>{children}</td>
    </tr>
  );
}

function FunctionField({ record }: { record: ArchiveRecord }) {
  if (!record.method || isCreation(record)) return null;
  return (
    <Field label="Function">
      {record.method_name ? (
        <>
          <code>{record.method_name}</code>
          {!record.method_verified && (
            <span className="small muted"> (likely name; no verified contract uses this signature)</span>
          )}
        </>
      ) : (
        <span className="muted">Unknown</span>
      )}
      <br />
      <span className="small muted">Selector</span> <code className="small">{record.method}</code>
    </Field>
  );
}

function Calldata({ input, creation }: { input: string; creation: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(input).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <details className="calldata">
      <summary>{calldataSize(input).toLocaleString("en-US")} bytes</summary>
      <pre className="message">{creation ? input : calldataLines(input).join("\n")}</pre>
      <button type="button" className="ghost" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </details>
  );
}

function RecordCard({ record }: { record: ArchiveRecord }) {
  const destination = destinationText(record);
  const creation = isCreation(record);
  return (
    <div className={`history-record${record.branch === "rolled_back" ? " rolled-back" : ""}`}>
      <h3>
        {recordLabel(record)} <Flags record={record} />
      </h3>
      <table className="kv">
        <tbody>
          <Field label="Amount">{one(record.value_atto, 18)} ONE</Field>
          <Field label="From">
            <AddressLink address={record.from} /> <span className="small muted">{hexToBech32(record.from)}</span>
          </Field>
          <Field label="To">
            <AddressLink address={record.to} />{" "}
            {record.to && <span className="small muted">{hexToBech32(record.to)}</span>}
          </Field>
          <Field label="Time">{formatUtc(record.time_utc)}</Field>
          <Field label="Shard">{shardText(record)}</Field>
          <Field label="Block">
            {record.block_number.toLocaleString("en-US")} <code className="small">{record.block_hash}</code>
          </Field>
          {record.trace_address !== null && <Field label="Call path">{record.trace_address}</Field>}
          {record.fee_atto !== null && <Field label="Fee">{one(record.fee_atto, 8)} ONE</Field>}
          <FunctionField record={record} />
          {record.input && (
            <Field label={creation ? "Contract code" : "Input data"}>
              <Calldata input={record.input} creation={creation} />
            </Field>
          )}
          {destination && <Field label="Destination">{destination}</Field>}
          {record.record_type === "cross_shard" && <Field label="Mechanism">{record.kind}</Field>}
          <Field label="Status">
            {record.status === "success" ? "Success" : record.record_type === "internal" ? "Reverted" : "Failed"}
            {record.branch === "rolled_back" ? " on a rolled-back block (never final)" : ""}
          </Field>
        </tbody>
      </table>
    </div>
  );
}

function TxHistory({ hash }: { hash: string }) {
  const query = useQuery({ queryKey: ["archive-tx", hash], queryFn: () => fetchArchiveTx(hash), retry: false, staleTime: 300_000 });
  if (query.isLoading) return <p className="muted">Loading…</p>;
  const error = errorText(query.error);
  if (error) return <p className="error">{error}</p>;
  const records = query.data?.records ?? [];
  const first = records[0];
  return (
    <>
      {first && (
        <p className="history-id">
          Transaction <code>{first.tx_hash}</code>
          {first.eth_hash && (
            <>
              <br />
              Ethereum-style hash <code>{first.eth_hash}</code>
            </>
          )}
        </p>
      )}
      {records.some((r) => r.branch === "rolled_back") && (
        <div className="banner warn">
          Part of this record comes from blocks that were rolled back in August 2026. Those transfers never became final.
        </div>
      )}
      {records.map((r) => (
        <RecordCard key={r.id} record={r} />
      ))}
    </>
  );
}

function Coverage({ meta }: { meta: ArchiveMetaResponse }) {
  if (!meta.available) return <span className="muted">The transaction archive has not been loaded yet.</span>;
  return (
    <>
      <span>
        Records of at least {meta.min_value_one ?? "?"} ONE: transactions, internal transfers, cross-shard receipts, and
        staking.
      </span>
      {meta.coverage.map((c) => (
        <span key={`${c.shard}-${c.branch}-${c.start_block}`}>
          Shard {c.shard} {c.branch === "rolled_back" ? "rolled-back blocks" : "blocks"} {c.start_block.toLocaleString("en-US")}–
          {c.end_block.toLocaleString("en-US")} ({formatUtc(c.start_time_utc)} to {formatUtc(c.end_time_utc)})
        </span>
      ))}
      {meta.notes.map((note) => (
        <span key={note} className="muted">
          {note}
        </span>
      ))}
      <span>
        Data version: {meta.data_version ?? "-"}
        {meta.fixture ? " (synthetic test data)" : ""}
      </span>
    </>
  );
}

export function HistoryPage({ path, search }: { path: string; search: string }) {
  const current: HistoryQuery | null = parseHistoryLocation(path, search);
  const [input, setInput] = useState(current?.value ?? "");
  const [inputError, setInputError] = useState<string | null>(
    isMalformedHistoryLocation(path, search) ? "That is not a valid address or transaction hash." : null,
  );
  const meta = useQuery({ queryKey: ["archive-meta"], queryFn: fetchArchiveMeta, staleTime: 300_000 });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseQuery(input);
    if (!parsed) {
      setInputError("Enter a 0x… or one1… address, or a 0x… transaction hash (64 hex digits).");
      return;
    }
    setInputError(null);
    navigate(historyPath(parsed));
  };

  return (
    <div className="page">
      <Nav current="/history" />
      <header className="header">
        <div>
          <h1>Harmony transaction history</h1>
          <p className="sub">
            A fixed record of Harmony transactions that moved at least 1 ONE from January 2025 until the chain stopped in
            September 2026, kept after the Harmony explorer shut down. It includes internal transfers made by contracts,
            transfers between shards, staking, and blocks that were later rolled back.
          </p>
        </div>
      </header>

      <section className="card">
        <form className="lookup" onSubmit={onSubmit}>
          <label htmlFor="history-query">Address (0x… or one1…) or transaction hash</label>
          <div className="row">
            <input
              id="history-query"
              name="q"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x… or one1…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit">Look up</button>
          </div>
          {inputError && <p className="error">{inputError}</p>}
        </form>
      </section>

      {current && (
        <section className="card">
          <h2>{current.type === "tx" ? "Transaction" : "Address"}</h2>
          {current.type === "tx" ? <TxHistory hash={current.value} /> : <AddressHistory address={current.value} />}
        </section>
      )}

      <footer className="footer">
        {meta.data ? <Coverage meta={meta.data} /> : <span className="muted">Loading archive coverage…</span>}
        <span className="muted">
          Amounts below 1 ONE are not archived. A transfer marked failed or reverted did not move its value.
        </span>
      </footer>
    </div>
  );
}
