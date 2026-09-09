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

  CREATE TABLE IF NOT EXISTS reply_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pack ON messages(pack_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
`);

// --- Migracoes leves para bancos ja existentes ---------------------------------
// CREATE TABLE IF NOT EXISTS nao adiciona colunas novas a uma tabela que ja
// existe. Aqui conferimos as colunas atuais e aplicamos ALTER TABLE so quando
// faltam, de forma idempotente (seguro rodar a cada boot).
function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumnIfMissing(table, column, definition) {
  if (!columnNames(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// accounts: email do vendedor (evita chamar /users/me a cada resposta) e
// sinalizador de que o refresh_token falhou e a conta precisa ser reconectada.
addColumnIfMissing("accounts", "email", "TEXT");
addColumnIfMissing("accounts", "needs_reauth", "INTEGER NOT NULL DEFAULT 0");

// conversations: dados do pedido (item, valor, status de envio) mostrados
// junto da conversa.
addColumnIfMissing("conversations", "item_title", "TEXT");
addColumnIfMissing("conversations", "item_quantity", "INTEGER");
addColumnIfMissing("conversations", "order_total", "REAL");
addColumnIfMissing("conversations", "currency", "TEXT");
addColumnIfMissing("conversations", "order_status", "TEXT");
addColumnIfMissing("conversations", "shipping_status", "TEXT");
addColumnIfMissing("conversations", "order_enriched_at", "TEXT");

// Dedup real de mensagens: uma conversa nao deveria ter duas linhas com o
// mesmo message_id. (message_id NULL continua permitido para o registro
// otimista da resposta enviada pelo painel, ate a proxima sincronizacao.)
// Primeiro limpa duplicatas que a versao antiga possa ter gravado, senao a
// criacao do indice unico falha.
db.exec(
  `DELETE FROM messages WHERE message_id IS NOT NULL AND id NOT IN (
     SELECT MIN(id) FROM messages WHERE message_id IS NOT NULL GROUP BY pack_id, message_id
   )`
);
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_pack_msgid
   ON messages(pack_id, message_id) WHERE message_id IS NOT NULL`
);

module.exports = db;
