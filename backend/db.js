const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dbPath = process.env.SQLITE_PATH || "./data/painel.db";
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,           -- user_id do vendedor no Mercado Livre
    nickname TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,      -- epoch ms
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    pack_id TEXT PRIMARY KEY,
    seller_id INTEGER NOT NULL,
    order_id TEXT,
    buyer_id INTEGER,
    buyer_nickname TEXT,
    last_message_text TEXT,
    last_message_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'answered'
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (seller_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id TEXT NOT NULL,
    message_id TEXT,
    direction TEXT NOT NULL,   -- 'in' (comprador) | 'out' (vendedor)
    author_user_id INTEGER,
    text TEXT,
    sent_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pack ON messages(pack_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
`);

module.exports = db;
