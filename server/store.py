"""The web service's database. The payer opens it read-only and keeps its own records in payer.py."""
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    ign TEXT NOT NULL,
    ign_key TEXT NOT NULL UNIQUE,
    wallet TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL,
    best_stage INTEGER NOT NULL DEFAULT 0,
    encounters_dog INTEGER NOT NULL DEFAULT 0,
    encounters_son INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id),
    seed INTEGER NOT NULL,
    encounters_dog INTEGER NOT NULL,
    encounters_son INTEGER NOT NULL,
    issued_at REAL NOT NULL,
    closed_at REAL,
    verified_ticks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_player ON runs(player_id, issued_at);
CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    received_at REAL NOT NULL,
    elapsed_seconds REAL NOT NULL,
    log_gz BLOB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT
);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, id);
CREATE TABLE IF NOT EXISTS cash_outs (
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    stage INTEGER NOT NULL,
    amount_raw TEXT NOT NULL,
    verified_at REAL NOT NULL,
    UNIQUE (run_id, stage)
);
"""


def connect(path, read_only=False):
    uri = f"file:{path}?mode=ro" if read_only else f"file:{path}?mode=rwc"
    db = sqlite3.connect(uri, uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    if not read_only:
        db.executescript(SCHEMA)
    return db
