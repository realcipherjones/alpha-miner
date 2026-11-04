#!/usr/bin/env python3
"""Tests for the payout service. Replays run in the real game bundle; run `node build.mjs` first.

    NODE=/path/to/node python3 server/test_server.py
"""
import hashlib
import http.server
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import app as web  # noqa: E402
import kii_chain as chain  # noqa: E402
import payer as pay  # noqa: E402
import receipts as signer  # noqa: E402
import store  # noqa: E402

NODE = os.environ.get("NODE", "node")
KII = chain.KII
GOOD_WALLET = chain.account_from_public(chain.public_key(chain.private_from_seed(b"\x01" * 32)))
WALLETS = [chain.account_from_public(chain.public_key(chain.private_from_seed(bytes([i + 2]) * 32))) for i in range(40)]
REPLAY_CMD = [NODE, str(ROOT / "tools" / "replay_run.mjs")]
DEBUG_START = {"stage": 49, "startBalanceRaw": str(500 * KII)}
_cache = {}


def make_log(seed, debug=None, balance=None, seconds=60, bot=3, encounters=None):
    key = (seed, json.dumps(debug), balance, seconds, bot, json.dumps(encounters))
    if key not in _cache:
        spec = {"seed": seed, "bossEncounters": encounters or {"dog": 0, "son": 0}, "debug": debug, "startBalanceRaw": balance, "seconds": seconds, "botSeed": bot}
        done = subprocess.run([NODE, str(ROOT / "tools" / "make_test_log.mjs")], input=json.dumps(spec).encode(), capture_output=True, check=True)
        _cache[key] = done.stdout.decode()
    return json.loads(_cache[key])


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


class Stack(unittest.TestCase):
    """A real web service on a loopback port, with a temporary database."""
    debug_start = None

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="alpha-server-test-")
        self.clock = Clock()
        self.config = web.Config(
            db_path=f"{self.dir}/app.db", status_path=f"{self.dir}/status.json", replay_cmd=REPLAY_CMD,
            port=0, clock=self.clock, test_debug_start=self.debug_start,
            limits={"register": (1000, 3600), "start": (1000, 3600), "submit": (1000, 3600)},
        )
        self.service = web.Service(self.config)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), web.make_handler(self.service))
        self.server.RequestHandlerClass.log_message = lambda *a: None
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def call(self, method, path, body=None, token=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as err:
            return err.code, json.load(err)

    def player(self, ign="Miner1", wallet=GOOD_WALLET):
        status, reply = self.call("POST", "/api/register", {"ign": ign, "wallet": wallet})
        self.assertEqual(status, 201, reply)
        return reply["token"]

    def start(self, token, seed=None):
        status, run = self.call("POST", "/api/runs", token=token)
        self.assertEqual(status, 201, run)
        if seed is not None:
            db = self.service.db()
            with db:
                db.execute("UPDATE runs SET seed=? WHERE id=?", (seed, run["runId"]))
            db.close()
            run["seed"] = seed
        return run

    def rows(self, sql, *args):
        db = self.service.db()
        try:
            return db.execute(sql, args).fetchall()
        finally:
            db.close()

    def verify_all(self):
        while self.service.verify_next():
            pass


class ChainTests(unittest.TestCase):
    def test_nano_published_vector(self):
        private = chain.private_from_seed(bytes(32), 0)
        self.assertEqual(private.hex().upper(), "9F0E444C69F77A49BD0BE89DB92C38FE713E0963165CCA12FAF5712D7657120F")
        public = chain.public_key(private)
        self.assertEqual(public.hex().upper(), "C008B814A7D269A1FA3C6528B19201A24D797912DB9996FF02A1FF356E45552B")
        self.assertEqual(chain.account_from_public(public), "kii_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7")

    def test_real_ledger_block(self):
        """The public 25M transfer that funded the alpha wallet: confirmed on the live network 2026-11-02."""
        account = "kii_1sxcue4zaz7xpzbip16puoedcmacp6bbrysirphqfexkf7inystwagq3xjxh"
        digest = chain.state_hash(
            chain.decode_account(account),
            bytes.fromhex("D0BF212B9F3DC3B3BAC9CCB9BA9F2858999B876328F64AD6EE87671C94F311B4"),
            chain.decode_account("kii_3h1awesr1cgmfm5nz167jx3i1mqupnbyptoxhx5mewoj6d8wuwjop936kf79"),
            20533333333330833333333333333333333333,
            chain.decode_account(pay.ALPHA_WALLET),
        )
        self.assertEqual(digest.hex().upper(), "CE3C0CC289383822BCD598A907CFBCD5B7AEC625C72A5DA5A512F88F7BA9ED89")
        signature = bytes.fromhex("F32843CC9EEA06D40BC97C93CECEA103F133392F5357EB692E512EC8D00451DE68251720E8D9C2A16511FC51FBD85760E9F6AA516FE5F945510F6FA0968A570F")
        self.assertTrue(chain.ed_verify(signature, digest, chain.decode_account(account)))
        self.assertFalse(chain.ed_verify(signature, b"\0" * 32, chain.decode_account(account)))

    def test_bad_addresses(self):
        for bad in [None, 5, "", "nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7", GOOD_WALLET[:-1] + ("1" if GOOD_WALLET[-1] != "1" else "3"), "kii_" + "0" * 60]:
            with self.assertRaises(ValueError):
                chain.decode_account(bad)

    def test_work(self):
        root = "AB" * 32
        work = chain.generate_work(root, 0xfff0000000000000, processes=1)
        self.assertGreaterEqual(chain.work_value(int(work, 16), bytes.fromhex(root)), 0xfff0000000000000)


class CapTests(unittest.TestCase):
    def item(self, i, player, amount):
        return {"cash_out_id": i, "player_id": player, "wallet": f"wallet{player}", "outstanding_raw": amount * KII}

    def plan(self, queue, by_player=None, total=0, players=None, balance=25_000_000):
        return pay.plan_payments(queue, by_player or {}, total, players if players is not None else len({q["player_id"] for q in queue}), balance * KII)

    def test_limit_is_the_smaller_of_demand_and_ceiling(self):
        _, limit = self.plan([self.item(1, 1, 5)])
        self.assertEqual(limit, 1000 * KII)
        _, limit = self.plan([self.item(i, i, 5) for i in range(40)], players=40)
        self.assertEqual(limit, 40_000 * KII)
        _, limit = self.plan([], players=100)
        self.assertEqual(limit, 62_500 * KII, "0.25% of 25M")
        _, limit = self.plan([], players=100, balance=10_000_000)
        self.assertEqual(limit, 25_000 * KII, "The ceiling falls with the wallet")

    def test_player_cap_splits_a_big_cash_out_over_days(self):
        plan, _ = self.plan([self.item(1, 1, 2500)])
        self.assertEqual([p["amount_raw"] for p in plan], [1000 * KII])

    def test_player_cap_doesnt_block_other_players(self):
        plan, _ = self.plan([self.item(1, 1, 1500), self.item(2, 1, 50), self.item(3, 2, 70)])
        self.assertEqual([(p["cash_out_id"], p["amount_raw"]) for p in plan], [(1, 1000 * KII), (3, 70 * KII)])

    def test_already_paid_today_counts(self):
        plan, _ = self.plan([self.item(1, 1, 500)], {1: 800 * KII}, 800 * KII, 1)
        self.assertEqual(plan[0]["amount_raw"], 200 * KII)
        plan, _ = self.plan([self.item(1, 1, 500)], {1: 1000 * KII}, 1000 * KII, 1)
        self.assertEqual(plan, [])

    def test_ceiling_pays_oldest_first_and_stops(self):
        queue = [self.item(i, i, 1000) for i in range(100)]
        plan, limit = self.plan(queue, players=100, balance=25_000_000)
        self.assertEqual(limit, 62_500 * KII)
        self.assertEqual(sum(p["amount_raw"] for p in plan), 62_500 * KII)
        self.assertEqual([p["cash_out_id"] for p in plan], list(range(63)), "Oldest first")
        self.assertEqual(plan[-1]["amount_raw"], 500 * KII, "The last payment is partial")

    def test_wallet_never_empties(self):
        balance = 25_000_000 * KII
        for _ in range(3650):
            balance -= balance * pay.WALLET_DAILY_BPS // 10000
        self.assertGreater(balance, 0)


class RegisterTests(Stack):
    def test_register_rules(self):
        self.player("Miner_1", WALLETS[0])
        for ign, wallet, status in [
            ("miner_1", WALLETS[1], 409),
            ("Other", WALLETS[0], 409),
            ("ab", WALLETS[1], 400),
            ("<script>", WALLETS[1], 400),
            ("a" * 17, WALLETS[1], 400),
            (5, WALLETS[1], 400),
            ("Okay", "kii_nope", 400),
            ("Okay", None, 400),
        ]:
            self.assertEqual(self.call("POST", "/api/register", {"ign": ign, "wallet": wallet})[0], status, ign)

    def test_tokens_are_stored_hashed(self):
        token = self.player()
        stored = self.rows("SELECT token_hash FROM players")[0]["token_hash"]
        self.assertNotIn(token, stored)
        self.assertEqual(stored, hashlib.sha256(token.encode()).hexdigest())

    def test_auth(self):
        for token in [None, "nonsense", "x" * 43]:
            self.assertEqual(self.call("POST", "/api/runs", token=token)[0], 401)
            self.assertEqual(self.call("GET", "/api/me", token=token)[0], 401)

    def test_register_rate_limit(self):
        self.service.limiter = web.RateLimiter(self.clock)
        self.config.limits["register"] = (2, 3600)
        self.player("One1", WALLETS[0])
        self.player("Two2", WALLETS[1])
        self.assertEqual(self.call("POST", "/api/register", {"ign": "Three", "wallet": WALLETS[2]})[0], 429)
        self.clock.now += 3601
        self.player("Three", WALLETS[2])

    def test_no_way_to_change_a_wallet(self):
        token = self.player()
        self.assertEqual(self.call("POST", "/api/register", {"ign": "Miner1", "wallet": WALLETS[0]})[0], 409)
        self.assertEqual(self.rows("SELECT wallet FROM players")[0]["wallet"], GOOD_WALLET)
        self.assertEqual(self.call("GET", "/api/me", token=token)[1]["wallet"], GOOD_WALLET)

    def test_bad_requests(self):
        request = urllib.request.Request(self.base + "/api/register", data=b"{not json", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(self.call("GET", "/api/nope")[0], 404)
        self.assertEqual(self.call("GET", "/../../payer.py")[0], 404)

    def test_oversized_body_is_refused(self):
        request = urllib.request.Request(self.base + "/api/register", data=b"x", method="POST")
        request.add_header("Content-Length", str(web.MAX_BODY_BYTES + 1))
        with self.assertRaises((urllib.error.HTTPError, urllib.error.URLError, ConnectionError)) as caught:
            urllib.request.urlopen(request)
        if isinstance(caught.exception, urllib.error.HTTPError):
            self.assertEqual(caught.exception.code, 413)


class ProductionRunTests(Stack):
    """Default configuration: the rules a real player's run has to pass."""

    def honest(self, token, seed=11, seconds=20):
        run = self.start(token, seed)
        log = make_log(seed, seconds=seconds, bot=1)
        self.clock.now += log["ticks"] / 60 + 1
        return run, log

    def submit(self, token, run, log):
        return self.call("POST", f"/api/runs/{run['runId']}/submit", {"log": log}, token)

    def test_honest_run_verifies(self):
        token = self.player()
        run, log = self.honest(token)
        status, reply = self.submit(token, run, log)
        self.assertEqual(status, 202, reply)
        self.verify_all()
        self.assertEqual(self.rows("SELECT status, reason FROM submissions")[0]["status"], "verified", self.rows("SELECT reason FROM submissions")[0]["reason"])
        self.assertGreaterEqual(self.rows("SELECT best_stage FROM players")[0]["best_stage"], 1)
        self.assertEqual(self.submit(token, run, log)[1]["status"], "already_verified")

    def test_policy_rejections_before_replay(self):
        token = self.player()
        run, good = self.honest(token)
        def edited(change):
            log = json.loads(json.dumps(good))
            change(log)
            return log
        cases = {
            "debug start": lambda l: l["header"].update(debug={"stage": 49}),
            "non-empty bank": lambda l: l["header"].update(startBalanceRaw=str(1000 * KII)),
            "free lobs": lambda l: l["header"].update(freeLobs=50),
            "other seed": lambda l: l["header"].update(seed=12),
            "boss history": lambda l: l["header"].update(bossEncounters={"dog": 0, "son": 99}),
            "old version": lambda l: l["header"].update(version=0),
            "too fast": lambda l: l.update(ticks=10_000_000),
        }
        for name, change in cases.items():
            self.assertEqual(self.submit(token, run, edited(change))[0], 422, name)
        self.assertEqual(self.submit(token, run, {"nope": 1})[0], 422)
        self.assertEqual(self.submit(token, run, "nope")[0], 422)
        self.assertEqual(len(self.rows("SELECT id FROM submissions")), 0, "None of these should cost a replay")

    def test_run_faster_than_real_time_is_refused(self):
        token = self.player()
        run = self.start(token, 11)
        log = make_log(11, seconds=120, bot=1)
        self.clock.now += log["ticks"] / 60 - web.REAL_TIME_SLACK_SECONDS - 10
        self.assertEqual(self.submit(token, run, log)[0], 422)

    def test_only_your_own_run(self):
        mine, theirs = self.player("MinerA", WALLETS[0]), self.player("MinerB", WALLETS[1])
        run, log = self.honest(mine)
        self.assertEqual(self.submit(theirs, run, log)[0], 404)

    def test_starting_a_run_closes_the_last_one(self):
        token = self.player()
        first = self.start(token, 11)
        log = make_log(11, seconds=120, bot=1)
        self.clock.now += 5
        self.start(token)  # the first run gets 5 seconds of credit, however long ago it really started
        self.clock.now += 100
        self.assertEqual(self.submit(token, first, log)[0], 422)

    def test_closed_runs_expire(self):
        token = self.player()
        run, log = self.honest(token)
        self.start(token)
        self.clock.now += web.RECENT_RUN_GRACE_SECONDS + 1
        self.assertEqual(self.submit(token, run, log)[0], 410)

    def test_tampered_inputs_are_rejected_after_replay(self):
        token = self.player()
        run, log = self.honest(token)
        log = json.loads(json.dumps(log))
        log["inputs"] = [i for i in log["inputs"] if i[1] != "l"]
        self.assertEqual(self.submit(token, run, log)[0], 202)
        self.verify_all()
        row = self.rows("SELECT status, reason FROM submissions")[0]
        self.assertEqual(row["status"], "rejected")
        self.assertIn("match", row["reason"])
        self.assertEqual(self.rows("SELECT COUNT(*) AS n FROM cash_outs")[0]["n"], 0)
        self.assertIn("match", self.call("GET", "/api/me", token=token)[1]["lastRejection"])


class CashOutTests(Stack):
    """Uses the test-only start at stage 49, so a run reaches a cash-out in seconds."""
    debug_start = DEBUG_START

    def cash_out_run(self, token):
        run = self.start(token, 33)
        self.assertEqual(run["debugStart"], DEBUG_START)
        log = make_log(33, debug={"stage": 49}, balance=DEBUG_START["startBalanceRaw"], seconds=120, bot=3)
        self.clock.now += log["ticks"] / 60 + 1
        return run, log

    def payer(self):
        payer = pay.Payer(self.config.db_path, f"{self.dir}/payer.db", self.config.status_path, clock=self.clock, poll_seconds=0)
        payer.use_wallet(pay.DryRunWallet(payer))
        return payer

    def test_amount_comes_from_the_replay_and_pays_once(self):
        token = self.player()
        run, log = self.cash_out_run(token)
        forged = json.loads(json.dumps(log))
        forged["cashOuts"] = [{"stage": 50, "tick": 1, "amountRaw": str(10**30)}]
        self.assertEqual(self.call("POST", f"/api/runs/{run['runId']}/submit", {"log": forged}, token)[0], 202)
        self.verify_all()
        rows = self.rows("SELECT stage, amount_raw FROM cash_outs")
        self.assertEqual(len(rows), 1, self.rows("SELECT reason FROM submissions")[0]["reason"])
        self.assertEqual(rows[0]["stage"], 50)
        amount = int(rows[0]["amount_raw"])
        self.assertTrue(0 < amount < 10**30, amount)

        # Sending the same run again, directly or through a stale retry, can't add a second payout
        db = self.service.db()
        with db:
            db.execute("UPDATE runs SET verified_ticks=0")
        db.close()
        self.assertEqual(self.call("POST", f"/api/runs/{run['runId']}/submit", {"log": log}, token)[0], 202)
        self.verify_all()
        self.assertEqual(len(self.rows("SELECT id FROM cash_outs")), 1)

        payer = self.payer()
        self.assertEqual(payer.cycle(), 1)
        self.assertEqual(payer.cycle(), 0)
        board = self.call("GET", "/api/leaderboard")[1]
        self.assertEqual(board["mode"], "dry_run")
        self.assertEqual(board["players"][0]["ign"], "Miner1")
        self.assertEqual(int(board["players"][0]["paidRaw"]), min(amount, 1000 * KII))
        self.assertEqual(board["recent"][0]["ign"], "Miner1")
        self.assertNotIn("wallet", json.dumps(board).lower().replace("walletceiling", ""))
        self.assertEqual(self.call("GET", "/api/me", token=token)[1]["cashOuts"][0]["paidRaw"], str(min(amount, 1000 * KII)))


class PayerTests(Stack):
    def add_cash_out(self, player_id, wallet, amount, when=None):
        db = self.service.db()
        with db:
            db.execute("INSERT OR IGNORE INTO players (id, ign, ign_key, wallet, token_hash, created_at) VALUES (?, ?, ?, ?, ?, 0)",
                       (player_id, f"P{player_id}", f"p{player_id}", wallet, f"t{player_id}"))
            db.execute("INSERT OR IGNORE INTO runs (id, player_id, seed, encounters_dog, encounters_son, issued_at) VALUES (?, ?, 1, 0, 0, 0)",
                       (f"r{player_id}", player_id))
            stage = db.execute("SELECT COUNT(*) AS n FROM cash_outs WHERE run_id=?", (f"r{player_id}",)).fetchone()["n"] * 50 + 50
            db.execute("INSERT INTO cash_outs (player_id, run_id, stage, amount_raw, verified_at) VALUES (?, ?, ?, ?, ?)",
                       (player_id, f"r{player_id}", stage, str(amount * KII), when if when is not None else self.clock()))
        db.close()

    def dry_payer(self):
        payer = pay.Payer(self.config.db_path, f"{self.dir}/payer.db", self.config.status_path, clock=self.clock, poll_seconds=0)
        payer.use_wallet(pay.DryRunWallet(payer))
        return payer

    def paid(self, payer, player=None):
        rows = payer.db.execute("SELECT player_id, amount_raw FROM payments").fetchall()
        return sum(int(r["amount_raw"]) for r in rows if player is None or r["player_id"] == player) // KII

    def test_queue_pays_over_days_and_nothing_is_lost(self):
        self.add_cash_out(1, WALLETS[1], 2500)
        payer = self.dry_payer()
        payer.cycle()
        self.assertEqual(self.paid(payer), 1000)
        payer.cycle()
        self.assertEqual(self.paid(payer), 1000, "No more today")
        self.clock.now += 86400
        payer.cycle()
        self.assertEqual(self.paid(payer), 2000)
        self.clock.now += 86400
        payer.cycle()
        self.assertEqual(self.paid(payer), 2500)
        self.clock.now += 86400
        self.assertEqual(payer.cycle(), 0)
        self.assertEqual(self.paid(payer), 2500, "Never more than was earned")

    def test_daily_ceiling_with_a_crowd(self):
        for i in range(100):
            self.add_cash_out(i + 1, chain.account_from_public(chain.public_key(chain.private_from_seed(i.to_bytes(32, "big")))), 1000, when=self.clock() + i)
        payer = self.dry_payer()
        payer.cycle()
        self.assertEqual(self.paid(payer), 62_500)
        self.assertEqual(self.paid(payer, 63), 500)
        self.assertEqual(self.paid(payer, 64), 0)
        payer.cycle()
        self.assertEqual(self.paid(payer), 62_500, "The day's limit holds across cycles")
        self.clock.now += 86400
        payer.cycle()
        self.assertEqual(self.paid(payer), 100_000, "The rest are paid the next day, oldest first")

    def test_banned_players_arent_paid(self):
        self.add_cash_out(1, WALLETS[1], 10)
        db = self.service.db()
        with db:
            db.execute("UPDATE players SET banned=1")
        db.close()
        self.assertEqual(self.dry_payer().cycle(), 0)

    def test_changed_wallet_pauses_payouts(self):
        self.add_cash_out(1, WALLETS[1], 2500)
        payer = self.dry_payer()
        payer.cycle()
        db = self.service.db()
        with db:
            db.execute("UPDATE players SET wallet=? WHERE id=1", (WALLETS[2],))
        db.close()
        self.clock.now += 86400
        self.assertEqual(payer.cycle(), 0)
        self.assertIn("wallet changed", payer.setting("paused"))
        self.assertTrue(json.load(open(self.config.status_path))["paused"])
        self.assertEqual(self.paid(payer), 1000)

    def test_web_service_cant_spend_past_the_caps(self):
        """Even a forged cash-out for a fortune in the web database is held to the payer's limits."""
        self.add_cash_out(1, WALLETS[1], 10**12)
        payer = self.dry_payer()
        payer.cycle()
        self.assertEqual(self.paid(payer), 1000)

    def test_interrupted_planning_returns_to_the_queue(self):
        self.add_cash_out(1, WALLETS[1], 100)
        payer = self.dry_payer()
        payer.db.execute("INSERT INTO payments (cash_out_id, player_id, wallet, amount_raw, day, status, created_at) VALUES (1, 1, ?, ?, ?, 'planned', 0)",
                         (WALLETS[1], str(100 * KII), pay.utc_day(self.clock())))
        payer.db.commit()
        self.assertEqual(payer.cycle(), 1)
        self.assertEqual(self.paid(payer), 100)

    def test_mode_cant_switch_on_one_database(self):
        payer = self.dry_payer()
        with self.assertRaises(SystemExit):
            payer.use_wallet(pay.LiveWallet(payer, FakeNode(b"\x09" * 32), b"\x09" * 32))

    def test_status_has_no_secrets(self):
        self.add_cash_out(1, WALLETS[1], 10)
        self.dry_payer().cycle()
        text = open(self.config.status_path).read()
        self.assertNotIn(WALLETS[1], text)
        self.assertNotIn("block_json", text)

    def test_seed_file_checks(self):
        path = f"{self.dir}/seed"
        seed = b"\x07" * 32
        account = chain.account_from_public(chain.public_key(chain.private_from_seed(seed)))
        with open(path, "w") as handle:
            handle.write(seed.hex())
        os.chmod(path, 0o644)
        with self.assertRaises(SystemExit):
            pay.load_seed(path, account, 0)
        os.chmod(path, 0o600)
        self.assertEqual(pay.load_seed(path, account, 0), chain.private_from_seed(seed))
        with self.assertRaises(SystemExit):
            pay.load_seed(path, WALLETS[0], 0)
        with self.assertRaises(SystemExit):
            pay.load_seed(path, account, 1)
        with open(path, "w") as handle:
            handle.write("not hex")
        with self.assertRaises(SystemExit) as caught:
            pay.load_seed(path, account, 0)
        self.assertNotIn("not hex", str(caught.exception))


class FakeNode:
    """Applies the real node's rules to state sends: chain position, signature, proof of work and balance."""

    def __init__(self, private, balance=25_000_000 * KII):
        self.account = chain.account_from_public(chain.public_key(private))
        self.public = chain.public_key(private)
        self.balance = balance
        self.frontier = "A" * 64
        self.representative = WALLETS[39]
        self.blocks = {}
        self.sent = []
        self.peers = 3
        self.genesis = pay.GENESIS
        self.confirm = True
        self.crash_after_process = False

    def call(self, action, allow_error=False, **fields):
        if action == "version":
            return {"network_identifier": self.genesis}
        if action == "peers":
            return {"peers": {str(i): {} for i in range(self.peers)}}
        if action == "account_info":
            return {"frontier": self.frontier, "balance": str(self.balance), "representative": self.representative}
        if action == "block_info":
            if fields["hash"] in self.blocks:
                return {"confirmed": "true" if self.confirm else "false"}
            return {"error": "Block not found"}
        if action == "process":
            return self.process(fields["block"])
        raise AssertionError(action)

    def process(self, block):
        digest = chain.state_hash(
            chain.decode_account(block["account"]), bytes.fromhex(block["previous"]),
            chain.decode_account(block["representative"]), int(block["balance"]), bytes.fromhex(block["link"]),
        )
        block_hash = digest.hex().upper()
        if block_hash in self.blocks:
            return {"error": "Old block"}
        if block["previous"] != self.frontier:
            return {"error": "Fork"}
        if not chain.ed_verify(bytes.fromhex(block["signature"]), digest, self.public):
            return {"error": "Bad signature"}
        if chain.work_value(int(block["work"], 16), bytes.fromhex(block["previous"])) < 0xfff0000000000000:
            return {"error": "Block work is less than threshold"}
        amount = self.balance - int(block["balance"])
        if amount <= 0:
            return {"error": "Not a send"}
        self.blocks[block_hash] = block
        self.frontier = block_hash
        self.balance = int(block["balance"])
        self.sent.append((block["link_as_account"], amount))
        if self.crash_after_process:
            self.crash_after_process = False
            raise KeyboardInterrupt("crash right after publishing")
        return {"hash": block_hash}


def easy_work(root):
    return chain.generate_work(root, 0xfff0000000000000, processes=1)


class LiveWalletTests(PayerTests):
    """Real signing against a fake node. Nothing here touches a network."""

    def live(self, node, private):
        payer = pay.Payer(self.config.db_path, f"{self.dir}/payer.db", self.config.status_path, clock=self.clock, poll_seconds=0)
        payer.use_wallet(pay.LiveWallet(payer, node, private, work=easy_work))
        return payer

    def setUp(self):
        super().setUp()
        self.private = chain.private_from_seed(b"\x09" * 32)
        self.node = FakeNode(self.private)

    def test_real_blocks_are_accepted(self):
        self.add_cash_out(1, WALLETS[1], 300)
        self.add_cash_out(2, WALLETS[2], 200)
        payer = self.live(self.node, self.private)
        self.assertEqual(payer.cycle(), 2)
        self.assertEqual(self.node.sent, [(WALLETS[1], 300 * KII), (WALLETS[2], 200 * KII)])
        self.assertEqual(self.node.balance, (25_000_000 - 500) * KII)
        self.assertEqual(payer.cycle(), 0)
        self.assertEqual(len(self.node.sent), 2)
        self.assertEqual(payer.db.execute("SELECT COUNT(*) AS n FROM payments WHERE status='confirmed'").fetchone()["n"], 2)

    def test_crash_after_publishing_doesnt_pay_twice(self):
        self.add_cash_out(1, WALLETS[1], 300)
        payer = self.live(self.node, self.private)
        self.node.crash_after_process = True
        with self.assertRaises(KeyboardInterrupt):
            payer.cycle()
        self.assertEqual(payer.db.execute("SELECT status FROM payments").fetchone()["status"], "signed")
        restarted = self.live(self.node, self.private)
        restarted.cycle()
        self.assertEqual(restarted.setting("paused"), None)
        self.assertEqual(self.node.sent, [(WALLETS[1], 300 * KII)], "Paid exactly once")
        self.assertEqual(restarted.db.execute("SELECT status FROM payments").fetchone()["status"], "confirmed")

    def test_crash_before_publishing_sends_the_same_block(self):
        self.add_cash_out(1, WALLETS[1], 300)
        payer = self.live(self.node, self.private)
        original = pay.LiveWallet._publish
        def boom(*_):
            raise KeyboardInterrupt("crash before publishing")
        pay.LiveWallet._publish = boom
        try:
            with self.assertRaises(KeyboardInterrupt):
                payer.cycle()
        finally:
            pay.LiveWallet._publish = original
        saved = payer.db.execute("SELECT block_hash FROM payments").fetchone()["block_hash"]
        self.assertEqual(self.node.sent, [])
        restarted = self.live(self.node, self.private)
        restarted.cycle()
        self.assertEqual(self.node.sent, [(WALLETS[1], 300 * KII)])
        self.assertEqual(self.node.frontier, saved, "The saved block, not a new one")

    def test_someone_else_moving_the_wallet_pauses_payouts(self):
        self.add_cash_out(1, WALLETS[1], 300)
        payer = self.live(self.node, self.private)
        payer.cycle()
        self.node.frontier = "B" * 64
        self.add_cash_out(2, WALLETS[2], 100)
        self.assertEqual(payer.cycle(), 0)
        self.assertIn("something else moved", payer.setting("paused"))
        self.assertEqual(len(self.node.sent), 1)
        self.assertEqual(payer.cycle(), 0, "Stays paused")

    def test_wrong_network_or_thin_mesh_pauses(self):
        self.add_cash_out(1, WALLETS[1], 300)
        self.node.genesis = "F" * 64
        payer = self.live(self.node, self.private)
        payer.cycle()
        self.assertIn("genesis", payer.setting("paused"))
        self.assertEqual(self.node.sent, [])
        payer.db.execute("DELETE FROM settings WHERE key='paused'")
        self.node.genesis = pay.GENESIS
        self.node.peers = 1
        payer.cycle()
        self.assertIn("peers", payer.setting("paused"))
        self.assertEqual(self.node.sent, [])

    def test_unconfirmed_block_is_checked_again(self):
        self.add_cash_out(1, WALLETS[1], 300)
        self.node.confirm = False
        payer = self.live(self.node, self.private)
        pay.CONFIRM_TIMEOUT_SECONDS, saved = 0, pay.CONFIRM_TIMEOUT_SECONDS
        try:
            payer.cycle()
        finally:
            pay.CONFIRM_TIMEOUT_SECONDS = saved
        self.assertIn("isn't confirmed", payer.setting("paused"))
        self.node.confirm = True
        payer.db.execute("DELETE FROM settings WHERE key='paused'")
        payer.cycle()
        self.assertEqual(len(self.node.sent), 1)
        self.assertEqual(payer.db.execute("SELECT status FROM payments").fetchone()["status"], "confirmed")

    def test_send_guards(self):
        wallet = pay.LiveWallet(self.live(self.node, self.private), self.node, self.private, work=easy_work)
        with self.assertRaises(pay.Paused):
            wallet.send(1, self.node.account, KII)
        with self.assertRaises(pay.Paused):
            wallet.send(1, WALLETS[1], 1001 * KII)
        with self.assertRaises(pay.Paused):
            wallet.send(1, WALLETS[1], 0)
        self.node.balance = KII
        with self.assertRaises(pay.Paused):
            wallet.send(1, WALLETS[1], 2 * KII)
        self.assertEqual(self.node.sent, [])

    # The dry-run-specific tests inherited from PayerTests don't apply to this class
    test_queue_pays_over_days_and_nothing_is_lost = None
    test_daily_ceiling_with_a_crowd = None
    test_banned_players_arent_paid = None
    test_changed_wallet_pauses_payouts = None
    test_web_service_cant_spend_past_the_caps = None
    test_interrupted_planning_returns_to_the_queue = None
    test_mode_cant_switch_on_one_database = None
    test_status_has_no_secrets = None
    test_seed_file_checks = None


class BrowserTests(unittest.TestCase):
    """The real game in real Chrome, against the real services, in dry-run mode."""

    def test_register_play_cash_out_and_get_listed(self):
        chrome = os.environ.get("CHROME") or shutil.which("google-chrome")
        if not chrome:
            self.skipTest("Chrome isn't installed")
        folder = tempfile.mkdtemp(prefix="alpha-browser-test-")
        config = web.Config(
            db_path=f"{folder}/app.db", status_path=f"{folder}/status.json", replay_cmd=REPLAY_CMD, port=0,
            test_debug_start=DEBUG_START,
        )
        service = web.Service(config)
        api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), web.make_handler(service))
        api.RequestHandlerClass.log_message = lambda *a: None
        threading.Thread(target=api.serve_forever, daemon=True).start()
        threading.Thread(target=service.worker, daemon=True).start()
        api_base = f"http://127.0.0.1:{api.server_address[1]}"

        bot = (ROOT / "tools" / "replay_bot.mjs").read_text().replace("export function", "function")
        page = (ROOT / "index.html").read_text()
        # Whatever address the release points at, this test must only ever talk to its own local server
        page, swapped = re.subn(r'(id="apiBaseMeta" name="alpha-miner-api" content=")[^"]*"', rf'\g<1>{api_base}"', page)
        self.assertEqual(swapped, 1)
        # Starts with a saved login the server has never heard of, as every player has after a wipe
        stale = """<script>localStorage.setItem('alphaMiner.account', JSON.stringify({ign: 'Old', wallet: 'x', token: 'x'.repeat(30)}));</script>"""
        page = page.replace("</head>", stale + "</head>")
        probe = """<script>%s
window.addEventListener('load', () => {
  const app = window.dwarfKiiApp, c = app.controller, $ = (id) => document.getElementById(id);
  const signUp = setInterval(() => {
    if ($('registerModal').classList.contains('hidden')) return;
    clearInterval(signUp);
    $('inputIgn').value = 'ChromeMiner';
    $('inputWallet').value = '%s';
    $('btnRegister').click();
  }, 100);
  let state = 5;
  const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  setInterval(() => {
    if (!$('runStatus').textContent.includes('verified')) return;
    if (c.cashOutOfferOpen) { $('btnCashOutAccept').click(); return; }
    const shot = bestShot(c, rand);
    if (shot) c.setAim(shot.angle, shot.power);
    c.lobPickaxe();
  }, 150);
});
</script>""" % (bot, GOOD_WALLET)
        page = page.replace("</body>", probe + "</body>")

        class Static(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == "/":
                    data, kind = page.encode(), "text/html"
                else:
                    file = (ROOT / path.lstrip("/")).resolve()
                    if ROOT not in file.parents or not file.is_file():
                        self.send_response(404)
                        self.end_headers()
                        return
                    data, kind = file.read_bytes(), {".js": "text/javascript", ".png": "image/png"}.get(file.suffix, "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        site = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Static)
        threading.Thread(target=site.serve_forever, daemon=True).start()
        profile = tempfile.mkdtemp(prefix="alpha-browser-profile-")
        browser = subprocess.Popen(
            [chrome, "--headless=new", "--disable-gpu", "--mute-audio", "--no-first-run", f"--user-data-dir={profile}",
             "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
             f"http://127.0.0.1:{site.server_address[1]}/"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.time() + 240
            rows = []
            while time.time() < deadline:
                db = service.db()
                rows = db.execute("SELECT * FROM cash_outs").fetchall()
                bad = db.execute("SELECT reason FROM submissions WHERE status='rejected'").fetchall()
                db.close()
                self.assertEqual([r["reason"] for r in bad], [])
                if rows:
                    break
                time.sleep(1)
            self.assertTrue(rows, "The game should reach a verified cash-out")
            payer = pay.Payer(config.db_path, f"{folder}/payer.db", config.status_path)
            payer.use_wallet(pay.DryRunWallet(payer))
            self.assertEqual(payer.cycle(), 1)
            board = service.leaderboard()[1]
            self.assertEqual(board["players"][0]["ign"], "ChromeMiner")
            self.assertGreater(int(board["players"][0]["paidRaw"]), 0)
            self.assertEqual(board["mode"], "dry_run")
            print(f"\n  Chrome run verified: stage {rows[0]['stage']}, {int(rows[0]['amount_raw']) // KII} KII, dry-run paid")
        finally:
            browser.kill()
            browser.wait()
            site.shutdown()
            api.shutdown()
            service.stopping = True
            service.wake.set()
            time.sleep(0.5)
            shutil.rmtree(profile, ignore_errors=True)
            shutil.rmtree(folder, ignore_errors=True)


class ReceiptNode:
    """Just the read-only calls the receipt signer makes, serving a chain of sends."""

    def __init__(self):
        self.sends = []
        self.genesis = pay.GENESIS
        self.confirmed = True

    def send(self, destination, amount):
        self.sends.append({"hash": f"{len(self.sends) + 1:064X}", "destination": destination, "amount": amount})
        return self.sends[-1]["hash"]

    def call(self, action, allow_error=False, **fields):
        if action == "version":
            return {"network_identifier": self.genesis}
        if action == "account_history":
            start = 0
            if "head" in fields:
                start = next(i for i, s in enumerate(self.sends) if s["hash"] == fields["head"])
            page = self.sends[start:start + 2]
            reply = {"history": [{"type": "state", "subtype": "send", "hash": s["hash"]} for s in page]}
            if start + 2 < len(self.sends):
                reply["next"] = self.sends[start + 2]["hash"]
            return reply
        if action == "block_info":
            sent = next(s for s in self.sends if s["hash"] == fields["hash"])
            return {"confirmed": "true" if self.confirmed else "false", "amount": str(sent["amount"]),
                    "height": str(self.sends.index(sent) + 1), "contents": {"link_as_account": sent["destination"]}}
        raise AssertionError(action)


class ReceiptTests(Stack):
    def setUp(self):
        super().setUp()
        self.node = ReceiptNode()
        self.key = b"\x07" * 32
        self.public = f"{self.dir}/receipts.json"
        self.config.receipts_path = self.public
        self.signer = signer.ReceiptSigner(self.config.db_path, f"{self.dir}/receipts.db", self.public, self.node,
                                           pay.ALPHA_WALLET, self.key, pay.GENESIS, clock=self.clock)

    def add_cash_out(self, player_id, wallet, amount, stage=50):
        db = self.service.db()
        with db:
            db.execute("INSERT OR IGNORE INTO players (id, ign, ign_key, wallet, token_hash, created_at) VALUES (?, ?, ?, ?, ?, 0)",
                       (player_id, f"Player{player_id}", f"player{player_id}", wallet, f"hash{player_id}"))
            db.execute("INSERT OR IGNORE INTO runs (id, player_id, seed, encounters_dog, encounters_son, issued_at) VALUES (?, ?, 1, 0, 0, 0)",
                       (f"run{player_id}", player_id))
            db.execute("INSERT INTO cash_outs (player_id, run_id, stage, amount_raw, verified_at) VALUES (?, ?, ?, ?, ?)",
                       (player_id, f"run{player_id}", stage, str(amount), stage))
        db.close()

    def published(self):
        with open(self.public) as handle:
            return json.load(handle)

    def test_payout_gets_a_signature_anyone_can_check(self):
        self.add_cash_out(1, WALLETS[0], 300 * KII)
        block = self.node.send(WALLETS[0], 300 * KII)
        self.assertEqual(self.signer.cycle(), 1)
        data = self.published()
        self.assertEqual(signer.check_published(data), (1, 0))
        receipt = data["receipts"][0]["receipt"]
        self.assertEqual((receipt["block"], receipt["ign"], receipt["amountRaw"]), (block, "Player1", str(300 * KII)))
        self.assertEqual(receipt["cashOuts"], [{"run": "run1", "stage": 50, "amountRaw": str(300 * KII)}])
        self.assertEqual(data["publicKey"], chain.public_key(self.key).hex().upper())
        data["receipts"][0]["receipt"]["amountRaw"] = str(301 * KII)
        self.assertEqual(signer.check_published(data), (0, 1), "An altered receipt must fail")
        self.assertEqual(self.signer.cycle(), 0, "A second pass signs nothing new")

    def test_payout_split_over_days_is_matched_across_cash_outs(self):
        self.add_cash_out(1, WALLETS[0], 1500 * KII, stage=50)
        self.add_cash_out(1, WALLETS[0], 200 * KII, stage=100)
        for amount in (1000, 500, 200):
            self.node.send(WALLETS[0], amount * KII)
        self.assertEqual(self.signer.cycle(), 3)
        data = self.published()
        self.assertEqual(signer.check_published(data), (3, 0))
        self.assertEqual(data["unmatched"], [])

    def test_a_send_with_no_verified_cash_out_gets_no_receipt(self):
        self.add_cash_out(1, WALLETS[0], 100 * KII)
        self.node.send(WALLETS[1], 5000 * KII)  # to a stranger
        self.node.send(WALLETS[0], 101 * KII)  # to a player, more than they earned
        self.assertEqual(self.signer.cycle(), 0)
        data = self.published()
        self.assertEqual(data["receipts"], [])
        self.assertEqual(len(data["unmatched"]), 2)

    def test_unconfirmed_sends_wait(self):
        self.add_cash_out(1, WALLETS[0], 100 * KII)
        self.node.send(WALLETS[0], 100 * KII)
        self.node.confirmed = False
        self.assertEqual(self.signer.cycle(), 0)
        self.node.confirmed = True
        self.assertEqual(self.signer.cycle(), 1)

    def test_wrong_network_is_refused(self):
        self.node.genesis = "B" * 64
        with self.assertRaises(RuntimeError):
            self.signer.cycle()

    def test_web_service_serves_receipts(self):
        self.assertEqual(self.call("GET", "/api/receipts")[1]["receipts"], [])
        self.add_cash_out(1, WALLETS[0], 100 * KII)
        self.node.send(WALLETS[0], 100 * KII)
        self.signer.cycle()
        self.assertEqual(self.call("GET", "/api/receipts")[1]["receiptCount"], 1)

    def test_key_is_private_and_kept(self):
        path = f"{self.dir}/key"
        first = signer.load_or_create_key(path)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(signer.load_or_create_key(path), first)


class GoLiveScriptTests(unittest.TestCase):
    """Runs go_live.sh for real, with the system commands stubbed and everything in a temporary folder."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="alpha-go-live-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.bin = f"{self.dir}/bin"
        self.data = f"{self.dir}/data"
        os.makedirs(self.bin)
        for part in ("shared", "payer", "receipts"):
            os.makedirs(f"{self.data}/{part}")
        for name, body in {"id": 'echo 0', "chown": "exit 0", "sleep": "exit 0", "systemctl": 'echo "$@" >> "$ALPHA_DATA/systemctl.log"',
                           "sudo": 'shift 2; exec "$@"'}.items():
            path = f"{self.bin}/{name}"
            with open(path, "w") as handle:
                handle.write(f"#!/bin/bash\n{body}\n")
            os.chmod(path, 0o755)
        self.seed = "ab" * 32
        self.account = chain.account_from_public(chain.public_key(chain.private_from_seed(bytes.fromhex(self.seed))))
        for name in ("shared/app.db", "shared/status.json", "payer/payer.db", "receipts/receipts.db", "receipts/key"):
            with open(f"{self.data}/{name}", "w") as handle:
                handle.write("old")

    def run_script(self, typed):
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", ALPHA_DATA=self.data, ALPHA_DROP_IN=f"{self.dir}/drop",
                   ALPHA_SERVER=str(HERE), ALPHA_ACCOUNT=self.account, PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run(["bash", str(HERE / "deploy" / "go_live.sh")], input=typed, env=env, capture_output=True, text=True)

    def exists(self, name):
        return os.path.exists(f"{self.data}/{name}")

    def test_good_seed_wipes_and_goes_live_once(self):
        done = self.run_script(f"GO LIVE\n{self.seed}\n")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertNotIn(self.seed, done.stdout + done.stderr, "The seed must never be printed")
        self.assertFalse(self.exists("shared/app.db") or self.exists("payer/payer.db") or self.exists("receipts/receipts.db"))
        self.assertTrue(self.exists("receipts/key"), "The receipt key is kept")
        self.assertEqual(stat.S_IMODE(os.stat(f"{self.data}/payer/seed").st_mode), 0o600)
        with open(f"{self.dir}/drop/live.conf") as handle:
            self.assertIn("PAYER_MODE=live", handle.read())
        with open(f"{self.data}/shared/app.db", "w") as handle:
            handle.write("real records")
        again = self.run_script(f"GO LIVE\n{self.seed}\n")
        self.assertEqual(again.returncode, 1)
        self.assertIn("already live", again.stdout)
        self.assertTrue(self.exists("shared/app.db"), "A second run must not wipe real records")

    def test_wrong_seed_changes_nothing(self):
        done = self.run_script(f"GO LIVE\n{'cd' * 32}\n")
        self.assertEqual(done.returncode, 1)
        self.assertNotIn("cd" * 32, done.stdout + done.stderr)
        self.assertFalse(self.exists("payer/seed"), "A wrong seed must not stay on disk")
        self.assertTrue(self.exists("shared/app.db") and self.exists("payer/payer.db"))
        self.assertFalse(os.path.exists(f"{self.dir}/drop/live.conf"))

    def test_needs_the_exact_phrase(self):
        done = self.run_script("yes\n")
        self.assertEqual(done.returncode, 1)
        self.assertTrue(self.exists("shared/app.db"))
        self.assertFalse(self.exists("payer/seed"))


class DeployUnitTests(unittest.TestCase):
    def test_replay_cmd_survives_systemd_quoting(self):
        # systemd removes unescaped quotes the way a shell does, so shlex shows the value the service will get
        import shlex
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy", "alpha-web.service")
        with open(path) as unit:
            line = next(l for l in unit if "REPLAY_CMD=" in l and not l.startswith("#"))
        value = shlex.split(line.strip().removeprefix("Environment="))[0].split("=", 1)[1]
        command = json.loads(value)
        self.assertEqual(os.path.basename(command[1]), "replay_run.mjs")


if __name__ == "__main__":
    unittest.main(verbosity=1)
