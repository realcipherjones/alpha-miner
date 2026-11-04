#!/usr/bin/env python3
"""Signs a receipt for every payout. Runs as its own user, with a key the payer can't read.

It doesn't take the payer's word for anything: it reads the wallet's sends from the chain and matches each one to a
cash-out the replay verified. A send with no match gets no receipt and is listed publicly as unmatched, so someone who
steals the payout wallet can't make the theft look like a payout. Receipts are off-chain, indexed by block hash.

    receipts.py run                 keep signing (the service)
    receipts.py once                one pass
    receipts.py verify <url>        check every published receipt's signature, from anywhere
"""
import argparse
import json
import os
import sqlite3
import sys
import tempfile
import time
import urllib.request

import kii_chain as chain
import store

GAME = "alpha-miner"
HISTORY_PAGE = 500

SCHEMA = """
CREATE TABLE IF NOT EXISTS seen_sends (
    block_hash TEXT PRIMARY KEY,
    height INTEGER NOT NULL,
    destination TEXT NOT NULL,
    amount_raw TEXT NOT NULL,
    receipt_json TEXT,
    signature TEXT
);
CREATE TABLE IF NOT EXISTS allocations (cash_out_id INTEGER NOT NULL, block_hash TEXT NOT NULL, amount_raw TEXT NOT NULL);
"""


def load_or_create_key(path):
    """The key is made here on first start and never leaves this file."""
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        with open(path) as handle:
            return bytes.fromhex(handle.read().strip())
    private = os.urandom(32)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(private.hex())
    return private


def canonical(receipt):
    return json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()


class ReceiptSigner:
    def __init__(self, app_db_path, receipt_db_path, public_path, rpc, account, private, genesis, clock=time.time):
        self.app_db_path = app_db_path
        self.public_path = public_path
        self.rpc = rpc
        self.account = account
        self.private = private
        self.genesis = genesis.upper()
        self.clock = clock
        self.db = sqlite3.connect(receipt_db_path, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def _chain_sends(self):
        """The wallet's sends, oldest first."""
        head = None
        while True:
            fields = {"account": self.account, "count": HISTORY_PAGE, "reverse": "true", "raw": "true"}
            if head:
                fields["head"] = head
            reply = self.rpc.call("account_history", allow_error=True, **fields)
            if "error" in reply:
                if "not found" in reply["error"].lower():
                    return
                raise RuntimeError(reply["error"])
            history = reply.get("history") or []
            for item in history:
                if item.get("subtype", item.get("type")) == "send":
                    yield item
            head = reply.get("next")
            if not head:
                return

    def _match(self, app, destination, amount):
        """Which verified, not yet receipted cash-outs this send pays, oldest first. None if it doesn't fit."""
        allocated = {}
        for row in self.db.execute("SELECT cash_out_id, amount_raw FROM allocations"):
            allocated[row["cash_out_id"]] = allocated.get(row["cash_out_id"], 0) + int(row["amount_raw"])
        rows = app.execute(
            "SELECT c.id, c.run_id, c.stage, c.amount_raw, p.ign FROM cash_outs c JOIN players p ON p.id = c.player_id "
            "WHERE p.wallet = ? ORDER BY c.verified_at, c.id",
            (destination,),
        ).fetchall()
        left = amount
        items = []
        for row in rows:
            take = min(left, int(row["amount_raw"]) - allocated.get(row["id"], 0))
            if take > 0:
                items.append((row, take))
                left -= take
        return (rows[0]["ign"], items) if rows and left == 0 else None

    def cycle(self):
        """Handle new confirmed sends in chain order, then publish. Returns how many receipts were signed."""
        version = self.rpc.call("version")
        if version.get("network_identifier", "").upper() != self.genesis:
            raise RuntimeError(f"node runs genesis {version.get('network_identifier')}, expected {self.genesis}")
        signed = 0
        app = store.connect(self.app_db_path, read_only=True)
        try:
            for send in self._chain_sends():
                block_hash = send["hash"].upper()
                if self.db.execute("SELECT 1 FROM seen_sends WHERE block_hash=?", (block_hash,)).fetchone():
                    continue
                info = self.rpc.call("block_info", hash=block_hash, json_block="true")
                if info.get("confirmed") != "true":
                    break  # keeps chain order; picked up on the next pass
                destination, amount = info["contents"]["link_as_account"], int(info["amount"])
                matched = self._match(app, destination, amount)
                receipt_json = signature = None
                if matched:
                    ign, items = matched
                    receipt = {
                        "version": 1,
                        "game": GAME,
                        "block": block_hash,
                        "from": self.account,
                        "to": destination,
                        "amountRaw": str(amount),
                        "ign": ign,
                        "cashOuts": [{"run": row["run_id"], "stage": row["stage"], "amountRaw": str(take)} for row, take in items],
                        "signedAt": int(self.clock()),
                    }
                    receipt_json = canonical(receipt).decode()
                    signature = chain.ed_sign(receipt_json.encode(), self.private).hex().upper()
                    signed += 1
                with self.db:
                    self.db.execute(
                        "INSERT INTO seen_sends (block_hash, height, destination, amount_raw, receipt_json, signature) VALUES (?, ?, ?, ?, ?, ?)",
                        (block_hash, int(info["height"]), destination, str(amount), receipt_json, signature),
                    )
                    if matched:
                        self.db.executemany(
                            "INSERT INTO allocations (cash_out_id, block_hash, amount_raw) VALUES (?, ?, ?)",
                            [(row["id"], block_hash, str(take)) for row, take in matched[1]],
                        )
        finally:
            app.close()
        self.publish()
        return signed

    def publish(self):
        receipts, unmatched = [], []
        for row in self.db.execute("SELECT * FROM seen_sends ORDER BY height DESC"):
            if row["receipt_json"]:
                receipts.append({"receipt": json.loads(row["receipt_json"]), "signature": row["signature"]})
            else:
                unmatched.append({"block": row["block_hash"], "to": row["destination"], "amountRaw": row["amount_raw"]})
        public = {
            "publicKey": chain.public_key(self.private).hex().upper(),
            "account": self.account,
            "receiptCount": len(receipts),
            "unmatched": unmatched,
            "receipts": receipts,
            "updatedAt": self.clock(),
        }
        folder = os.path.dirname(os.path.abspath(self.public_path))
        handle, temp = tempfile.mkstemp(dir=folder, prefix=".receipts-")
        with os.fdopen(handle, "w") as out:
            json.dump(public, out)
        os.chmod(temp, 0o640)
        os.replace(temp, self.public_path)


def check_published(data):
    """Returns (good, bad) signature counts for a published receipts document."""
    public_key = bytes.fromhex(data["publicKey"])
    good = bad = 0
    for item in data["receipts"]:
        if chain.ed_verify(bytes.fromhex(item["signature"]), canonical(item["receipt"]), public_key):
            good += 1
        else:
            bad += 1
    return good, bad


def verify(url):
    request = urllib.request.Request(url.rstrip("/") + "/api/receipts", headers={"User-Agent": "alpha-miner-receipts"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    good, bad = check_published(data)
    print(f"public key {data['publicKey']}")
    print(f"{good} receipts good, {bad} bad, {len(data['unmatched'])} sends with no receipt")
    return 1 if bad or data["unmatched"] else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["run", "once", "verify"])
    parser.add_argument("url", nargs="?")
    args = parser.parse_args()
    if args.command == "verify":
        if not args.url:
            raise SystemExit("verify needs the site address")
        sys.exit(verify(args.url))
    env = os.environ
    signer = ReceiptSigner(
        env["APP_DB"], env["RECEIPT_DB"], env["RECEIPTS_PUBLIC"], chain.NodeRpc(env["RECEIPT_NODE"]), env["RECEIPT_ACCOUNT"],
        load_or_create_key(env["RECEIPT_KEY_FILE"]), env["RECEIPT_GENESIS"],
    )
    print(f"signing receipts for {signer.account[:12]}...", flush=True)
    if args.command == "once":
        print("receipts signed:", signer.cycle())
        return
    while True:
        try:
            signer.cycle()
        except Exception as err:  # a node or database hiccup must not stop later passes; payouts don't depend on this
            print(f"receipt pass failed: {err}", file=sys.stderr, flush=True)
        time.sleep(int(env.get("RECEIPT_INTERVAL_SECONDS", "30")))


if __name__ == "__main__":
    main()
