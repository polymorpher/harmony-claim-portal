#!/usr/bin/env python3
"""Format the confirmed-wallets report from CSV extracts.

Run through db/ops/confirmed-wallets.sh, which pulls the five extracts from the
database. This file has no database code so it can be tested with fixtures.

Amounts are atto-ONE integers. Conversion to ONE mirrors shared/src/amount.ts:
exact decimal strings, truncated (never rounded) for display.

Review state (approval decision, wallet part sent, vault shares sent per
validator) is read from every row of confirm.reviews as review_tracks.py
describes.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_tracks as rt  # noqa: E402

ATTO_PER_ONE = 10**18

PREDATES = "wallet activity predates initial window"
NO_ACTIVITY = "no indexed wallet activity"
REASON_SHORT = {PREDATES: "predates window", NO_ACTIVITY: "no indexed activity"}

COMPONENT_LABELS = [
    ("liquid_shard0_atto", "liquid s0"),
    ("liquid_shard1_atto", "liquid s1"),
    ("pending_undelegation_atto", "pending undelegation"),
    ("unclaimed_staking_reward_atto", "unclaimed reward"),
    ("pending_cross_shard_atto", "cross-shard"),
    ("wone_balance_atto", "WONE balance"),
    ("wone_airdrop_atto", "WONE airdrop"),
]

CSV_COLUMNS = [
    "id",
    "confirmed_at_utc",
    "address",
    "signer",
    "signer_matches",
    "data_version",
    "policy_version",
    "stage_reason",
    "account_category",
    "still_candidate",
    "in_ledger",
    "ledger_stage",
    "issuance_treatment",
    "meets_threshold",
    "total_allocation_atto",
    "total_allocation_one",
    "wallet_allocation_atto",
    "wallet_allocation_one",
    "vault_shares_allocation_atto",
    "vault_shares_allocation_one",
    "liquid_shard0_one",
    "liquid_shard1_one",
    "pending_undelegation_one",
    "unclaimed_staking_reward_one",
    "pending_cross_shard_one",
    "wone_balance_one",
    "wone_airdrop_one",
    "native_wallet_airdrop_one",
    "wallet_airdrop_gross_one",
    "wallet_not_issued_one",
    "wallet_redistributed_one",
    "wallet_held_one",
    "wallet_net_one",
    "staked_to_vault_one",
    "vault_count",
    "vault_shares_breakdown",
    "qualification_total_one",
    "total_claim_one",
    "last_activity_utc",
    "last_activity_type",
    "decision",
    "decision_label",
    "decision_at_utc",
    "decision_note",
    "wallet_status",
    "wallet_sent_run",
    "wallet_sent_at_utc",
    "vault_status",
    "vault_positions_sent",
    "vault_positions_pending",
    "vault_pending_atto",
    "vault_pending_one",
    "vault_sent_runs",
    "signature",
    "signature_scheme",
    "message",
]

# vault-batch reads this file by column name (address, validator_address,
# expected_shares_atto); new columns must not reuse its candidate names such as
# amount_atto, delegator_address or destination_status.
VAULT_CSV_COLUMNS = [
    "address",
    "validator_address",
    "validator_name",
    "staked_atto",
    "staked_one",
    "not_issued_one",
    "redistributed_one",
    "held_one",
    "expected_shares_atto",
    "expected_shares_one",
    "is_self_delegation",
    "priority",
    "governor_status",
    "sent_status",
    "sent_run",
    "sent_at_utc",
]

DECISIONS = ("none", "approved", "rejected")
WALLET_FILTERS = ("pending", "sent")
VAULT_FILTERS = ("pending", "partial", "sent")


# ---------------------------------------------------------------- amounts


def to_int(value: Optional[str]) -> int:
    if value is None:
        return 0
    s = value.strip()
    if s == "":
        return 0
    return int(s)


def atto_to_one(atto: int, max_fraction: int = 18) -> str:
    """Exact ONE string, trailing zeros trimmed, fraction truncated to max_fraction."""
    negative = atto < 0
    abs_value = -atto if negative else atto
    whole, rem = divmod(abs_value, ATTO_PER_ONE)
    frac = str(rem).rjust(18, "0")[: max(0, min(18, max_fraction))].rstrip("0")
    return f"{'-' if negative else ''}{whole}{'.' + frac if frac else ''}"


def format_one(atto: int, max_fraction: int = 4) -> str:
    """Display form with thousands separators, e.g. 1,234.5678."""
    exact = atto_to_one(atto, max_fraction)
    whole, _, frac = exact.partition(".")
    sign = "-" if whole.startswith("-") else ""
    digits = whole[1:] if sign else whole
    grouped = f"{int(digits):,}"
    return f"{sign}{grouped}{'.' + frac if frac else ''}"


def percent(part: int, whole: int) -> str:
    if whole <= 0:
        return "n/a"
    value = (Decimal(part) / Decimal(whole)) * Decimal(100)
    return f"{value.quantize(Decimal('0.01'))}%"


def pg_bool(value: Optional[str]) -> Optional[bool]:
    if value is None or value == "":
        return None
    return value.strip().lower() in ("t", "true", "1", "yes")


def yes_no(value: Optional[bool], unknown: str = "-") -> str:
    if value is None:
        return unknown
    return "yes" if value else "no"


def display_time(iso: Optional[str]) -> str:
    """'2026-09-22T00:13:02Z' -> '2026-09-22 00:13:02 UTC'."""
    if not iso:
        return "-"
    return iso.replace("T", " ").replace("Z", " UTC")


# ---------------------------------------------------------------- loading


def read_rows(path: Optional[str]) -> List[Dict[str, str]]:
    if not path:
        return []
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


class Adjustments:
    """routing_exceptions split the way backend/src/claims.ts splitExceptions does."""

    def __init__(self) -> None:
        self.not_issued = 0
        self.redistributed = 0
        self.held = 0

    def add(self, status: str, amount: int) -> None:
        if status == "not_issuing":
            self.not_issued += amount
        elif status == "redistributed":
            self.redistributed += amount
        elif status == "hold":
            self.held += amount

    def net(self, gross: int) -> int:
        value = gross - self.not_issued - self.redistributed
        return value if value > 0 else 0

    def any(self) -> bool:
        return bool(self.not_issued or self.redistributed or self.held)


def index_exceptions(rows: Iterable[Dict[str, str]]):
    wallet: Dict[str, Adjustments] = defaultdict(Adjustments)
    vault: Dict[tuple, Adjustments] = defaultdict(Adjustments)
    for row in rows:
        address = row["address"].strip().lower()
        amount = to_int(row.get("amount_atto"))
        status = (row.get("destination_status") or "").strip()
        if row.get("component") == "wallet_airdrop":
            wallet[address].add(status, amount)
        elif row.get("component") == "vault_shares":
            validator = (row.get("validator_address") or "").strip().lower()
            vault[(address, validator)].add(status, amount)
    return wallet, vault


class VaultPosition:
    def __init__(self, row: Dict[str, str], adjustments: Adjustments) -> None:
        self.address = row["address"].strip().lower()
        self.validator_address = row["validator_address"].strip().lower()
        self.validator_name = (row.get("validator_name") or "").strip()
        self.staked = to_int(row.get("staked_to_vault_atto"))
        self.is_self = pg_bool(row.get("is_self_delegation")) or False
        self.priority = pg_bool(row.get("priority")) or False
        self.governor_status = (row.get("governor_status") or "").strip()
        self.adjustments = adjustments
        self.expected_shares = adjustments.net(self.staked)
        # "none" (nothing to send), "pending" or "sent"; set by apply_reviews.
        self.status = "none" if self.expected_shares <= 0 else "pending"
        self.sent: Optional[rt.Review] = None

    def csv_row(self) -> Dict[str, str]:
        return {
            "address": self.address,
            "validator_address": self.validator_address,
            "validator_name": self.validator_name,
            "staked_atto": str(self.staked),
            "staked_one": atto_to_one(self.staked),
            "not_issued_one": atto_to_one(self.adjustments.not_issued),
            "redistributed_one": atto_to_one(self.adjustments.redistributed),
            "held_one": atto_to_one(self.adjustments.held),
            "expected_shares_atto": str(self.expected_shares),
            "expected_shares_one": atto_to_one(self.expected_shares),
            "is_self_delegation": yes_no(self.is_self),
            "priority": yes_no(self.priority),
            "governor_status": self.governor_status,
            "sent_status": self.status,
            "sent_run": self.sent.run if self.sent else "",
            "sent_at_utc": self.sent.reviewed_at if self.sent else "",
        }


class Confirmation:
    def __init__(
        self,
        row: Dict[str, str],
        vaults: List[VaultPosition],
        wallet_adjustments: Adjustments,
    ) -> None:
        self.row = row
        self.id = row["id"].strip()
        self.address = row["address"].strip().lower()
        self.signer = (row.get("signer") or "").strip().lower()
        self.confirmed_at = (row.get("confirmed_at_utc") or "").strip()
        self.data_version = (row.get("data_version") or "").strip()
        self.policy_version = (row.get("policy_version") or "").strip()
        self.stage_reason = (row.get("stage_reason") or "").strip()
        self.signature = (row.get("signature") or "").strip()
        self.signature_scheme = (row.get("signature_scheme") or "").strip() or "personal_sign"
        self.message = row.get("message") or ""
        self.still_candidate = pg_bool(row.get("still_candidate"))
        self.in_ledger = pg_bool(row.get("in_ledger")) or False
        self.account_category = (row.get("account_category") or "").strip()
        self.meets_threshold = pg_bool(row.get("meets_threshold"))
        self.stage_policy_applied = pg_bool(row.get("stage_policy_applied")) or False
        self.ledger_stage = (row.get("migration_stage") or "").strip()
        self.issuance_treatment = (row.get("issuance_treatment") or "").strip()
        self.last_activity = (row.get("last_activity_utc") or "").strip()
        self.last_activity_type = (row.get("last_activity_type") or "").strip()
        self.vaults = vaults
        self.wallet_adjustments = wallet_adjustments

        def amt(key: str) -> int:
            return to_int(row.get(key))

        self.total_allocation = amt("migration_allocation_atto")
        self.wallet_allocation = amt("migration_wallet_allocation_atto")
        self.vault_allocation = amt("migration_staked_to_vault_atto")
        self.components = {key: amt(key) for key, _ in COMPONENT_LABELS}
        self.native_wallet_airdrop = amt("native_wallet_airdrop_atto")
        self.wallet_gross = amt("wallet_airdrop_atto")
        self.wallet_net = wallet_adjustments.net(self.wallet_gross)
        self.staked_to_vault = amt("staked_to_vault_atto")
        self.qualification_total = amt("qualification_total_atto")
        self.total_claim = amt("total_claim_atto")

        # Set by apply_reviews; without reviews every confirmation is undecided.
        self.decision = "none"
        self.decision_review: Optional[rt.Review] = None
        self.wallet_review: Optional[rt.Review] = None
        if not self.in_ledger:
            self.wallet_status = "unknown"
        elif self.wallet_allocation <= 0:
            self.wallet_status = "none"
        else:
            self.wallet_status = "pending"

    @property
    def signer_matches(self) -> bool:
        return self.signer == self.address

    def live_vaults(self) -> List[VaultPosition]:
        """Positions with shares to send."""
        return [v for v in self.vaults if v.status != "none"]

    @property
    def vault_status(self) -> str:
        """unknown, none (nothing to send), pending (none sent), partial, or sent."""
        if not self.in_ledger:
            return "unknown"
        live = self.live_vaults()
        if not live:
            return "none"
        sent = sum(1 for v in live if v.status == "sent")
        if sent == 0:
            return "pending"
        return "sent" if sent == len(live) else "partial"

    def sent_runs(self) -> Set[str]:
        runs = {v.sent.run for v in self.vaults if v.sent}
        if self.wallet_review:
            runs.add(self.wallet_review.run)
        return runs

    def vault_pending_amount(self) -> int:
        return sum(v.expected_shares for v in self.live_vaults() if v.status == "pending")

    def review_text(self) -> str:
        r = self.decision_review
        if self.decision == "none":
            decision = "not reviewed"
        else:
            bits = [b for b in (r.label if r else "", display_time(r.reviewed_at) if r else "") if b]
            decision = self.decision + (f" ({', '.join(bits)})" if bits else "")
            if self.decision == "rejected" and r and r.note:
                decision += f": {r.note}"
        wallet = {
            "unknown": "wallet unknown",
            "none": "wallet nothing to send",
            "pending": "wallet pending",
        }.get(self.wallet_status, "")
        if self.wallet_status == "sent" and self.wallet_review:
            wallet = f"wallet sent by {self.wallet_review.run}"
        live = self.live_vaults()
        status = self.vault_status
        if status == "unknown":
            vault = "vault unknown"
        elif status == "none":
            vault = "vault nothing to send"
        else:
            sent = sum(1 for v in live if v.status == "sent")
            vault = f"vault {sent} of {len(live)} sent"
        return " | ".join((decision, wallet, vault))

    def vault_breakdown_text(self) -> str:
        return ";".join(
            f"{v.validator_address}={atto_to_one(v.expected_shares)}" for v in self.vaults
        )

    def csv_row(self) -> Dict[str, str]:
        one = atto_to_one
        return {
            "id": self.id,
            "confirmed_at_utc": self.confirmed_at,
            "address": self.address,
            "signer": self.signer,
            "signer_matches": yes_no(self.signer_matches),
            "data_version": self.data_version,
            "policy_version": self.policy_version,
            "stage_reason": self.stage_reason,
            "account_category": self.account_category,
            "still_candidate": yes_no(self.still_candidate),
            "in_ledger": yes_no(self.in_ledger),
            "ledger_stage": self.ledger_stage,
            "issuance_treatment": self.issuance_treatment,
            "meets_threshold": yes_no(self.meets_threshold),
            "total_allocation_atto": str(self.total_allocation),
            "total_allocation_one": one(self.total_allocation),
            "wallet_allocation_atto": str(self.wallet_allocation),
            "wallet_allocation_one": one(self.wallet_allocation),
            "vault_shares_allocation_atto": str(self.vault_allocation),
            "vault_shares_allocation_one": one(self.vault_allocation),
            "liquid_shard0_one": one(self.components["liquid_shard0_atto"]),
            "liquid_shard1_one": one(self.components["liquid_shard1_atto"]),
            "pending_undelegation_one": one(self.components["pending_undelegation_atto"]),
            "unclaimed_staking_reward_one": one(self.components["unclaimed_staking_reward_atto"]),
            "pending_cross_shard_one": one(self.components["pending_cross_shard_atto"]),
            "wone_balance_one": one(self.components["wone_balance_atto"]),
            "wone_airdrop_one": one(self.components["wone_airdrop_atto"]),
            "native_wallet_airdrop_one": one(self.native_wallet_airdrop),
            "wallet_airdrop_gross_one": one(self.wallet_gross),
            "wallet_not_issued_one": one(self.wallet_adjustments.not_issued),
            "wallet_redistributed_one": one(self.wallet_adjustments.redistributed),
            "wallet_held_one": one(self.wallet_adjustments.held),
            "wallet_net_one": one(self.wallet_net),
            "staked_to_vault_one": one(self.staked_to_vault),
            "vault_count": str(len(self.vaults)),
            "vault_shares_breakdown": self.vault_breakdown_text(),
            "qualification_total_one": one(self.qualification_total),
            "total_claim_one": one(self.total_claim),
            "last_activity_utc": self.last_activity,
            "last_activity_type": self.last_activity_type,
            "decision": self.decision,
            "decision_label": self.decision_review.label if self.decision_review else "",
            "decision_at_utc": self.decision_review.reviewed_at if self.decision_review else "",
            "decision_note": self.decision_review.note if self.decision_review else "",
            "wallet_status": self.wallet_status,
            "wallet_sent_run": self.wallet_review.run if self.wallet_review else "",
            "wallet_sent_at_utc": self.wallet_review.reviewed_at if self.wallet_review else "",
            "vault_status": self.vault_status,
            "vault_positions_sent": str(sum(1 for v in self.vaults if v.status == "sent")),
            "vault_positions_pending": str(sum(1 for v in self.vaults if v.status == "pending")),
            "vault_pending_atto": str(self.vault_pending_amount()),
            "vault_pending_one": one(self.vault_pending_amount()),
            "vault_sent_runs": ";".join(sorted({v.sent.run for v in self.vaults if v.sent})),
            "signature": self.signature,
            "signature_scheme": self.signature_scheme,
            "message": self.message,
        }


def build(
    confirmation_rows: List[Dict[str, str]],
    vault_rows: List[Dict[str, str]],
    exception_rows: List[Dict[str, str]],
) -> List[Confirmation]:
    wallet_adj, vault_adj = index_exceptions(exception_rows)
    by_address: Dict[str, List[VaultPosition]] = defaultdict(list)
    for row in vault_rows:
        address = row["address"].strip().lower()
        validator = row["validator_address"].strip().lower()
        by_address[address].append(VaultPosition(row, vault_adj[(address, validator)]))
    out = []
    for row in confirmation_rows:
        address = row["address"].strip().lower()
        out.append(Confirmation(row, by_address.get(address, []), wallet_adj[address]))
    return out


def apply_reviews(items: List[Confirmation], state: rt.ReviewState) -> None:
    for c in items:
        c.decision, c.decision_review = state.decision_of(c.id)
        if c.wallet_status in ("pending", "sent"):
            c.wallet_review = state.wallet_sent(c.address)
            c.wallet_status = "sent" if c.wallet_review else "pending"
        for v in c.vaults:
            if v.status == "none":
                continue
            v.sent = state.vault_sent(c.address, v.validator_address)
            v.status = "sent" if v.sent else "pending"


def select(
    items: List[Confirmation],
    decision: Optional[str] = None,
    wallet: Optional[str] = None,
    vault: Optional[str] = None,
    runs: Iterable[str] = (),
) -> List[Confirmation]:
    wanted_runs = set(runs)
    out = []
    for c in items:
        if decision and c.decision != decision:
            continue
        if wallet and c.wallet_status != wallet:
            continue
        if vault == "pending" and c.vault_status not in ("pending", "partial"):
            continue
        if vault in ("partial", "sent") and c.vault_status != vault:
            continue
        if wanted_runs and not (wanted_runs & c.sent_runs()):
            continue
        out.append(c)
    return out


def vault_rows(items: List[Confirmation], vault: Optional[str]) -> List[VaultPosition]:
    """Positions for the vault-shares CSV, once per wallet and validator even when a
    wallet signed under two data versions; only those still to send under
    --vault pending|partial."""
    seen, out = set(), []
    for c in items:
        for v in c.vaults:
            key = (v.address, v.validator_address)
            if key in seen or (vault in ("pending", "partial") and v.status != "pending"):
                continue
            seen.add(key)
            out.append(v)
    return out


# ---------------------------------------------------------------- stats


STATUS_ORDER = ("pending", "partial", "sent", "none", "unknown")
STATUS_WORDS = {"none": "nothing to send"}


class Stats:
    def __init__(
        self,
        items: List[Confirmation],
        candidate_rows: List[Dict[str, str]],
        state: Optional[rt.ReviewState] = None,
    ) -> None:
        self.rows = len(items)
        self.addresses = {c.address for c in items}
        self.wallets = len(self.addresses)
        self.by_reason = Counter(c.stage_reason for c in items)
        self.by_category = Counter(c.account_category or "unknown" for c in items)
        self.by_version = Counter(f"{c.data_version} / {c.policy_version}" for c in items)
        self.still_candidate = sum(1 for c in items if c.still_candidate)
        self.in_ledger = sum(1 for c in items if c.in_ledger)
        self.signer_mismatch = sum(1 for c in items if not c.signer_matches)
        self.not_deferred = sum(1 for c in items if c.in_ledger and c.ledger_stage != "deferred")
        self.decisions = Counter(c.decision for c in items)
        times = sorted(c.confirmed_at for c in items if c.confirmed_at)
        self.first = times[0] if times else ""
        self.last = times[-1] if times else ""

        # Amounts are per distinct wallet: the same wallet can sign under two
        # data versions and must not be counted twice.
        latest: Dict[str, Confirmation] = {}
        for c in items:
            latest[c.address] = c
        self.total_allocation = sum(c.total_allocation for c in latest.values())
        self.wallet_allocation = sum(c.wallet_allocation for c in latest.values())
        self.vault_allocation = sum(c.vault_allocation for c in latest.values())
        self.wallets_with_vaults = sum(1 for c in latest.values() if c.vaults)
        self.vault_positions = sum(len(c.vaults) for c in latest.values())
        # Sent state belongs to the address, so these count each wallet once too.
        self.wallet_count: Counter = Counter()
        self.wallet_amount: Counter = Counter()
        self.position_count: Counter = Counter()
        self.position_amount: Counter = Counter()
        for c in latest.values():
            self.wallet_count[c.wallet_status] += 1
            self.wallet_amount[c.wallet_status] += c.wallet_allocation
            for v in c.vaults:
                self.position_count[v.status] += 1
                self.position_amount[v.status] += v.expected_shares

        self.unrecognised_reviews = len(state.unrecognised) if state else 0
        self.approvals_as_included = state.approvals_stored_as_included() if state else 0

        self.candidate_sets = []
        for row in candidate_rows:
            self.candidate_sets.append(
                {
                    "data_version": row.get("data_version", ""),
                    "policy_version": row.get("policy_version", ""),
                    "cutoff_utc": row.get("cutoff_utc", ""),
                    "count": to_int(row.get("candidates")),
                    "predates": to_int(row.get("candidates_predates_window")),
                    "no_activity": to_int(row.get("candidates_no_activity")),
                    "allocation": to_int(row.get("candidates_allocation_atto")),
                    "wallet": to_int(row.get("candidates_wallet_allocation_atto")),
                    "vault": to_int(row.get("candidates_staked_to_vault_atto")),
                }
            )
        self.candidates = sum(s["count"] for s in self.candidate_sets)
        self.candidate_allocation = sum(s["allocation"] for s in self.candidate_sets)


# ---------------------------------------------------------------- rendering


def render_header(
    generated: datetime,
    source: str,
    ledger_version: str,
    stats: Stats,
    filters: str = "",
    total_rows: Optional[int] = None,
) -> List[str]:
    local = generated.astimezone()
    lines = [
        "Confirmed wallets",
        f"  generated    {generated.strftime('%Y-%m-%d %H:%M:%S')} UTC"
        f"  ({local.strftime('%Y-%m-%d %H:%M:%S %Z')})",
    ]
    if source:
        lines.append(f"  source       {source}")
    lines.append(f"  ledger       data_version {ledger_version or '<missing>'}")
    if stats.candidate_sets:
        for s in stats.candidate_sets:
            lines.append(
                f"  candidates   {s['count']:,} ({s['data_version']} / {s['policy_version']}, "
                f"cutoff {display_time(s['cutoff_utc'])}): "
                f"{s['predates']:,} predates window, {s['no_activity']:,} no indexed activity, "
                f"{format_one(s['allocation'])} ONE"
            )
    else:
        lines.append("  candidates   none loaded")
    if filters:
        shown = f" (showing {stats.rows:,} of {total_rows:,} confirmations)" if total_rows is not None else ""
        lines.append(f"  filters      {filters}{shown}")
    return lines


def render_record(index: int, c: Confirmation) -> List[str]:
    pad = " " * 5
    lines = [f"#{index:<4d}{c.address}   {display_time(c.confirmed_at)}"]
    reason_bits = [c.stage_reason or "-"]
    if c.account_category:
        reason_bits.append(c.account_category)
    reason_bits.append(f"candidate: {yes_no(c.still_candidate, 'unknown')}")
    lines.append(f"{pad}reason        {' | '.join(reason_bits)}")
    lines.append(f"{pad}id            {c.id}")
    lines.append(f"{pad}review        {c.review_text()}")
    lines.append(f"{pad}versions      data {c.data_version} | policy {c.policy_version}")

    if not c.in_ledger:
        lines.append(f"{pad}allocation    unknown: address is not in the loaded ledger")
    else:
        stage_note = ""
        if c.ledger_stage != "deferred":
            stage_note = f"   [ledger stage: {c.ledger_stage or 'none'}]"
        lines.append(
            f"{pad}allocation    {format_one(c.total_allocation)} ONE not in initial airdrop"
            f"  =  wallet {format_one(c.wallet_allocation)}"
            f"  +  vault shares {format_one(c.vault_allocation)}{stage_note}"
        )
        comps = " | ".join(f"{label} {format_one(c.components[key])}" for key, label in COMPONENT_LABELS)
        lines.append(f"{pad}components    {comps}")
        wallet_line = f"{pad}wallet        gross {format_one(c.wallet_gross)}"
        if c.wallet_adjustments.any():
            adj = c.wallet_adjustments
            parts = []
            if adj.not_issued:
                parts.append(f"not issued -{format_one(adj.not_issued)}")
            if adj.redistributed:
                parts.append(f"redistributed -{format_one(adj.redistributed)}")
            if adj.held:
                parts.append(f"held {format_one(adj.held)}")
            wallet_line += f" | {' | '.join(parts)} | net {format_one(c.wallet_net)}"
        lines.append(wallet_line)
        if c.vaults:
            lines.append(
                f"{pad}vault shares  {format_one(c.staked_to_vault)} ONE staked across "
                f"{len(c.vaults)} vault{'s' if len(c.vaults) != 1 else ''}"
            )
            for v in c.vaults:
                extra = []
                if v.is_self:
                    extra.append("self")
                if v.priority:
                    extra.append("priority")
                if v.adjustments.any():
                    extra.append(f"shares {format_one(v.expected_shares)}")
                if v.sent:
                    extra.append(f"sent by {v.sent.run}")
                name = f"  {v.validator_name}" if v.validator_name else ""
                tail = f"  ({', '.join(extra)})" if extra else ""
                lines.append(f"{pad}              {format_one(v.staked):>14} ONE  {v.validator_address}{name}{tail}")
        else:
            lines.append(f"{pad}vault shares  none")
        activity = display_time(c.last_activity) if c.last_activity else "none indexed"
        if c.last_activity_type:
            activity += f" ({c.last_activity_type})"
        lines.append(f"{pad}last activity {activity}")

    signer_note = "matches address" if c.signer_matches else "DOES NOT MATCH ADDRESS"
    lines.append(f"{pad}signer        {c.signer or '-'} ({signer_note})")
    lines.append(f"{pad}signature     {c.signature}")
    lines.append(f"{pad}signed with   {c.signature_scheme}")
    return lines


def render_compact(items: List[Confirmation]) -> List[str]:
    header = (
        f"{'id':>6}  {'confirmed (UTC)':<19}  {'address':<42}  {'reason':<19}  "
        f"{'total ONE':>18}  {'wallet ONE':>18}  {'vault ONE':>14}  {'cand':<4}  "
        f"{'decision':<8}  {'wallet':<7}  {'vault':<7}  signature"
    )
    lines = [header, "-" * len(header)]
    short = {"none": "-", "unknown": "?"}
    for c in items:
        sig = f"{c.signature[:10]}…{c.signature[-8:]}" if len(c.signature) > 20 else c.signature
        confirmed = c.confirmed_at.replace("T", " ").replace("Z", "")
        lines.append(
            f"{c.id:>6}  {confirmed:<19}  {c.address:<42}  {REASON_SHORT.get(c.stage_reason, c.stage_reason)[:19]:<19}  "
            f"{format_one(c.total_allocation) if c.in_ledger else '-':>18}  "
            f"{format_one(c.wallet_allocation) if c.in_ledger else '-':>18}  "
            f"{format_one(c.vault_allocation) if c.in_ledger else '-':>14}  "
            f"{yes_no(c.still_candidate, '?'):<4}  {c.decision:<8}  "
            f"{short.get(c.wallet_status, c.wallet_status):<7}  {short.get(c.vault_status, c.vault_status):<7}  {sig}"
        )
    return lines


def status_counts(counts: Counter, amounts: Counter, unit: str) -> str:
    parts = []
    for status in STATUS_ORDER:
        if not counts[status]:
            continue
        word = STATUS_WORDS.get(status, status)
        n = counts[status]
        if status in ("none", "unknown"):
            parts.append(f"{word} {n:,}")
        else:
            parts.append(f"{word} {n:,} {unit}{'s' if n != 1 else ''} ({format_one(amounts[status])} ONE)")
    return " | ".join(parts) or "none"


def render_stats(stats: Stats) -> List[str]:
    lines = ["Summary"]
    multi = stats.rows - stats.wallets
    wallets_note = f" ({multi} repeat signature{'s' if multi != 1 else ''} under another data version)" if multi else ""
    lines.append(f"  confirmations           {stats.rows:,} from {stats.wallets:,} wallet{'s' if stats.wallets != 1 else ''}{wallets_note}")
    if stats.rows == 0:
        return lines
    lines.append(
        "  by reason               "
        + " | ".join(f"{REASON_SHORT.get(k, k)} {v:,}" for k, v in stats.by_reason.most_common())
    )
    lines.append("  by category             " + " | ".join(f"{k} {v:,}" for k, v in stats.by_category.most_common()))
    lines.append("  by version              " + " | ".join(f"{k}: {v:,}" for k, v in stats.by_version.most_common()))
    superseded = stats.rows - stats.still_candidate
    superseded_note = f"   ({superseded} signed under a superseded candidate set)" if superseded else ""
    lines.append(f"  still candidates        {stats.still_candidate:,} / {stats.rows:,}{superseded_note}")
    ledger_note = "" if stats.in_ledger == stats.rows else f"   ({stats.rows - stats.in_ledger} not found in ledger)"
    lines.append(f"  in ledger               {stats.in_ledger:,} / {stats.rows:,}{ledger_note}")
    if stats.not_deferred:
        lines.append(f"  ledger stage changed    {stats.not_deferred:,} wallet(s) no longer 'deferred' in the loaded ledger")
    lines.append(
        "  decisions               "
        + " | ".join(f"{k} {stats.decisions[k]:,}" for k in DECISIONS if stats.decisions[k])
    )
    lines.append("  wallet part             " + status_counts(stats.wallet_count, stats.wallet_amount, "wallet"))
    if stats.vault_positions:
        lines.append("  vault shares            " + status_counts(stats.position_count, stats.position_amount, "position"))
    if stats.approvals_as_included:
        lines.append(
            f"  note                    {stats.approvals_as_included:,} approval(s) are stored as 'included' without "
            "wallet:/vault:; they are not counted as sent"
        )
    if stats.unrecognised_reviews:
        lines.append(
            f"  ignored review rows     {stats.unrecognised_reviews:,} row(s) with a wallet:/vault: batch id or status "
            "that does not parse (see db/ops/review_tracks.py)"
        )
    lines.append(f"  signer mismatch         {stats.signer_mismatch:,}")
    lines.append(f"  first / last            {display_time(stats.first)}  /  {display_time(stats.last)}")
    lines.append(
        f"  confirmed allocation    {format_one(stats.total_allocation)} ONE"
        f"  =  wallet {format_one(stats.wallet_allocation)}"
        f"  +  vault shares {format_one(stats.vault_allocation)}"
    )
    lines.append(
        f"  vault positions         {stats.vault_positions:,} across {stats.wallets_with_vaults:,} wallet"
        f"{'s' if stats.wallets_with_vaults != 1 else ''}"
    )
    if stats.candidates:
        lines.append(
            f"  share of candidates     wallets {percent(stats.wallets, stats.candidates)} of {stats.candidates:,}"
            f"  |  allocation {percent(stats.total_allocation, stats.candidate_allocation)} of "
            f"{format_one(stats.candidate_allocation)} ONE"
        )
    return lines


# ---------------------------------------------------------------- csv output


def write_csv(path: Path, columns: List[str], rows: Iterable[Dict[str, str]]) -> int:
    count = 0
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
            count += 1
    return count


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def filter_pairs(args: argparse.Namespace) -> List[tuple]:
    pairs = [(name, getattr(args, name)) for name in ("decision", "wallet", "vault") if getattr(args, name)]
    pairs += [("run", run) for run in args.run]
    return pairs


def export_csv(
    items: List[Confirmation],
    out_dir: Path,
    generated: datetime,
    filters: Iterable[tuple] = (),
    vault: Optional[str] = None,
) -> List[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = generated.strftime("%Y%m%dT%H%M%SZ")
    # A filtered export says so in its name, so it is not mistaken for the full list.
    suffix = "".join(f"-{name}-{value}" for name, value in filters)
    main = out_dir / f"confirmed-wallets-{stamp}{suffix}.csv"
    vaults = out_dir / f"confirmed-wallets-{stamp}{suffix}-vault-shares.csv"
    main_rows = write_csv(main, CSV_COLUMNS, (c.csv_row() for c in items))
    position_rows = write_csv(vaults, VAULT_CSV_COLUMNS, (v.csv_row() for v in vault_rows(items, vault)))
    which = "still to send, " if vault in ("pending", "partial") else ""
    return [
        "CSV",
        f"  {main}",
        f"      {main_rows:,} row{'s' if main_rows != 1 else ''}, sha256 {sha256_of(main)}",
        f"  {vaults}",
        f"      {position_rows:,} row{'s' if position_rows != 1 else ''} ({which}one per wallet and validator), "
        f"sha256 {sha256_of(vaults)}",
    ]


# ---------------------------------------------------------------- main


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--confirmations", required=True, help="CSV extract of confirm.confirmations joined to the ledger")
    parser.add_argument("--vault-shares", help="CSV extract of delegations for confirmed addresses")
    parser.add_argument("--exceptions", help="CSV extract of routing_exceptions for confirmed addresses")
    parser.add_argument("--candidates", help="CSV extract of confirm.candidates totals per version")
    parser.add_argument("--reviews", help="CSV extract of every confirm.reviews row, in (reviewed_at, id) order")
    parser.add_argument("--decision", choices=DECISIONS, help="only confirmations with this approval decision")
    parser.add_argument("--wallet", choices=WALLET_FILTERS, help="only wallets whose wallet part is pending or sent")
    parser.add_argument("--vault", choices=VAULT_FILTERS,
                        help="pending: some vault shares still to send (includes partial); partial; sent: all sent")
    parser.add_argument("--run", action="append", default=[],
                        help="only wallets with a wallet part or vault shares marked sent by this run (repeatable)")
    parser.add_argument("--ledger-data-version", default="", help="snapshot_meta.data_version of the loaded ledger")
    parser.add_argument("--source", default="", help="database label for the header (no credentials)")
    parser.add_argument("--csv", action="store_true", help="also write CSV files under --out-dir")
    parser.add_argument("--out-dir", default="data/confirmed-wallets", help="directory for --csv output")
    parser.add_argument("--compact", action="store_true", help="one line per confirmation instead of full records")
    parser.add_argument("--generated-at", help="override the report timestamp (ISO 8601 UTC), for tests")
    args = parser.parse_args(argv)
    for run in args.run:
        try:
            rt.check_name(run, "--run")
        except rt.ReviewError as exc:
            parser.error(str(exc))
    return args


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.generated_at:
        generated = datetime.fromisoformat(args.generated_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    else:
        generated = datetime.now(timezone.utc)

    everything = build(read_rows(args.confirmations), read_rows(args.vault_shares), read_rows(args.exceptions))
    state = rt.ReviewState(read_rows(args.reviews))
    apply_reviews(everything, state)
    filters = filter_pairs(args)
    items = select(everything, args.decision, args.wallet, args.vault, args.run)
    stats = Stats(items, read_rows(args.candidates), state)

    out: List[str] = []
    filter_text = ", ".join(f"{name} {value}" for name, value in filters)
    out.extend(render_header(generated, args.source, args.ledger_data_version, stats, filter_text, len(everything)))
    out.append("")
    if not items:
        out.append("No confirmations match these filters." if filters and everything else "No confirmations recorded.")
    elif args.compact:
        out.extend(render_compact(items))
    else:
        for index, c in enumerate(items, start=1):
            out.extend(render_record(index, c))
            out.append("")
    out.append("")
    out.extend(render_stats(stats))
    if args.csv:
        out.append("")
        out.extend(export_csv(items, Path(args.out_dir), generated, filters, args.vault))
    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
