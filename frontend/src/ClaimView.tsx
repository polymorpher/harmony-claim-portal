import type { Adjustment, ClaimResponse, VaultPosition } from "@hcp/shared";
import { formatUtc, one, shortAddress } from "./format";

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  hold: "On hold",
  not_issuing: "Not issued",
  none: "-",
};

function Banner({ claim }: { claim: ClaimResponse }) {
  if (!claim.found) {
    return (
      <div className="banner neutral">
        <strong>No claim recorded.</strong> This address had no balance, stake or pending amount at the cutoff.
      </div>
    );
  }
  if (claim.account_type === "contract") {
    return (
      <div className="banner warn">
        <strong>Smart contract{claim.contract_category ? ` (${claim.contract_category})` : ""}.</strong> Contract
        accounts are handled in a later phase through a class-specific recovery process. Nothing is sent to the
        contract address automatically.
      </div>
    );
  }
  const e = claim.eligibility;
  if (!e) return null;
  if (!e.meets_threshold) {
    return (
      <div className="banner warn">
        <strong>Deferred.</strong> Total claim {one(e.total_claim_atto)} ONE is below the {one(claim.meta.threshold_atto, 0)} ONE
        threshold, so it is not part of the prioritized distribution.
      </div>
    );
  }
  return (
    <div className="banner ok">
      <strong>Prioritized.</strong> Gross claim {one(e.total_claim_atto)} ONE at the cutoff.
    </div>
  );
}

function AddressBlock({ claim }: { claim: ClaimResponse }) {
  return (
    <dl className="addr">
      <dt>Address</dt>
      <dd>
        <code>{claim.address.checksum}</code>
      </dd>
      <dt>Harmony format</dt>
      <dd>
        <code>{claim.address.bech32}</code>
      </dd>
      {claim.account_type && (
        <>
          <dt>Account type</dt>
          <dd>{claim.account_type.replace(/_/g, " ")}</dd>
        </>
      )}
    </dl>
  );
}

function Wallet({ claim }: { claim: ClaimResponse }) {
  const w = claim.wallet_airdrop;
  const c = claim.components;
  if (!w || !c) return null;
  const walletDeductions = claim.adjustments.filter((a) => a.component === "wallet_airdrop" && a.kind !== "same_address");
  return (
    <div className="block">
      <h3>Wallet airdrop (ERC-20 ONE)</h3>
      <table>
        <tbody>
          <tr>
            <td>Liquid balance, shard 0</td>
            <td className="num">{one(c.liquid_shard0_atto)}</td>
          </tr>
          <tr>
            <td>Liquid balance, shard 1</td>
            <td className="num">{one(c.liquid_shard1_atto)}</td>
          </tr>
          <tr>
            <td>Pending undelegation</td>
            <td className="num">{one(c.pending_undelegation_atto)}</td>
          </tr>
          <tr>
            <td>Unclaimed staking reward</td>
            <td className="num">{one(c.unclaimed_staking_reward_atto)}</td>
          </tr>
          <tr>
            <td>Pending cross-shard transfers</td>
            <td className="num">{one(c.pending_cross_shard_atto)}</td>
          </tr>
          <tr className="total">
            <td>Gross wallet airdrop</td>
            <td className="num">{one(w.gross_atto)}</td>
          </tr>
          {walletDeductions.map((a, i) => (
            <tr key={i} className={a.kind === "deduction" ? "deduction" : "hold"}>
              <td>
                {a.title}
                <div className="small">{a.user_text}</div>
              </td>
              <td className="num">{a.kind === "deduction" ? "−" : ""}{one(a.amount_atto)}</td>
            </tr>
          ))}
          <tr className="total">
            <td>Issuable now</td>
            <td className="num">{one(w.issuable_atto)}</td>
          </tr>
          <tr>
            <td>Destination</td>
            <td className="num">
              {w.destination.address ? (
                <code title={w.destination.address}>{shortAddress(w.destination.address)}</code>
              ) : (
                STATUS_LABEL[w.destination.status]
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Vaults({ positions }: { positions: VaultPosition[] }) {
  if (positions.length === 0) return null;
  return (
    <div className="block">
      <h3>Validator vault shares (ERC-4626)</h3>
      <p className="small">
        Active stake becomes shares in the validator's vault, 1:1 with the net principal at vault seeding.
      </p>
      <table>
        <thead>
          <tr>
            <th>Validator</th>
            <th className="num">Principal</th>
            <th className="num">Not issued</th>
            <th className="num">On hold</th>
            <th className="num">Expected shares</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.validator.hex}>
              <td>
                <div>{p.validator_name ?? shortAddress(p.validator.checksum)}</div>
                <div className="small">
                  <code>{p.validator.bech32}</code>
                  {p.is_self_delegation ? " · self-stake" : ""}
                  {p.vault && p.vault.governor_status !== "ready" ? " · governor on hold" : ""}
                </div>
              </td>
              <td className="num">{one(p.staked_atto)}</td>
              <td className="num">{one(p.not_issued_atto)}</td>
              <td className="num">{one(p.held_atto)}</td>
              <td className="num">{one(p.expected_shares_atto)}</td>
              <td>
                {STATUS_LABEL[p.status]}
                {!p.priority ? <div className="small">deferred</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Adjustments({ adjustments }: { adjustments: Adjustment[] }) {
  const relevant = adjustments.filter((a) => a.kind !== "same_address");
  if (relevant.length === 0) return null;
  return (
    <div className="block">
      <h3>Adjustments</h3>
      <ul className="adjustments">
        {relevant.map((a, i) => (
          <li key={i} className={a.kind}>
            <div className="adj-head">
              <span>{a.title}</span>
              <span className="num">
                {a.kind === "deduction" ? "−" : ""}
                {one(a.amount_atto)} ONE
              </span>
            </div>
            <div className="small">
              {a.user_text}
              {a.component === "vault_shares" && a.validator_address ? ` (vault of ${shortAddress(a.validator_address)})` : ""}
              {a.evidence ? ` Evidence: ${a.evidence}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ClaimView({ claim }: { claim: ClaimResponse }) {
  return (
    <div className="claim">
      <Banner claim={claim} />
      <AddressBlock claim={claim} />
      {claim.found && claim.eligibility && (
        <div className="summary">
          <div>
            <span className="label">Gross total claim</span>
            <span className="big">{one(claim.eligibility.total_claim_atto)} ONE</span>
          </div>
          <div>
            <span className="label">Wallet airdrop</span>
            <span className="big">{one(claim.wallet_airdrop?.gross_atto)} ONE</span>
          </div>
          <div>
            <span className="label">Staked to vaults</span>
            <span className="big">{one(claim.components?.staked_to_vault_atto)} ONE</span>
          </div>
        </div>
      )}
      <Wallet claim={claim} />
      <Vaults positions={claim.vault_positions} />
      <Adjustments adjustments={claim.adjustments} />
      {claim.notes.length > 0 && (
        <div className="block">
          <h3>Notes</h3>
          <ul className="notes">
            {claim.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {claim.last_activity && (
        <p className="small muted">
          Last activity before cutoff: {formatUtc(claim.last_activity.time_utc)}
          {claim.last_activity.block ? `, block ${claim.last_activity.block.toLocaleString()}` : ""}
          {claim.last_activity.shard !== null ? ` on shard ${claim.last_activity.shard}` : ""}
        </p>
      )}
    </div>
  );
}
