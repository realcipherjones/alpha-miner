#!/usr/bin/env python3
"""Runs the real payer against real KII nodes on a throwaway local test network, in its own containers.

    python3 server/rehearse_testnet.py [~/kii]

Uses only the THROWAWAY test keys. Every RPC target must report network "test", or this stops at once.
It starts fresh nodes with temporary ledgers and removes them afterwards. Needs ports 17701-17704 free.
"""
import json
import os
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import kii_chain as chain  # noqa: E402
import payer as pay  # noqa: E402
import receipts  # noqa: E402
import store  # noqa: E402

KII_HOME = Path(sys.argv[1] if len(sys.argv) > 1 else "~/kii").expanduser()
IMAGE = "localhost/kii-node:test"
NETWORK = "kii-paytest"
NODES = {"rep1": 17701, "rep2": 17702, "rep3": 17703, "game": 17704}
KEYS = KII_HOME / "node/testnet/THROWAWAY-test-keys.json"
SETUP = KII_HOME / "node/kii-node/kii-testnet/setup.py"
KII = chain.KII
FAILED = []


def podman(*args, check=True):
    return subprocess.run(["podman", *args], check=check, capture_output=True, text=True)


def start_nodes():
    podman("network", "create", NETWORK, check=False)
    peers = json.dumps([f"kii-paytest-{n}" for n in NODES], separators=(",", ":"))
    for name, port in NODES.items():
        podman(
            "run", "-d", "--rm", "--name", f"kii-paytest-{name}", "--hostname", f"kii-paytest-{name}", "--network", NETWORK,
            "-p", f"127.0.0.1:{port}:17617", "-e", "KII_TEST_WALLET_SCAN_REPS_DELAY=5000", IMAGE,
            "--config", f"node.enable_voting={'false' if name == 'game' else 'true'}",
            "--config", "node.allow_local_peers=true", "--config", f"node.preconfigured_peers={peers}",
            "--config", "rpc.enable=true", "--rpcconfig", "address=::", "--rpcconfig", "enable_control=true",
        )


def stop_nodes():
    for name in NODES:
        podman("rm", "-f", "-t", "2", f"kii-paytest-{name}", check=False)
    podman("network", "rm", "-f", NETWORK, check=False)


def wait_for_nodes():
    for name, port in NODES.items():
        rpc = chain.NodeRpc(f"http://127.0.0.1:{port}")
        for _ in range(120):
            try:
                version = rpc.call("version")
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise SystemExit(f"{name} didn't start")
        if version["network"] != "test":
            raise SystemExit(f"{name} reports network {version['network']!r}; this only runs on the test network")


def wait_confirmed_everywhere(block_hash, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(chain.NodeRpc(f"http://127.0.0.1:{p}").call("block_info", allow_error=True, hash=block_hash, json_block="true").get("confirmed") == "true" for p in NODES.values()):
            return
        time.sleep(0.5)
    raise SystemExit(f"{block_hash} didn't confirm on all nodes")


def fund_wallet(game, keys, private, amount):
    """Moves throwaway KII to a new wallet the way a top-up would: a send, then a receive."""
    cold = keys["cold_1"]
    account = chain.account_from_public(chain.public_key(private))
    info = game.call("account_info", account=cold["account"], representative="true")
    send = game.call("block_create", json_block="true", type="state", key=cold["private"], account=cold["account"], previous=info["frontier"],
                     representative=info["representative"], balance=str(int(info["balance"]) - amount), link=account)["block"]
    send_hash = game.call("process", json_block="true", subtype="send", block=send)["hash"]
    wait_confirmed_everywhere(send_hash)
    opened = game.call("block_create", json_block="true", type="state", key=private.hex().upper(), account=account, previous="0" * 64,
                       representative=info["representative"], balance=str(amount), link=send_hash)["block"]
    wait_confirmed_everywhere(game.call("process", json_block="true", subtype="receive", block=opened)["hash"])
    return account


def add_cash_out(path, player_id, wallet, amount, stage=50):
    db = store.connect(path)
    with db:
        db.execute("INSERT OR IGNORE INTO players (id, ign, ign_key, wallet, token_hash, created_at) VALUES (?, ?, ?, ?, ?, 0)",
                   (player_id, f"Test{player_id}", f"test{player_id}", wallet, f"t{player_id}"))
        db.execute("INSERT OR IGNORE INTO runs (id, player_id, seed, encounters_dog, encounters_son, issued_at) VALUES (?, ?, 1, 0, 0, 0)",
                   (f"run{player_id}", player_id))
        db.execute("INSERT INTO cash_outs (player_id, run_id, stage, amount_raw, verified_at) VALUES (?, ?, ?, ?, ?)",
                   (player_id, f"run{player_id}", stage, str(amount), time.time()))
    db.close()


def check(name, passed):
    print(("PASS " if passed else "FAIL ") + name, flush=True)
    if not passed:
        FAILED.append(name)


def main():
    if not KEYS.exists() or "THROWAWAY" not in KEYS.name:
        raise SystemExit(f"throwaway keys not found at {KEYS}")
    stop_nodes()
    # These same ports are the usual tunnel to the live node. Throwaway test keys must never reach it.
    for port in NODES.values():
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise SystemExit(f"port {port} is in use, possibly by a tunnel to the live node. Close it and run this again.")
    folder = tempfile.mkdtemp(prefix="alpha-rehearsal-")
    try:
        start_nodes()
        wait_for_nodes()
        print("nodes up, running the genesis split", flush=True)
        subprocess.run([sys.executable, str(SETUP), str(KEYS), f"{folder}/state.json"], check=True, stdout=subprocess.DEVNULL)
        game = chain.NodeRpc(f"http://127.0.0.1:{NODES['game']}")
        keys = json.load(open(KEYS))["keys"]
        genesis = game.call("version")["network_identifier"].upper()

        seed = secrets.token_bytes(32)
        private = chain.private_from_seed(seed)
        funded = 1_000_000 * KII  # the ceiling is 0.25% of this: 2500 KII a day
        account = fund_wallet(game, keys, private, funded)
        print("payer wallet funded on the test network", flush=True)

        players = [chain.account_from_public(chain.public_key(secrets.token_bytes(32))) for _ in range(3)]
        app_db, payer_db, status = f"{folder}/app.db", f"{folder}/payer.db", f"{folder}/status.json"
        add_cash_out(app_db, 1, players[0], 300 * KII)
        add_cash_out(app_db, 2, players[1], 2500 * KII)

        # 1. The real command-line path: seed file, live mode, real proof of work, real node
        seed_file = f"{folder}/seed"
        with open(seed_file, "w") as handle:
            handle.write(seed.hex())
        os.chmod(seed_file, 0o600)
        env = dict(os.environ, APP_DB=app_db, PAYER_DB=payer_db, PAYER_STATUS=status, PAYER_MODE="live", PAYER_ACCOUNT=account,
                   PAYER_ALLOW_OTHER_ACCOUNT="yes", PAYER_SEED_FILE=seed_file, PAYER_NODE=game.url, PAYER_GENESIS=genesis)
        done = subprocess.run([sys.executable, str(HERE / "payer.py"), "once"], env=env, capture_output=True, text=True)
        print(done.stdout.strip(), done.stderr.strip())
        check("payer command runs in live mode", done.returncode == 0 and "live mode" in done.stdout)
        receivable = lambda who: int(game.call("account_balance", account=who)["receivable"])
        check("player 1 is paid in full on a real node", receivable(players[0]) == 300 * KII)
        check("player 2 is held to 1000 KII for the day", receivable(players[1]) == 1000 * KII)
        check("wallet balance fell by exactly what was paid", int(game.call("account_info", account=account)["balance"]) == funded - 1300 * KII)
        payer = pay.Payer(app_db, payer_db, status, poll_seconds=0.25, genesis=genesis)
        hashes = [r["block_hash"] for r in payer.db.execute("SELECT block_hash FROM payments")]
        check("both payments are confirmed in the payer's records", payer.db.execute("SELECT COUNT(*) AS n FROM payments WHERE status='confirmed'").fetchone()["n"] == 2)
        for block_hash in hashes:
            wait_confirmed_everywhere(block_hash)
        check("every payment is confirmed on all 4 nodes", True)

        # 2. Run it again: nothing more should move
        done = subprocess.run([sys.executable, str(HERE / "payer.py"), "once"], env=env, capture_output=True, text=True)
        check("a second pass pays nothing", "payments made: 0" in done.stdout and receivable(players[1]) == 1000 * KII)

        # 3. Crash before publishing: the same saved block goes out, once
        add_cash_out(app_db, 3, players[2], 50 * KII)
        wallet = pay.LiveWallet(payer, game, private)
        payer.use_wallet(wallet)
        original = pay.LiveWallet._publish
        def crash(*_):
            raise KeyboardInterrupt
        pay.LiveWallet._publish = crash
        try:
            payer.cycle()
        except KeyboardInterrupt:
            pass
        finally:
            pay.LiveWallet._publish = original
        saved = payer.db.execute("SELECT block_hash FROM payments WHERE status='signed'").fetchone()["block_hash"]
        check("crash left a saved block and sent nothing", receivable(players[2]) == 0)
        payer.cycle()
        check("restart sends the saved block", game.call("account_info", account=account)["frontier"].upper() == saved and receivable(players[2]) == 50 * KII)

        # 4. Crash right after publishing: nothing is paid twice
        add_cash_out(app_db, 3, players[2], 25 * KII, stage=100)
        def publish_then_crash(self, block, block_hash):
            original(self, block, block_hash)
            raise KeyboardInterrupt
        pay.LiveWallet._publish = publish_then_crash
        try:
            payer.cycle()
        except KeyboardInterrupt:
            pass
        finally:
            pay.LiveWallet._publish = original
        payer.cycle()
        check("a crash after publishing pays once", receivable(players[2]) == 75 * KII and not payer.setting("paused"))
        wait_confirmed_everywhere(game.call("account_info", account=account)["frontier"])

        # Receipts: the real signer against the real chain, as its own command
        public = f"{folder}/receipts.json"
        receipt_env = dict(os.environ, APP_DB=app_db, RECEIPT_DB=f"{folder}/receipts.db", RECEIPT_KEY_FILE=f"{folder}/receipt-key",
                           RECEIPTS_PUBLIC=public, RECEIPT_NODE=game.url, RECEIPT_ACCOUNT=account, RECEIPT_GENESIS=genesis)
        run_receipts = lambda: subprocess.run([sys.executable, str(HERE / "receipts.py"), "once"], env=receipt_env, capture_output=True, text=True)
        done = run_receipts()
        print(done.stdout.strip(), done.stderr.strip())
        published = json.load(open(public))
        sends = payer.db.execute("SELECT COUNT(*) AS n FROM payments WHERE status='confirmed'").fetchone()["n"]
        check("every real payout has a signed receipt", done.returncode == 0 and published["receiptCount"] == sends and sends >= 4)
        check("all receipt signatures check out", receipts.check_published(published) == (sends, 0))
        check("no payout is flagged as unmatched", published["unmatched"] == [])
        check("receipts are indexed by the real block hashes", {r["receipt"]["block"] for r in published["receipts"]} == {r["block_hash"] for r in payer.db.execute("SELECT block_hash FROM payments WHERE status='confirmed'")})

        # 5. Someone else spends from the wallet: payouts stop
        info = game.call("account_info", account=account, representative="true")
        theft = game.call("block_create", json_block="true", type="state", key=private.hex().upper(), account=account, previous=info["frontier"],
                          representative=info["representative"], balance=str(int(info["balance"]) - KII), link=players[2])["block"]
        wait_confirmed_everywhere(game.call("process", json_block="true", subtype="send", block=theft)["hash"])
        done = run_receipts()
        published = json.load(open(public))
        check("an outside spend gets no receipt and is flagged", published["receiptCount"] == sends and len(published["unmatched"]) == 1)
        add_cash_out(app_db, 3, players[2], 10 * KII, stage=150)
        before = receivable(players[2])
        payer.cycle()
        check("an outside spend pauses payouts", "something else moved" in (payer.setting("paused") or "") and receivable(players[2]) == before)
    finally:
        stop_nodes()
        subprocess.run(["rm", "-rf", folder], check=False)
    if FAILED:
        raise SystemExit(f"{len(FAILED)} checks failed: {FAILED}")
    print("REHEARSAL PASSED: real blocks, real node, real proof of work, throwaway keys only")


if __name__ == "__main__":
    main()
