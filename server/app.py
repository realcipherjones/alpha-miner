#!/usr/bin/env python3
"""Public web service: IGN registration, run seeds, replay verification and the leaderboard. Holds no keys.

A run is only payable if the server issued its seed, it starts with an empty bank, its log replays to a matching
result in the real game code, and it took at least as long as it claims. Amounts always come from the replay.
"""
import gzip
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import kii_chain as chain
import store

HERE = os.path.dirname(os.path.abspath(__file__))
REPLAY_VERSION = 1
IGN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,16}$")
MAX_BODY_BYTES = 32 * 1024 * 1024
REAL_TIME_SLACK_SECONDS = 30
RECENT_RUN_GRACE_SECONDS = 600
STEPS_PER_SECOND = 60


@dataclass
class Config:
    db_path: str = "app.db"
    status_path: str = "status.json"
    replay_cmd: list = field(default_factory=lambda: ["node", os.path.join(HERE, "..", "tools", "replay_run.mjs")])
    replay_timeout_seconds: int = 900
    host: str = "127.0.0.1"
    port: int = 8787
    trust_proxy: bool = False
    reserved_wallets: frozenset = frozenset()
    receipts_path: str = ""
    clock: object = time.time
    # Tests only. There's deliberately no environment setting for this, so it can't be turned on in production.
    test_debug_start: dict = None
    limits: dict = field(default_factory=lambda: {
        "register": (5, 3600),   # per IP
        "start": (60, 3600),     # per player
        "submit": (30, 3600),    # per player
    })


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class RateLimiter:
    def __init__(self, clock):
        self.clock = clock
        self.hits = {}
        self.lock = threading.Lock()

    def check(self, bucket, key, limit, window):
        now = self.clock()
        with self.lock:
            recent = [t for t in self.hits.get((bucket, key), []) if t > now - window]
            if len(recent) >= limit:
                raise ApiError(429, "Too many requests. Try again later.")
            recent.append(now)
            self.hits[(bucket, key)] = recent


def policy_error(log, run, config, elapsed_seconds):
    """Rules checked before spending CPU on a replay, and again against the replay's own result."""
    if not isinstance(log, dict) or not isinstance(log.get("header"), dict):
        return "malformed log"
    header = log["header"]
    if header.get("version") != REPLAY_VERSION:
        return "game version is out of date"
    if header.get("seed") != run["seed"]:
        return "seed wasn't issued for this run"
    encounters = header.get("bossEncounters") or {}
    if encounters.get("dog") != run["encounters_dog"] or encounters.get("son") != run["encounters_son"]:
        return "boss history doesn't match the server's"
    if config.test_debug_start:
        if header.get("debug") != {"stage": config.test_debug_start.get("stage")}:
            return "test start doesn't match"
        if header.get("startBalanceRaw") != config.test_debug_start.get("startBalanceRaw", "0"):
            return "test balance doesn't match"
    else:
        if "debug" in header:
            return "debug starts aren't payable"
        if header.get("startBalanceRaw") != "0":
            return "run didn't start with an empty bank"
    if header.get("freeLobs") != 0:
        return "run didn't start with zero free lobs"
    ticks = log.get("ticks")
    if not isinstance(ticks, int) or isinstance(ticks, bool) or ticks < 0:
        return "bad tick count"
    if ticks / STEPS_PER_SECOND > elapsed_seconds + REAL_TIME_SLACK_SECONDS:
        return "run claims more play time than has passed"
    return None


class Service:
    def __init__(self, config):
        self.config = config
        self.limiter = RateLimiter(config.clock)
        self.wake = threading.Event()
        self.stopping = False
        store.connect(config.db_path).close()

    def db(self):
        return store.connect(self.config.db_path)

    # --- players ---------------------------------------------------------------------------------------------

    def register(self, ip, body):
        self.limiter.check("register", ip, *self.config.limits["register"])
        ign = body.get("ign")
        wallet = body.get("wallet")
        if not isinstance(ign, str) or not IGN_PATTERN.match(ign):
            raise ApiError(400, "IGN must be 3-16 letters, numbers, _ or -.")
        try:
            chain.decode_account(wallet)
        except ValueError:
            raise ApiError(400, "That isn't a valid kii_ wallet address.") from None
        if wallet in self.config.reserved_wallets:
            raise ApiError(400, "That wallet can't be used.")
        token = secrets.token_urlsafe(32)
        db = self.db()
        try:
            with db:
                db.execute(
                    "INSERT INTO players (ign, ign_key, wallet, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                    (ign, ign.lower(), wallet, hash_token(token), self.config.clock()),
                )
        except Exception as err:
            if "ign_key" in str(err):
                raise ApiError(409, "That IGN is taken.") from None
            if "wallet" in str(err):
                raise ApiError(409, "That wallet already has an IGN.") from None
            raise
        finally:
            db.close()
        return 201, {"ign": ign, "wallet": wallet, "token": token}

    def player(self, db, authorization):
        match = re.fullmatch(r"Bearer ([A-Za-z0-9_-]{20,100})", authorization or "")
        row = db.execute("SELECT * FROM players WHERE token_hash=?", (hash_token(match.group(1)),)).fetchone() if match else None
        if row is None:
            raise ApiError(401, "Sign-in is missing or invalid.")
        if row["banned"]:
            raise ApiError(403, "This account can't earn payouts.")
        return row

    def me(self, authorization):
        db = self.db()
        try:
            player = self.player(db, authorization)
            status = self.payer_status()
            paid = status.get("paidByCashOut", {})
            cash_outs = [
                {
                    "stage": row["stage"],
                    "amountRaw": row["amount_raw"],
                    "paidRaw": paid.get(str(row["id"]), "0"),
                    "verifiedAt": row["verified_at"],
                }
                for row in db.execute(
                    "SELECT * FROM cash_outs WHERE player_id=? ORDER BY id DESC LIMIT 50", (player["id"],)
                )
            ]
            rejected = db.execute(
                "SELECT s.reason FROM submissions s JOIN runs r ON r.id = s.run_id "
                "WHERE r.player_id=? AND s.status='rejected' ORDER BY s.id DESC LIMIT 1",
                (player["id"],),
            ).fetchone()
            return 200, {
                "ign": player["ign"],
                "wallet": player["wallet"],
                "bestStage": player["best_stage"],
                "cashOuts": cash_outs,
                "lastRejection": rejected["reason"] if rejected else None,
                "mode": status.get("mode"),
            }
        finally:
            db.close()

    # --- runs ------------------------------------------------------------------------------------------------

    def start_run(self, authorization):
        db = self.db()
        try:
            player = self.player(db, authorization)
            self.limiter.check("start", player["id"], *self.config.limits["start"])
            run_id = secrets.token_urlsafe(16)
            seed = secrets.randbits(32)
            now = self.config.clock()
            # One live run per player: this caps payable play time at real time, however many copies are running
            with db:
                db.execute("UPDATE runs SET closed_at=? WHERE player_id=? AND closed_at IS NULL", (now, player["id"]))
                db.execute(
                    "INSERT INTO runs (id, player_id, seed, encounters_dog, encounters_son, issued_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (run_id, player["id"], seed, player["encounters_dog"], player["encounters_son"], now),
                )
            reply = {
                "runId": run_id,
                "seed": seed,
                "bossEncounters": {"dog": player["encounters_dog"], "son": player["encounters_son"]},
            }
            if self.config.test_debug_start:
                reply["debugStart"] = self.config.test_debug_start
            return 201, reply
        finally:
            db.close()

    def submit_run(self, authorization, run_id, body):
        db = self.db()
        try:
            player = self.player(db, authorization)
            self.limiter.check("submit", player["id"], *self.config.limits["submit"])
            run = db.execute("SELECT * FROM runs WHERE id=? AND player_id=?", (run_id, player["id"])).fetchone()
            if run is None:
                raise ApiError(404, "No such run.")
            now = self.config.clock()
            if run["closed_at"] is not None and now - run["closed_at"] > RECENT_RUN_GRACE_SECONDS:
                raise ApiError(410, "That run has closed.")
            ended = run["closed_at"] if run["closed_at"] is not None else now
            elapsed = ended - run["issued_at"]
            log = body.get("log")
            problem = policy_error(log, run, self.config, elapsed)
            if problem:
                raise ApiError(422, problem)
            if log["ticks"] <= run["verified_ticks"]:
                return 200, {"status": "already_verified"}
            blob = gzip.compress(json.dumps(log, separators=(",", ":")).encode())
            with db:
                cursor = db.execute(
                    "INSERT INTO submissions (run_id, received_at, elapsed_seconds, log_gz) VALUES (?, ?, ?, ?)",
                    (run_id, now, elapsed, blob),
                )
            self.wake.set()
            return 202, {"status": "pending", "submissionId": cursor.lastrowid}
        finally:
            db.close()

    # --- verification ----------------------------------------------------------------------------------------

    def replay(self, log_bytes):
        try:
            done = subprocess.run(
                self.config.replay_cmd, input=log_bytes, capture_output=True, timeout=self.config.replay_timeout_seconds
            )
            return json.loads(done.stdout)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "replay timed out"}
        except ValueError:
            return {"ok": False, "error": "verifier gave no result"}

    def verify_next(self):
        """Verify the oldest pending submission. Returns False when there's nothing to do."""
        db = self.db()
        try:
            sub = db.execute("SELECT * FROM submissions WHERE status='pending' ORDER BY id LIMIT 1").fetchone()
            if sub is None:
                return False
            run = db.execute("SELECT * FROM runs WHERE id=?", (sub["run_id"],)).fetchone()
            log_bytes = gzip.decompress(sub["log_gz"])
            log = json.loads(log_bytes)
            problem = policy_error(log, run, self.config, sub["elapsed_seconds"])
            result = None
            if not problem:
                result = self.replay(log_bytes)
                if not result.get("ok"):
                    problem = result.get("error", "replay failed")
                elif not result.get("matches"):
                    problem = f"replay didn't match the game's result (stage {result.get('firstDesyncStage')})"
                elif result.get("seed") != run["seed"]:
                    problem = "replay used the wrong seed"
                elif result.get("ticks") != log["ticks"]:
                    problem = "replay length didn't match"
            if problem:
                with db:
                    db.execute("UPDATE submissions SET status='rejected', reason=? WHERE id=?", (problem, sub["id"]))
                return True
            now = self.config.clock()
            with db:
                for cash_out in result["cashOuts"]:
                    amount = int(cash_out["amountRaw"])
                    if amount > 0:
                        db.execute(
                            "INSERT OR IGNORE INTO cash_outs (player_id, run_id, stage, amount_raw, verified_at) VALUES (?, ?, ?, ?, ?)",
                            (run["player_id"], run["id"], cash_out["stage"], str(amount), now),
                        )
                encounters = result["bossEncounters"]
                db.execute(
                    "UPDATE players SET best_stage=MAX(best_stage, ?), encounters_dog=MAX(encounters_dog, ?), "
                    "encounters_son=MAX(encounters_son, ?) WHERE id=?",
                    (result["stage"], encounters["dog"], encounters["son"], run["player_id"]),
                )
                db.execute("UPDATE runs SET verified_ticks=MAX(verified_ticks, ?) WHERE id=?", (result["ticks"], run["id"]))
                db.execute("UPDATE submissions SET status='verified' WHERE id=?", (sub["id"],))
            return True
        finally:
            db.close()

    def worker(self):
        while not self.stopping:
            try:
                while self.verify_next():
                    pass
            except Exception as err:  # keep verifying later submissions
                print(f"verifier error: {err}", file=sys.stderr, flush=True)
            self.wake.wait(5)
            self.wake.clear()

    # --- leaderboard -----------------------------------------------------------------------------------------

    def receipts(self):
        """Published by receipts.py. Signed, so this service can't alter them without it showing."""
        try:
            with open(self.config.receipts_path) as handle:
                return 200, json.load(handle)
        except (OSError, ValueError):
            return 200, {"publicKey": None, "receiptCount": 0, "unmatched": [], "receipts": []}

    def payer_status(self):
        try:
            with open(self.config.status_path) as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return {}

    def leaderboard(self):
        db = self.db()
        try:
            status = self.payer_status()
            paid_by_player = status.get("paidByPlayer", {})
            names = {}
            rows = []
            for row in db.execute("SELECT id, ign, best_stage FROM players WHERE banned = 0"):
                names[row["id"]] = row
            totals = {}
            for row in db.execute("SELECT player_id, amount_raw FROM cash_outs"):
                totals[row["player_id"]] = totals.get(row["player_id"], 0) + int(row["amount_raw"])
            for player_id, row in names.items():
                total = totals.get(player_id, 0)
                paid = int(paid_by_player.get(str(player_id), "0"))
                if total > 0 or row["best_stage"] > 0:
                    rows.append({"ign": row["ign"], "bestStage": row["best_stage"], "earnedRaw": str(total), "paidRaw": str(paid), "queuedRaw": str(max(0, total - paid))})
            rows.sort(key=lambda r: (-int(r["earnedRaw"]), -r["bestStage"], r["ign"].lower()))
            queued = sum(int(r["queuedRaw"]) for r in rows)
            recent = [
                {**{k: v for k, v in item.items() if k != "playerId"}, "ign": names[item["playerId"]]["ign"]}
                for item in status.get("recent", []) if item["playerId"] in names
            ]
            return 200, {
                "players": rows[:100],
                "recent": recent,
                "queuedRaw": str(queued),
                "paidTodayRaw": status.get("paidTodayRaw", "0"),
                "walletCeilingRaw": status.get("walletCeilingRaw"),
                "mode": status.get("mode"),
                "paused": status.get("paused", False),
                "updatedAt": status.get("updatedAt"),
            }
        finally:
            db.close()


def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AlphaMiner"
        sys_version = ""
        timeout = 60

        def log_message(self, fmt, *args):
            print(f"{self.client_ip()} {fmt % args}", file=sys.stderr, flush=True)

        def client_ip(self):
            if service.config.trust_proxy:
                forwarded = self.headers.get("X-Forwarded-For", "")
                if forwarded:
                    return forwarded.split(",")[-1].strip()
            return self.client_address[0]

        def send_body(self, status, content_type, data):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            # Tokens travel in a header, never cookies, so any origin (the game runs from a local file) is safe
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def send_json(self, status, value):
            self.send_body(status, "application/json", json.dumps(value).encode())

        def read_json(self):
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self.close_connection = True
                raise ApiError(411, "Content-Length is required.") from None
            if length < 0 or length > MAX_BODY_BYTES:
                self.close_connection = True
                raise ApiError(413, "That request is too large.")
            try:
                value = json.loads(self.rfile.read(length))
            except ValueError:
                raise ApiError(400, "Request isn't valid JSON.") from None
            if not isinstance(value, dict):
                raise ApiError(400, "Request must be a JSON object.")
            return value

        def route(self, handler):
            try:
                self.send_json(*handler())
            except ApiError as err:
                self.send_json(err.status, {"error": err.message})
            except Exception as err:
                print(f"server error: {err!r}", file=sys.stderr, flush=True)
                self.send_json(500, {"error": "Server error."})

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?")[0]
            auth = self.headers.get("Authorization")
            if path == "/api/leaderboard":
                self.route(service.leaderboard)
            elif path == "/api/receipts":
                self.route(service.receipts)
            elif path == "/api/me":
                self.route(lambda: service.me(auth))
            elif path == "/":
                with open(os.path.join(HERE, "static", "index.html"), "rb") as handle:
                    self.send_body(200, "text/html; charset=utf-8", handle.read())
            else:
                self.send_json(404, {"error": "Not found."})

        def do_POST(self):
            path = self.path.split("?")[0]
            auth = self.headers.get("Authorization")
            submit = re.fullmatch(r"/api/runs/([A-Za-z0-9_-]{10,40})/submit", path)
            if path == "/api/register":
                self.route(lambda: service.register(self.client_ip(), self.read_json()))
            elif path == "/api/runs":
                self.route(lambda: service.start_run(auth))
            elif submit:
                self.route(lambda: service.submit_run(auth, submit.group(1), self.read_json()))
            else:
                self.send_json(404, {"error": "Not found."})

    return Handler


def serve(config):
    service = Service(config)
    threading.Thread(target=service.worker, daemon=True).start()
    server = ThreadingHTTPServer((config.host, config.port), make_handler(service))
    return service, server


def main():
    env = os.environ
    config = Config(
        db_path=env.get("APP_DB", "app.db"),
        status_path=env.get("PAYER_STATUS", "status.json"),
        host=env.get("APP_HOST", "127.0.0.1"),
        port=int(env.get("APP_PORT", "8787")),
        trust_proxy=env.get("APP_TRUST_PROXY") == "yes",
        receipts_path=env.get("RECEIPTS_PUBLIC", ""),
    )
    if env.get("REPLAY_CMD"):
        config.replay_cmd = json.loads(env["REPLAY_CMD"])
    wallets = [w for w in env.get("APP_RESERVED_WALLETS", "").split(",") if w]
    config.reserved_wallets = frozenset(wallets)
    _, server = serve(config)
    print(f"listening on {config.host}:{config.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
