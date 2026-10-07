"""How the db/ops tools read and write confirm.reviews.

Each row of confirm.reviews has one status and one free-text batch_id. The
tools give batch_id one of three shapes:

  wallet:<run>               the wallet part was sent by run <run>
  vault:<run>:<validator>    the vault shares with <validator> were sent by run <run>
  anything else, or empty    an approval decision; the text is an optional label

<run> is the name of a safe-batch or vault-batch run directory. Rows must be
read in (reviewed_at, id) order, which is how db/ops/owner-db.sh extracts
them; within each track the later row wins. A decision row with status queued
means approved and rejected means rejected. A wallet or vault row with status
included means sent; queued means that mark was undone.

Sent state belongs to the address, across all of its confirmations, so a
wallet that signs again under a new data version still shows as paid.

Rows that fit none of these shapes (a wallet: or vault: id that does not
parse, or a status the track does not use) are listed and otherwise ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Set, Tuple

RUN_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")
MANIFEST_NOTE = re.compile(r"^manifest=([0-9a-f]{64})(?:;|$)")

DECISION, WALLET, VAULT, UNRECOGNISED = "decision", "wallet", "vault", "unrecognised"
DECISION_STATUSES = ("queued", "included", "rejected")
PART_STATUSES = ("included", "queued")


class ReviewError(ValueError):
    pass


def check_name(name: str, what: str) -> str:
    if not RUN_NAME.match(name or ""):
        raise ReviewError(
            f"{what} {name!r} must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit"
        )
    return name


def wallet_batch_id(run: str) -> str:
    return f"wallet:{check_name(run, 'run name')}"


def vault_batch_id(run: str, validator: str) -> str:
    v = validator.strip().lower()
    if not ADDRESS.match(v):
        raise ReviewError(f"validator {validator!r} is not a 0x address")
    return f"vault:{check_name(run, 'run name')}:{v}"


def manifest_note(sha256: str, note: str = "") -> str:
    return f"manifest={sha256}" + (f"; {note}" if note else "")


def note_manifest(note: str) -> Optional[str]:
    match = MANIFEST_NOTE.match(note or "")
    return match.group(1) if match else None


@dataclass
class Review:
    id: int
    confirmation_id: str
    address: str
    status: str
    batch_id: str
    note: str
    reviewed_at: str
    track: str = DECISION
    run: str = ""
    validator: str = ""

    @property
    def label(self) -> str:
        return self.batch_id if self.track == DECISION else ""

    @property
    def manifest(self) -> Optional[str]:
        return note_manifest(self.note)


def classify(row: Dict[str, str]) -> Review:
    batch = (row.get("batch_id") or "").strip()
    review = Review(
        id=int((row.get("id") or "0").strip() or 0),
        confirmation_id=(row.get("confirmation_id") or "").strip(),
        address=(row.get("address") or "").strip().lower(),
        status=(row.get("status") or "").strip(),
        batch_id=batch,
        note=row.get("note") or "",
        reviewed_at=(row.get("reviewed_at_utc") or "").strip(),
    )
    if batch.startswith("wallet:"):
        run = batch[len("wallet:"):]
        if RUN_NAME.match(run) and review.status in PART_STATUSES:
            review.track, review.run = WALLET, run
        else:
            review.track = UNRECOGNISED
    elif batch.startswith("vault:"):
        parts = batch.split(":")
        validator = parts[2].lower() if len(parts) == 3 else ""
        if len(parts) == 3 and RUN_NAME.match(parts[1]) and ADDRESS.match(validator) and review.status in PART_STATUSES:
            review.track, review.run, review.validator = VAULT, parts[1], validator
        else:
            review.track = UNRECOGNISED
    elif review.status not in DECISION_STATUSES:
        review.track = UNRECOGNISED
    return review


class ReviewState:
    """The latest row of each track, from every row of confirm.reviews."""

    def __init__(self, rows: Iterable[Dict[str, str]]) -> None:
        self.reviews: List[Review] = [classify(row) for row in rows]
        self.decision: Dict[str, Review] = {}
        self.wallet: Dict[str, Review] = {}
        self.vault: Dict[Tuple[str, str], Review] = {}
        self.unrecognised: List[Review] = []
        for review in self.reviews:
            if review.track == DECISION:
                self.decision[review.confirmation_id] = review
            elif review.track == WALLET:
                self.wallet[review.address] = review
            elif review.track == VAULT:
                self.vault[(review.address, review.validator)] = review
            else:
                self.unrecognised.append(review)

    @property
    def row_count(self) -> int:
        return len(self.reviews)

    @property
    def max_id(self) -> int:
        return max((r.id for r in self.reviews), default=0)

    def decision_of(self, confirmation_id: str) -> Tuple[str, Optional[Review]]:
        review = self.decision.get(confirmation_id)
        if review is None:
            return "none", None
        return ("rejected" if review.status == "rejected" else "approved"), review

    def wallet_sent(self, address: str) -> Optional[Review]:
        review = self.wallet.get(address.lower())
        return review if review is not None and review.status == "included" else None

    def vault_sent(self, address: str, validator: str) -> Optional[Review]:
        review = self.vault.get((address.lower(), validator.lower()))
        return review if review is not None and review.status == "included" else None

    def approvals_stored_as_included(self) -> int:
        """Current decisions written as 'included' without wallet:/vault:, e.g. by hand."""
        return sum(1 for r in self.decision.values() if r.status == "included")

    def run_manifests(self, run: str) -> Set[str]:
        """manifest.json hashes recorded for run; rows without one do not count."""
        return {r.manifest for r in self.reviews if r.track in (WALLET, VAULT) and r.run == run and r.manifest}

    def run_tracks(self, run: str) -> Set[str]:
        return {r.track for r in self.reviews if r.track in (WALLET, VAULT) and r.run == run}
