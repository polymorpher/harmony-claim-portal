#!/usr/bin/env python3
"""The confirmed-wallets exports, read by harmony-migration's own payment tools. No database.

Finds the airdrop tools in $HARMONY_MIGRATION_REPO (default ~/git/harmony-migration) and skips
when they are not there. A renamed or added export column that changes what safe-batch or
vault-batch reads fails here instead of in a batch.
"""

import contextlib
import csv
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("confirmed_wallets", HERE / "confirmed-wallets.py")
cw = importlib.util.module_from_spec(spec)
sys.modules["confirmed_wallets"] = cw
spec.loader.exec_module(cw)

TOOLS = Path(os.environ.get("HARMONY_MIGRATION_REPO", Path.home() / "git" / "harmony-migration")) / "airdrop" / "tools"
if (TOOLS / "vault_batch.py").is_file():
    sys.path.insert(0, str(TOOLS))
    import common  # noqa: E402
    import vault_batch  # noqa: E402
else:
    common = vault_batch = None

ONE = 10**18
ALICE, BOB, CAROL = ("0x" + c * 40 for c in "abc")
VAL1, VAL2 = "0x" + "11" * 20, "0x" + "22" * 20
DEPOSIT_ARGS = SimpleNamespace(validator_column=None, delegator_column=None, amount_column=None, amount_unit=None)


def confirmation(id, address, wallet, vault):
    return {
        "id": str(id), "address": address, "signer": address, "confirmed_at_utc": "2026-10-06T10:00:00Z",
        "data_version": "2026-09-17", "policy_version": "migration-policy-20260917",
        "stage_reason": cw.PREDATES, "signature": "0x" + "ab" * 65, "signature_scheme": "personal_sign",
        "message": "I confirm\nmy wallet", "still_candidate": "t", "in_ledger": "t",
        "account_category": "ordinary_eoa", "migration_stage": "deferred",
        "migration_allocation_atto": str((wallet + vault) * ONE),
        "migration_wallet_allocation_atto": str(wallet * ONE), "migration_staked_to_vault_atto": str(vault * ONE),
        "wallet_airdrop_atto": str(wallet * ONE), "staked_to_vault_atto": str(vault * ONE),
    }


def position(address, validator, staked):
    return {"address": address, "validator_address": validator, "validator_name": "v",
            "staked_to_vault_atto": str(staked * ONE), "is_self_delegation": "f", "priority": "t",
            "governor_status": "ready"}


def review(id, cid, address, status, batch_id=""):
    return {"id": str(id), "confirmation_id": str(cid), "address": address, "status": status,
            "batch_id": batch_id, "note": "", "reviewed_at_utc": "2026-10-07T01:00:00Z"}


def write(path, rows):
    with path.open("w", newline="") as handle:
        if rows:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)


@unittest.skipIf(common is None, f"harmony-migration airdrop tools not found at {TOOLS}")
class AirdropToolsReadTheExports(unittest.TestCase):
    """Alice: approved, wallet pending, one vault position sent and one pending.
    Bob: not reviewed. Carol: approved, wallet sent, her only vault position on hold."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = cls.dir = Path(cls.tmp.name)
        write(d / "confirmations.csv", [confirmation(1, ALICE, 1000, 500), confirmation(2, BOB, 2000, 0),
                                        confirmation(3, CAROL, 50, 100)])
        write(d / "vault-shares.csv", [position(ALICE, VAL1, 300), position(ALICE, VAL2, 200),
                                       position(CAROL, VAL1, 100)])
        write(d / "exceptions.csv", [{"address": CAROL, "component": "vault_shares", "validator_address": VAL1,
                                      "destination_status": "hold", "destination_address": "",
                                      "amount_atto": str(100 * ONE)}])
        write(d / "reviews.csv", [review(1, 1, ALICE, "queued"), review(2, 3, CAROL, "queued"),
                                  review(3, 1, ALICE, "included", f"vault:vaults-pilot-1:{VAL2}"),
                                  review(4, 3, CAROL, "included", "wallet:confirmed-wallets-1")])
        cls.wallets = cls.export("--decision", "approved", "--wallet", "pending")
        cls.vaults = cls.export("--decision", "approved", "--vault", "pending", vault_file=True)
        cls.all_wallets = cls.export()
        cls.all_vaults = cls.export(vault_file=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @classmethod
    def export(cls, *flags, vault_file=False):
        d = cls.dir
        out = d / ("out-" + "-".join(flags or ("all",)))
        with contextlib.redirect_stdout(io.StringIO()):
            cw.main(["--confirmations", str(d / "confirmations.csv"), "--vault-shares", str(d / "vault-shares.csv"),
                     "--exceptions", str(d / "exceptions.csv"), "--reviews", str(d / "reviews.csv"),
                     "--out-dir", str(out), "--generated-at", "2026-10-07T12:00:00Z", "--csv", *flags])
        files = sorted(out.glob("*-vault-shares.csv" if vault_file else "*.csv"))
        files = [f for f in files if vault_file or not f.name.endswith("-vault-shares.csv")]
        assert len(files) == 1, files
        return files[0]

    def test_safe_batch_pays_the_filtered_wallet_export(self):
        rows, info = common.read_rows(self.wallets, "address", "wallet_allocation_atto", review_portal_exports=True)
        self.assertEqual([(r.address.lower(), r.amount) for r in rows], [(ALICE, 1000 * ONE)])
        self.assertEqual(info["sources"][0]["portal_review_columns"], ["decision", "wallet_status"])

    def test_safe_batch_refuses_the_unfiltered_wallet_export(self):
        with self.assertRaises(common.InputError) as caught:
            common.read_rows(self.all_wallets, "address", "wallet_allocation_atto", review_portal_exports=True)
        self.assertIn("--decision approved --wallet pending", str(caught.exception))

    def test_safe_batch_refuses_the_vault_shares_export(self):
        with self.assertRaises(common.InputError) as caught:
            common.read_rows(self.vaults, "address", "expected_shares_atto", review_portal_exports=True)
        self.assertIn("vault-shares export", str(caught.exception))

    def test_vault_batch_reads_the_filtered_vault_export_by_its_own_column_detection(self):
        deposits, info = vault_batch.read_deposits([self.vaults], DEPOSIT_ARGS, review_portal_exports=True)
        self.assertEqual([(d.validator.lower(), d.delegator.lower(), d.amount) for d in deposits],
                         [(VAL1, ALICE, 300 * ONE)])
        source = info["sources"][0]
        self.assertEqual(source["columns"], {"validator": "validator_address", "delegator": "address",
                                             "amount": "expected_shares_atto"})
        self.assertEqual(source["portal_review_columns"], ["decision", "sent_status"])

    def test_vault_batch_refuses_sent_unreviewed_or_blocked_positions(self):
        with self.assertRaises(common.InputError):
            vault_batch.read_deposits([self.all_vaults], DEPOSIT_ARGS, review_portal_exports=True)
        with open(self.all_vaults, newline="") as handle:
            rows = {(r["address"], r["validator_address"]): r for r in csv.DictReader(handle)}
        self.assertEqual(rows[(ALICE, VAL2)]["sent_status"], "sent")
        self.assertEqual((rows[(CAROL, VAL1)]["sent_status"], rows[(CAROL, VAL1)]["destination_status"]),
                         ("blocked", "hold"))

    def test_show_compare_does_not_apply_the_review_check(self):
        # Alice's two positions: one sent, one pending. vault-batch's own destination_status rule
        # (only ready rows) applies to --compare as before, so a held position would still stop it.
        alice = self.export("--run", "vaults-pilot-1", vault_file=True)
        deposits, _ = vault_batch.read_deposits([alice], DEPOSIT_ARGS)
        self.assertEqual(len(deposits), 2)
        with self.assertRaises(common.InputError):
            vault_batch.read_deposits([alice], DEPOSIT_ARGS, review_portal_exports=True)


if __name__ == "__main__":
    unittest.main()
