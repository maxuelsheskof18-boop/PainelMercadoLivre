const path = require("path");
// Carrega o .env sempre a partir da raiz do projeto (uma pasta acima de
// backend/), nao da pasta de onde o comando foi executado. Sem isso, rodar
// "node backend/server.js" de dentro de uma IDE (que as vezes muda a pasta
// atual para a do arquivo) faz o dotenv procurar o .env no lugar errado e
// as variaveis somem, mesmo com o arquivo preenchido certinho.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const cookieSession = require("cookie-session");

const db = require("./db");
const { requireLogin } = require("./authMiddleware");
const sessionRoutes = require("./routes/session");
const accountsRoutes = require("./routes/accounts");
const webhooksRoutes = require("./routes/webhooks");
const conversationsRoutes = require("./routes/conversations");
const melhorenvioRoutes = require("./routes/melhorenvio");
const { reconcileAllAccounts } = require("./sync");

for (const key of ["DATABASE_URL", "ML_CLIENT_ID", "ML_CLIENT_SECRET", "ML_REDIRECT_URI", "DASHBOARD_PASSWORD", "SESSION_SECRET"]) {
  if (!process.env[key]) {
    console.warn(`[aviso] variavel de ambiente ${key} nao esta definida (veja o .env).`);
  }
}

const app = express();
app.set("trust proxy", 1);

app.use(
  cookieSession({
    name: "ml_painel_session",
    keys: [process.env.SESSION_SECRET || "troque-este-segredo"],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dias
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  })
);

// Webhook do Mercado Livre: sem login, e o proprio Mercado Livre quem chama.
app.use(webhooksRoutes);

// Login/logout do painel
app.use(sessionRoutes);

// Conexao de contas ML (OAuth) + listagem
app.use(accountsRoutes);

// Conexao com o Melhor Envio (OAuth) + calculadora de frete
app.use(melhorenvioRoutes);

// Dados de conversas/pendencias (tudo aqui vive sob /api/...)
app.use("/api", conversationsRoutes);

// Pagina principal exige login. IMPORTANTE: isso precisa vir ANTES do
// express.static abaixo — senao, como "index.html" e um arquivo real
// dentro de public/, o proprio express.static serviria ele direto pra
// qualquer um em GET /index.html, sem nunca passar pelo requireLogin
// (a opcao "index:false" so evita isso para GET "/", nao para o nome do
// arquivo pedido explicitamente).
app.get(["/", "/index.html"], requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Arquivos publicos (tela de login e assets) sem exigir login
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Painel rodando em http://localhost:${PORT}`);
    });

    // Reconciliacao periodica: cobre qualquer webhook que eventualmente se
    // perca. Enquanto o servico estiver "dormindo" (plano gratuito do
    // Render), este temporizador tambem fica parado — por isso o botao
    // "Atualizar" existe, para forcar uma sincronizacao assim que o painel
    // acordar.
    const RECONCILE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos
    setInterval(() => {
      reconcileAllAccounts().catch((err) =>
        console.error("[reconcile-loop] erro:", err.message)
      );
    }, RECONCILE_INTERVAL_MS);
  })
  .catch((err) => {
    console.error("[startup] falha ao conectar/preparar o banco de dados:", err.message);
    console.error("Confira se DATABASE_URL esta correta no .env.");
    process.exit(1);
  });
