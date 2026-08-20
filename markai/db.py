import sqlite3

import click
from flask import current_app, g
from werkzeug.security import generate_password_hash

# Seeded into a brand-new database so a fresh install is usable immediately —
# this is a local single-user tool, and making someone invent an account before
# they can open a PDF is pure friction. The login page advertises these two while
# they still work, and stops the moment the password is changed (see
# auth.default_login_hint).
DEFAULT_EMAIL = "admin@markai.local"
DEFAULT_PASSWORD = "markai"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    doc_type TEXT NOT NULL CHECK (doc_type IN ('md', 'pdf', 'docx')),
    stored_filename TEXT NOT NULL,
    source_folder TEXT,
    last_status_sync_mtime REAL,
    last_opened_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
    position_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('api', 'local')),
    base_url TEXT,
    api_key TEXT,
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_document ON notes(document_id);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user ON ai_providers(user_id);
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(
            current_app.config["DATABASE"],
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()
    db.executescript(SCHEMA)
    db.commit()
    seed_default_user(db)


def seed_default_user(db):
    """Create the default account, but only in a database that has no users at
    all: an existing install must never sprout a second, publicly-documented
    login behind its owner's back."""
    existing = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    if existing:
        return
    db.execute(
        "INSERT INTO users (email, password_hash) VALUES (?, ?)",
        (DEFAULT_EMAIL, generate_password_hash(DEFAULT_PASSWORD)),
    )
    db.commit()


@click.command("init-db")
def init_db_command():
    """Create database tables if they don't exist."""
    init_db()
    click.echo("Database initialized.")


def init_app(app):
    app.teardown_appcontext(close_db)
    app.cli.add_command(init_db_command)
    with app.app_context():
        init_db()
