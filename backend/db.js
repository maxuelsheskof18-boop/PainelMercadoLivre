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
      status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'answered' | 'blocked' | 'no_contact' | 'cancelled' | 'resolved' | 'delivered_watch'
      is_combinar_entrega BOOLEAN,              -- null = ainda nao classificado
      is_delivered BOOLEAN,                     -- true = pedido ja entregue (tag "delivered"); usado pra separar
                                                 -- mensagens de pos-entrega (nota fiscal, duvidas) numa aba propria,
                                                 -- fora de Pendentes/Respondidas. Independente de status.
      shipping_type TEXT,                       -- rotulo legivel do tipo de envio (ex: "Flex", "Agência", "Coleta",
                                                 -- "Correios", "Full") pra pedidos com envio de verdade pelo Mercado
                                                 -- Envios. Fica NULL pra combinar entrega (nao tem envio) e enquanto
                                                 -- ainda nao foi buscado (so buscamos quando ja vamos buscar os
                                                 -- detalhes completos do pedido, pra nao gastar chamada de API a toa).
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
      operator_name TEXT,        -- nome de quem respondeu pelo painel (so em mensagens
                                  -- direction='out' enviadas por aqui); null nas recebidas
                                  -- do comprador e em envios antigos, de antes dessa coluna.
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pack ON messages(pack_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

    -- Registro TEMPORARIO de diagnostico: toda notificacao (webhook) que o
    -- Mercado Livre manda pra essa aplicacao, de QUALQUER topico — nao so
    -- "messages". Serve pra responder uma pergunta que nao da pra saber so
    -- olhando o codigo: o Mercado Livre esta mesmo mandando notificacao pra
    -- essa conta especifica, ou o problema e antes disso (webhook nao
    -- configurado/nao chegando)? Sem isso, um pack sem notificacao nenhuma
    -- e indistinguivel de uma falha no processamento daqui. Pode ser
    -- removida (junto com a rota /api/debug/webhook-events) quando esse
    -- tipo de investigacao nao for mais necessario.
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      topic TEXT,
      seller_id TEXT,
      resource TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_seller ON webhook_events(seller_id);

    -- Progresso da varredura automatica "mes a mes" (ver runBackfillStep em
    -- sync.js): pra contas de altissimo volume, nenhuma busca "pedidos
    -- recentes" cobre o historico inteiro — entao, alem das buscas em tempo
    -- real, o painel tambem varre sozinho, aos poucos (um pedacinho a cada
    -- sincronizacao), TODO o historico de pedidos entregues e de combinar
    -- entrega, mes a mes, ate cobrir tudo. Essa tabela so guarda em qual
    -- mes/fase/pagina cada conta parou, pra continuar de onde parou na
    -- proxima vez em vez de recomecar do zero.
    CREATE TABLE IF NOT EXISTS backfill_progress (
      seller_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      cursor_month DATE NOT NULL,
      cursor_phase TEXT NOT NULL DEFAULT 'delivered', -- 'delivered' | 'no_shipping'
      cursor_offset INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Reclamacoes abertas pelo comprador (Central de Resolucoes/mediacao do
    -- Mercado Livre) — sistema SEPARADO das mensagens pos-venda de cima
    -- (tabela conversations). Guardamos os dados principais devolvidos pela
    -- API de reclamacoes (post-purchase/v1/claims) pra listar no painel sem
    -- precisar buscar tudo de novo toda hora.
    CREATE TABLE IF NOT EXISTS claims (
      claim_id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      order_id TEXT,
      resource TEXT,                            -- 'order' | 'payment' | 'shipment' | 'purchase'
      resource_id TEXT,
      type TEXT,                                -- 'mediations' | 'cancel_purchase' | 'return' | 'cancel_sale'
      stage TEXT,                               -- 'claim' | 'dispute' | 'recontact' | 'none'
      ml_status TEXT,                           -- 'opened' | 'closed' (status da propria reclamacao no ML)
      reason_id TEXT,
      buyer_id TEXT,
      buyer_nickname TEXT,
      buyer_full_name TEXT,
      product_title TEXT,
      order_total NUMERIC(12,2),
      last_message_text TEXT,
      last_message_date TEXT,
      local_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'answered' | 'closed' — calculado por
                                                     -- este painel (ver claimsSync.js), separado do
                                                     -- ml_status: usado pra decidir a aba/badge.
      due_date TIMESTAMPTZ,                     -- prazo da proxima acao obrigatoria, quando houver
      mandatory_action BOOLEAN,                 -- true = ha uma acao com prazo que o vendedor precisa tomar
      shipping_type TEXT,                       -- mesmo rotulo usado nas conversas (Flex/Agência/Coleta/
                                                 -- Correios/Full) — buscado junto com os dados do pedido,
                                                 -- so quando resource='order'.
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_claims_local_status ON claims(local_status);

    CREATE TABLE IF NOT EXISTS claim_messages (
      id SERIAL PRIMARY KEY,
      claim_id TEXT NOT NULL,
      sender_role TEXT,                         -- 'complainant' | 'respondent' | 'mediator'
      receiver_role TEXT,
      message TEXT,
      attachments JSONB,
      sent_date TEXT,
      operator_name TEXT,                       -- nome de quem respondeu pelo painel (so em
                                                 -- mensagens sender_role='respondent' enviadas
                                                 -- por aqui); null nas demais.
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_claim_messages_claim ON claim_messages(claim_id);

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
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_delivered BOOLEAN;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS shipping_type TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS operator_name TEXT;
    ALTER TABLE claim_messages ADD COLUMN IF NOT EXISTS operator_name TEXT;
    ALTER TABLE claims ADD COLUMN IF NOT EXISTS shipping_type TEXT;
  `);
}

module.exports = { query, init, pool };
