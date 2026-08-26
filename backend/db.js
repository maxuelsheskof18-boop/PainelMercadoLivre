// Banco de dados: Postgres (ex: Neon, gratuito) em vez de um arquivo local.
// Isso e necessario porque o plano gratuito do Render apaga o disco local
// toda vez que o servico reinicia/dorme — um banco de dados externo mantem
// as contas conectadas e o historico de conversas entre um "sono" e outro.
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn(
    "[aviso] DATABASE_URL nao esta definida — configure a connection string do seu banco Postgres (ex: Neon) no .env."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (e a maioria dos provedores gratuitos de Postgres) exige SSL, mas
  // usa um certificado que o Node as vezes nao reconhece na cadeia padrao;
  // isso aqui aceita a conexao segura sem travar por causa disso.
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,              -- user_id do vendedor no Mercado Livre
      nickname TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at BIGINT NOT NULL,       -- epoch ms
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      pack_id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL REFERENCES accounts(id),
      order_id TEXT,
      buyer_id TEXT,
      buyer_nickname TEXT,
      buyer_full_name TEXT,                     -- nome real (order.buyer), quando disponivel
      product_title TEXT,                       -- nome do(s) produto(s) do pedido
      order_total NUMERIC(12,2),                -- valor total da venda (order.total_amount)
      last_message_text TEXT,
      last_message_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'answered' | 'blocked' | 'no_contact'
      is_combinar_entrega BOOLEAN,              -- null = ainda nao classificado
      blocked_reason TEXT,                      -- ex: 'blocked_by_refund', 'blocked_by_mediation'
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      pack_id TEXT NOT NULL,
      message_id TEXT,
      direction TEXT NOT NULL,   -- 'in' (comprador) | 'out' (vendedor)
      author_user_id TEXT,
      text TEXT,
      sent_date TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pack ON messages(pack_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

    -- So existe UMA conta do Melhor Envio pro painel inteiro (diferente das
    -- contas do Mercado Livre, que podem ser varias) — por isso id fixo
    -- 'main' em vez de guardar o id de uma conta de verdade. access_token e
    -- refresh_token ficam nulos ate o usuario conectar; origin_postal_code
    -- (o CEP de onde as encomendas saem) pode ser preenchido mesmo antes de
    -- conectar, e fica guardado independente da conexao OAuth.
    CREATE TABLE IF NOT EXISTS melhorenvio_account (
      id TEXT PRIMARY KEY DEFAULT 'main',
      access_token TEXT,
      refresh_token TEXT,
      expires_at BIGINT,
      origin_postal_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // A tabela "conversations" ja existia (de uma versao anterior) na maioria
  // dos bancos ja em uso, entao o CREATE TABLE IF NOT EXISTS acima nao
  // adiciona a coluna nova sozinho — precisa de um ALTER explicito. E
  // seguro rodar isso toda vez que o servidor sobe (nao faz nada se a
  // coluna ja existir).
  await pool.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_combinar_entrega BOOLEAN;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS buyer_full_name TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS product_title TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS order_total NUMERIC(12,2);
  `);
}

module.exports = { query, init, pool };
