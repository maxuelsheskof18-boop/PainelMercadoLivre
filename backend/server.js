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
const claimsRoutes = require("./routes/claims");
const questionsRoutes = require("./routes/questions");
const melhorenvioRoutes = require("./routes/melhorenvio");
const { reconcileAllAccounts } = require("./sync");
const { reconcileAllClaims } = require("./claimsSync");
const { reconcileAllQuestions } = require("./questionsSync");

for (const key of ["DATABASE_URL", "ML_CLIENT_ID", "ML_CLIENT_SECRET", "ML_REDIRECT_URI", "DASHBOARD_PASSWORD", "SESSION_SECRET"]) {
  if (!process.env[key]) {
    console.warn(`[aviso] variavel de ambiente ${key} nao esta definida (veja o .env).`);
  }
}

// Rede de seguranca: a maioria das rotas deste painel e "async (req, res) =>
// {...}" sem try/catch (ver routes/*.js) — se uma consulta ao banco falhar
// (ex: tabela ainda nao existe por causa de um deploy incompleto/fora de
// ordem, ou uma queda momentanea de conexao), isso vira uma "unhandled
// promise rejection", e por padrao o Node (desde a v15) ENCERRA O PROCESSO
// INTEIRO nesse caso — derrubando o painel inteiro (Mensagens, Reclamações,
// tudo) por causa de UMA chamada com problema, no meio de um monte de
// outras chamadas que continuariam funcionando normalmente. Isso foi
// descoberto na pratica: a contagem de pendentes (chamada a cada 20s por
// qualquer aba aberta do painel) chegou a derrubar o servidor inteiro
// quando uma tabela nova (perguntas) ainda nao existia. Esses dois
// handlers so registram o erro no log e deixam o processo vivo — sem eles,
// TODO MUNDO usando o painel (nao so quem estava na tela com problema) cai
// e precisa esperar o Render reiniciar o servico. Com eles, o pior que
// acontece e aquela chamada especifica ficar "pendurada" sem resposta (o
// navegador eventualmente desiste sozinho) — chato, mas nao derruba o
// resto. Ainda assim, o ideal continua sendo cada rota nova ter seu proprio
// try/catch (ver routes/questions.js) pra devolver um erro de verdade em
// vez de deixar a chamada pendurada — isso aqui e so a ultima rede de
// seguranca, nao substitui tratar o erro direito na rota.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection] uma chamada assíncrona falhou sem tratamento — o processo NÃO foi encerrado:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] erro síncrono não tratado — o processo NÃO foi encerrado:", err);
});

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

// Reclamacoes (Central de Resolucoes/mediacao) — sistema separado das
// mensagens pos-venda acima, tambem sob /api/...
app.use("/api", claimsRoutes);

// Perguntas no anuncio (duvidas antes da compra) — sistema separado dos
// dois de cima, tambem sob /api/...
app.use("/api", questionsRoutes);

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
      reconcileAllClaims().catch((err) =>
        console.error("[reconcile-loop] erro (reclamacoes):", err.message)
      );
      reconcileAllQuestions().catch((err) =>
        console.error("[reconcile-loop] erro (perguntas):", err.message)
      );
    }, RECONCILE_INTERVAL_MS);
  })
  .catch((err) => {
    console.error("[startup] falha ao conectar/preparar o banco de dados:", err.message);
    console.error("Confira se DATABASE_URL esta correta no .env.");
    process.exit(1);
  });
