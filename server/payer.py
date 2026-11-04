#!/usr/bin/env python3
"""Pays verified cash-outs. Runs as its own user: the only process that can read the wallet seed.

Limits are enforced here, not in the web service, so a compromised web service can only ask, within the caps:
  per player:  1000 KII per UTC day
  whole game:  min(1000 KII x players cashing out, 0.25% of the wallet at the start of the UTC day)
Anything over a limit stays queued and is paid oldest-first on later days.

Dry run is the default: nothing is signed or sent, and no seed or node is needed. Live needs PAYER_MODE=live plus
all the PAYER_* settings below, and a payer database that has never run in dry-run mode.

Every send is written to the database, signed, before it is published. After a crash the same block is
republished, never a new one. Each block names the previous one, so a payout can't go out twice.
Anything unexpected pauses payouts until someone looks: see `payer.py resume`.
"""
import argparse
import json
import os
import sqlite3
import stat
import sys
import tempfile
import time

import kii_chain as chain
import store

PLAYER_DAILY_RAW = 1000 * chain.KII
WALLET_DAILY_BPS = 25  # 0.25%, in hundredths of a percent
DRY_RUN_START_RAW = 25_000_000 * chain.KII
GENESIS = "149A92DB41D95B07DA5413BCADEDA34E7779973067DF27E156F5DF4BEFC949CD"
ALPHA_WALLET = "kii_35ftdboa5fww3z7h6zur441abyep6dtduzaunds3srbc3c4pcj5e19a1p1u3"
CONFIRM_TIMEOUT_SECONDS = 120
MIN_PEERS = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    cash_out_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    wallet TEXT NOT NULL,
    amount_raw TEXT NOT NULL,
    day TEXT NOT NULL,
    status TEXT NOT NULL,
    block_hash TEXT,
    block_json TEXT,
    created_at REAL NOT NULL,
    confirmed_at REAL
);
CREATE INDEX IF NOT EXISTS payments_cash_out ON payments(cash_out_id);
CREATE INDEX IF NOT EXISTS payments_day ON payments(day, player_id);
CREATE TABLE IF NOT EXISTS bound_wallets (player_id INTEGER PRIMARY KEY, wallet TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, start_balance_raw TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


class Paused(Exception):
    """Something is wrong enough that a person should look before any more KII moves."""


def utc_day(now):
    return time.strftime("%Y-%m-%d", time.gmtime(now))


def plan_payments(queue, paid_today_by_player, paid_today_total, players_today, start_balance_raw):
    """Pure cap logic. queue is oldest-first [{cash_out_id, player_id, wallet, outstanding_raw}]."""
    limit = min(PLAYER_DAILY_RAW * players_today, start_balance_raw * WALLET_DAILY_BPS // 10000)
    left_today = max(0, limit - paid_today_total)
    by_player = dict(paid_today_by_player)
    plan = []
    for item in queue:
        if left_today <= 0:
            break
        player_left = PLAYER_DAILY_RAW - by_player.get(item["player_id"], 0)
        amount = min(item["outstanding_raw"], player_left, left_today)
        if amount <= 0:
            continue
        plan.append({**item, "amount_raw": amount})
        by_player[item["player_id"]] = by_player.get(item["player_id"], 0) + amount
        left_today -= amount
    return plan, limit


class DryRunWallet:
    """Stands in for the network: tracks the balance in the payer's records and sends nothing."""
    mode = "dry_run"

    def __init__(self, payer):
        self.payer = payer

    def balance(self):
        spent = sum(int(r["amount_raw"]) for r in self.payer.db.execute("SELECT amount_raw FROM payments"))
        return DRY_RUN_START_RAW - spent

    def preflight(self):
        return None

    def resume_unfinished(self):
        return None

    def send(self, payment_id, destination, amount):
        self.payer.db.execute(
            "UPDATE payments SET status='dry_run', block_hash=?, confirmed_at=? WHERE id=?",
            (f"DRYRUN{payment_id:058d}", self.payer.clock(), payment_id),
        )
        self.payer.db.commit()


class LiveWallet:
    """Signs and publishes real sends."""
    mode = "live"

    def __init__(self, payer, rpc, private, work=chain.generate_work):
        self.payer = payer
        self.rpc = rpc
        self.private = private
        self.account = chain.account_from_public(chain.public_key(private))
        self.work = work

    def balance(self):
        return int(self.rpc.call("account_info", account=self.account)["balance"])

    def preflight(self):
        version = self.rpc.call("version")
        if version.get("network_identifier", "").upper() != self.payer.genesis:
            raise Paused(f"node runs genesis {version.get('network_identifier')}, expected {self.payer.genesis}")
        peers = len(self.rpc.call("peers").get("peers") or {})
        if peers < MIN_PEERS:
            raise Paused(f"node has {peers} peers, needs at least {MIN_PEERS}")
        known = self.payer.setting("frontier")
        frontier = self.rpc.call("account_info", account=self.account)["frontier"].upper()
        ours = {r["block_hash"] for r in self.payer.db.execute("SELECT block_hash FROM payments WHERE status='signed'")}
        if known is None:
            self.payer.set_setting("frontier", frontier)
        elif known != frontier and frontier not in ours:
            raise Paused(f"wallet frontier is {frontier}, last known {known}: something else moved this wallet")

    def _publish(self, block, block_hash):
        work = self.work(block["previous"])
        reply = self.rpc.call("process", allow_error=True, json_block="true", subtype="send", block=dict(block, work=work))
        if "error" in reply and "Old block" not in reply["error"]:
            raise Paused(f"node refused block {block_hash}: {reply['error']}")
        if "hash" in reply and reply["hash"].upper() != block_hash:
            raise Paused(f"node computed {reply['hash']}, expected {block_hash}")

    def _wait_confirmed(self, block_hash):
        deadline = time.monotonic() + CONFIRM_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            info = self.rpc.call("block_info", allow_error=True, hash=block_hash, json_block="true")
            if info.get("confirmed") == "true":
                return True
            time.sleep(self.payer.poll_seconds)
        return False

    def _finish(self, payment_id, block_hash):
        if not self._wait_confirmed(block_hash):
            raise Paused(f"block {block_hash} isn't confirmed yet; it will be checked again on resume")
        self.payer.db.execute(
            "UPDATE payments SET status='confirmed', confirmed_at=? WHERE id=?", (self.payer.clock(), payment_id)
        )
        self.payer.set_setting("frontier", block_hash)
        self.payer.db.commit()

    def resume_unfinished(self):
        """Finish a send interrupted by a crash, using the block saved before it was published."""
        for row in self.payer.db.execute("SELECT * FROM payments WHERE status='signed' ORDER BY id").fetchall():
            block = json.loads(row["block_json"])
            frontier = self.rpc.call("account_info", account=self.account)["frontier"].upper()
            exists = "error" not in self.rpc.call("block_info", allow_error=True, hash=row["block_hash"], json_block="true")
            if not exists:
                if frontier != block["previous"]:
                    raise Paused(f"saved block {row['block_hash']} can't be published: wallet frontier is {frontier}")
                self._publish(block, row["block_hash"])
            self._finish(row["id"], row["block_hash"])

    def send(self, payment_id, destination, amount):
        if destination == self.account:
            raise Paused("refusing to send the wallet to itself")
        if amount <= 0 or amount > PLAYER_DAILY_RAW:
            raise Paused(f"refusing a send of {amount} raw: outside the per-player cap")
        info = self.rpc.call("account_info", account=self.account, representative="true")
        balance = int(info["balance"])
        if amount > balance:
            raise Paused(f"wallet holds {balance} raw, can't send {amount}")
        block_hash, block = chain.build_send(self.private, info["frontier"], info["representative"], balance - amount, destination)
        self.payer.db.execute(
            "UPDATE payments SET status='signed', block_hash=?, block_json=? WHERE id=?",
            (block_hash, json.dumps(block), payment_id),
        )
        self.payer.db.commit()
        self._publish(block, block_hash)
        self._finish(payment_id, block_hash)


class Payer:
    def __init__(self, app_db_path, payer_db_path, status_path, clock=time.time, poll_seconds=0.5, genesis=GENESIS):
        self.app_db_path = app_db_path
        self.status_path = status_path
        self.clock = clock
        self.poll_seconds = poll_seconds
        self.genesis = genesis.upper()
        self.db = sqlite3.connect(payer_db_path, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.wallet = None

    def setting(self, key):
        row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        self.db.commit()

    def use_wallet(self, wallet):
        recorded = self.setting("mode")
        if recorded is None:
            self.set_setting("mode", wallet.mode)
        elif recorded != wallet.mode:
            raise SystemExit(f"this payer database ran in {recorded} mode; start {wallet.mode} with a new database")
        self.wallet = wallet

    def _queue(self, app):
        paid = {}
        for row in self.db.execute("SELECT cash_out_id, amount_raw FROM payments"):
            paid[row["cash_out_id"]] = paid.get(row["cash_out_id"], 0) + int(row["amount_raw"])
        queue = []
        rows = app.execute(
            "SELECT c.id, c.player_id, c.amount_raw, p.wallet, p.banned FROM cash_outs c "
            "JOIN players p ON p.id = c.player_id ORDER BY c.verified_at, c.id"
        )
        for row in rows:
            outstanding = int(row["amount_raw"]) - paid.get(row["id"], 0)
            if outstanding > 0 and not row["banned"]:
                queue.append({"cash_out_id": row["id"], "player_id": row["player_id"], "wallet": row["wallet"], "outstanding_raw": outstanding})
        return queue

    def _check_bindings(self, queue):
        """A wallet binding never changes. A change here means the web database was tampered with."""
        for item in queue:
            row = self.db.execute("SELECT wallet FROM bound_wallets WHERE player_id=?", (item["player_id"],)).fetchone()
            if row is None:
                self.db.execute("INSERT INTO bound_wallets (player_id, wallet) VALUES (?, ?)", (item["player_id"], item["wallet"]))
            elif row["wallet"] != item["wallet"]:
                raise Paused(f"player {item['player_id']} wallet changed from {row['wallet']} to {item['wallet']}")
        self.db.commit()

    def cycle(self):
        """Pay what today's limits allow. Returns the number of payments made."""
        pause = self.setting("paused")
        if pause:
            self.write_status(paused=True)
            return 0
        made = 0
        try:
            # A payment that never reached signing never left the wallet, so it goes back in the queue
            self.db.execute("DELETE FROM payments WHERE status='planned'")
            self.db.commit()
            self.wallet.preflight()
            self.wallet.resume_unfinished()
            app = store.connect(self.app_db_path, read_only=True)
            try:
                queue = self._queue(app)
            finally:
                app.close()
            self._check_bindings(queue)
            day = utc_day(self.clock())
            row = self.db.execute("SELECT start_balance_raw FROM days WHERE day=?", (day,)).fetchone()
            if row is None:
                start_balance = self.wallet.balance()
                self.db.execute("INSERT INTO days (day, start_balance_raw) VALUES (?, ?)", (day, str(start_balance)))
                self.db.commit()
            else:
                start_balance = int(row["start_balance_raw"])
            today = self.db.execute("SELECT player_id, amount_raw FROM payments WHERE day=?", (day,)).fetchall()
            by_player = {}
            for payment in today:
                by_player[payment["player_id"]] = by_player.get(payment["player_id"], 0) + int(payment["amount_raw"])
            players = {item["player_id"] for item in queue} | set(by_player)
            plan, _ = plan_payments(queue, by_player, sum(by_player.values()), len(players), start_balance)
            for item in plan:
                cursor = self.db.execute(
                    "INSERT INTO payments (cash_out_id, player_id, wallet, amount_raw, day, status, created_at) "
                    "VALUES (?, ?, ?, ?, ?, 'planned', ?)",
                    (item["cash_out_id"], item["player_id"], item["wallet"], str(item["amount_raw"]), day, self.clock()),
                )
                self.db.commit()
                self.wallet.send(cursor.lastrowid, item["wallet"], item["amount_raw"])
                made += 1
        except Paused as reason:
            self.set_setting("paused", str(reason))
            print(f"PAUSED: {reason}", file=sys.stderr, flush=True)
        self.write_status()
        return made

    def write_status(self, paused=False):
        """Public facts only, for the web service to show. Written atomically; holds nothing secret."""
        day = utc_day(self.clock())
        paid_total = {}
        for row in self.db.execute("SELECT player_id, amount_raw FROM payments WHERE status IN ('confirmed', 'dry_run')"):
            paid_total[row["player_id"]] = paid_total.get(row["player_id"], 0) + int(row["amount_raw"])
        by_cash_out = {}
        for row in self.db.execute("SELECT cash_out_id, amount_raw FROM payments WHERE status IN ('confirmed', 'dry_run')"):
            by_cash_out[row["cash_out_id"]] = by_cash_out.get(row["cash_out_id"], 0) + int(row["amount_raw"])
        today = sum(int(r["amount_raw"]) for r in self.db.execute("SELECT amount_raw FROM payments WHERE day=?", (day,)))
        recent = [
            {"playerId": r["player_id"], "amountRaw": r["amount_raw"], "blockHash": r["block_hash"], "confirmedAt": r["confirmed_at"]}
            for r in self.db.execute(
                "SELECT player_id, amount_raw, block_hash, confirmed_at FROM payments "
                "WHERE status IN ('confirmed', 'dry_run') ORDER BY confirmed_at DESC, id DESC LIMIT 25"
            )
        ]
        row = self.db.execute("SELECT start_balance_raw FROM days WHERE day=?", (day,)).fetchone()
        start = int(row["start_balance_raw"]) if row else None
        status = {
            "mode": self.setting("mode"),
            "paused": bool(self.setting("paused")),
            "updatedAt": self.clock(),
            "day": day,
            "walletCeilingRaw": str(start * WALLET_DAILY_BPS // 10000) if start is not None else None,
            "paidTodayRaw": str(today),
            "paidByPlayer": {str(k): str(v) for k, v in paid_total.items()},
            "paidByCashOut": {str(k): str(v) for k, v in by_cash_out.items()},
            "recent": recent,
        }
        folder = os.path.dirname(os.path.abspath(self.status_path))
        handle, temp = tempfile.mkstemp(dir=folder, prefix=".status-")
        with os.fdopen(handle, "w") as out:
            json.dump(status, out)
        os.chmod(temp, 0o644)
        os.replace(temp, self.status_path)


def load_seed(path, expected_account, index):
    """The seed file must be readable by this user alone, and must derive exactly the expected wallet."""
    info = os.stat(path)
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise SystemExit(f"{path} must not be readable by group or others (chmod 600)")
    with open(path) as handle:
        text = handle.read().strip()
    try:
        seed = bytes.fromhex(text)
    except ValueError:
        raise SystemExit("the seed file must hold one 64-character hex seed") from None
    if len(seed) != 32:
        raise SystemExit("the seed file must hold one 64-character hex seed")
    private = chain.private_from_seed(seed, index)
    derived = chain.account_from_public(chain.public_key(private))
    if derived != expected_account:
        raise SystemExit(f"this seed at index {index} gives {derived[:12]}..., expected {expected_account[:12]}...")
    return private


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="run", choices=["run", "once", "resume"])
    args = parser.parse_args()
    env = os.environ
    payer = Payer(env.get("APP_DB", "app.db"), env.get("PAYER_DB", "payer.db"), env.get("PAYER_STATUS", "status.json"))
    if args.command == "resume":
        print("was paused for:", payer.setting("paused"))
        if env.get("PAYER_ACCEPT_FRONTIER"):
            payer.set_setting("frontier", env["PAYER_ACCEPT_FRONTIER"].upper())
        payer.db.execute("DELETE FROM settings WHERE key='paused'")
        payer.db.commit()
        print("resumed")
        return
    if env.get("PAYER_MODE", "dry_run") == "live":
        account = env["PAYER_ACCOUNT"]
        if account != ALPHA_WALLET and env.get("PAYER_ALLOW_OTHER_ACCOUNT") != "yes":
            raise SystemExit(f"PAYER_ACCOUNT is not the alpha wallet {ALPHA_WALLET}")
        private = load_seed(env["PAYER_SEED_FILE"], account, int(env.get("PAYER_SEED_INDEX", "0")))
        payer.genesis = env.get("PAYER_GENESIS", GENESIS).upper()
        wallet = LiveWallet(payer, chain.NodeRpc(env.get("PAYER_NODE", "http://127.0.0.1:7617")), private)
    else:
        wallet = DryRunWallet(payer)
    payer.use_wallet(wallet)
    print(f"payer running in {wallet.mode} mode", flush=True)
    if args.command == "once":
        print("payments made:", payer.cycle())
        return
    while True:
        payer.cycle()
        time.sleep(int(env.get("PAYER_INTERVAL_SECONDS", "30")))


if __name__ == "__main__":
    main()
