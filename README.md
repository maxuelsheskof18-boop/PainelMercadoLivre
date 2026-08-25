# Painel de Mensagens do Mercado Livre

Painel web para acompanhar as mensagens de pós-venda do Mercado Livre (o tipo
usado em "combinar entrega") como uma fila de pendências: enquanto o
comprador não recebe resposta, a conversa aparece na lista e no sininho de
notificação; assim que você responde (pelo próprio painel), ela sai da lista
de pendentes. Funciona com **mais de uma conta/loja do Mercado Livre** ao
mesmo tempo.

## O que este projeto faz

- Conecta uma ou mais contas de vendedor do Mercado Livre via OAuth oficial.
- Recebe avisos do Mercado Livre em tempo real (webhook) quando chega
  mensagem nova, e também confere periodicamente (a cada 10 min) para não
  perder nada caso algum aviso falhe.
- Mostra uma lista de conversas pendentes (e outra de já respondidas).
- Deixa você responder direto pelo painel — a resposta é enviada de volta
  para o Mercado Livre pela API deles.
- Tem um sininho com contador de pendências, atualizado automaticamente
  enquanto a página está aberta.
- É protegido por senha (defina a sua em `DASHBOARD_PASSWORD`).

## O que você precisa ter

- Uma conta no Mercado Livre para cada loja que quiser conectar (você já tem).
- Node.js 18 ou mais novo, só para rodar o projeto.
- Uma conta gratuita em algum serviço de hospedagem (recomendo
  [Render.com](https://render.com), tem plano gratuito e é simples).

---

## Passo 1 — Criar o aplicativo no Mercado Livre

1. Acesse https://developers.mercadolivre.com.br/ e faça login com sua
   conta do Mercado Livre.
2. Vá em "Minhas aplicações" (ou "Meus aplicativos") → "Criar aplicativo".
3. Preencha nome, descrição etc. (pode ser algo simples, é só para uso seu).
4. Em **Redirect URI**, por enquanto coloque `http://localhost:3000/oauth/callback`
   (depois do deploy, você troca pela URL pública real — passo 3).
5. Marque os escopos: `read` e `write` (para poder ler e responder mensagens).
6. Na seção de **Notificações/Tópicos**, marque o tópico de **mensagens**
   (o nome exato aparece na própria tela, algo como "messages"). A URL de
   callback de notificação você também vai atualizar depois do deploy.
7. Salve e anote o **Client ID (App ID)** e o **Client Secret (Secret Key)** —
   você vai usar os dois no arquivo `.env`.

> Isso é gratuito e é só seu — não é preciso pedir aprovação de ninguém, o
> próprio Mercado Livre libera o acesso na hora para a sua conta.

## Passo 2 — Rodar localmente para testar

```bash
npm install
cp .env.example .env
```

Abra o `.env` e preencha:

- `ML_CLIENT_ID` e `ML_CLIENT_SECRET`: os valores do passo 1.
- `DASHBOARD_PASSWORD`: uma senha que só você vai saber, para abrir o painel.
- `SESSION_SECRET`: gere uma com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Depois:

```bash
npm start
```

Abra `http://localhost:3000`, entre com a senha, e clique em **"+ Conectar
conta"** para autorizar a primeira loja. Repita para a segunda loja depois
(ele deixa conectar quantas contas você quiser).

Isso é só para conferir que está tudo certo antes de publicar — webhooks
não chegam em `localhost`, então a lista só vai atualizar mesmo quando você
clicar em **"Atualizar"**.

## Passo 3 — Publicar (deploy) no Render (gratuito)

1. Crie uma conta em https://render.com (dá para logar com GitHub).
2. Suba esta pasta para um repositório no GitHub (ou peça ajuda se preferir
   que eu monte esse repositório para você).
3. No Render, clique em **New +** → **Web Service**, aponte para o
   repositório.
4. Configure:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free
5. Em **Environment**, adicione as mesmas variáveis do seu `.env`
   (`ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`,
   `ML_AUTH_DOMAIN`, `SQLITE_PATH=./data/painel.db`).
6. Em **Disks**, adicione um disco persistente (ex: 1 GB) montado em `/data`
   e ajuste `SQLITE_PATH=/data/painel.db` — assim o banco de dados não some
   a cada deploy.
7. Depois que o deploy terminar, você terá uma URL do tipo
   `https://seu-painel.onrender.com`. Preencha:
   - `PUBLIC_BASE_URL=https://seu-painel.onrender.com`
   - `ML_REDIRECT_URI=https://seu-painel.onrender.com/oauth/callback`

## Passo 4 — Atualizar a configuração no Mercado Livre

Volte em https://developers.mercadolivre.com.br/ no seu aplicativo e
atualize:

- **Redirect URI** → `https://seu-painel.onrender.com/oauth/callback`
- **Notifications callback URL** → `https://seu-painel.onrender.com/webhooks/mercadolivre`

Salve. A partir daqui, os avisos de mensagem nova já chegam direto no
painel publicado.

## Passo 5 — Usar

1. Acesse a URL publicada, entre com a `DASHBOARD_PASSWORD`.
2. Clique em **"+ Conectar conta"** para cada loja/conta do Mercado Livre
   que você administra (a tela de login do Mercado Livre vai aparecer —
   entre com a conta daquela loja e autorize).
3. As conversas pendentes aparecem na aba **Pendentes**, com o sininho
   mostrando o total. Clique em uma para ver a conversa e responder.
4. Ao enviar a resposta pelo painel, ela é enviada de verdade para o
   comprador no Mercado Livre, e a conversa passa para a aba **Respondidas**.
5. O botão **Atualizar** força uma sincronização na hora, sem esperar o
   próximo aviso automático.

---

## Avisos importantes

- **Sem notificação fora do navegador**: o sininho atualiza sozinho
  enquanto a página está aberta (a cada ~20s). Ele não manda notificação
  para o celular fora do painel — isso não foi pedido no escopo atual, mas
  dá para adicionar depois (ex: aviso por e-mail ou Telegram) se quiser.
- **Primeira sincronização real**: os nomes de alguns campos que a API do
  Mercado Livre devolve (ex: apelido do comprador) podem variar um pouco
  dependendo do tipo de venda. O código já foi escrito de forma defensiva
  para não quebrar nesses casos, mas se algo aparecer estranho na primeira
  vez que mensagens de verdade chegarem, me chame com uma mensagem de
  exemplo (sem dados sensíveis) que eu ajusto rapidinho.
- **Segurança**: não compartilhe a senha do painel nem o `Client Secret`.
  Qualquer pessoa com a senha do painel consegue ler e responder mensagens
  em nome das suas lojas conectadas.
- **Dados**: tudo fica guardado num banco SQLite simples dentro do próprio
  servidor (pasta `data/`). Não há integração com planilhas ou outro banco
  — se quiser exportar relatórios depois, também dá para adicionar.

## Estrutura do projeto

```
backend/
  server.js          servidor Express, junta todas as rotas
  db.js              cria/abre o banco SQLite
  authMiddleware.js  protege as rotas com a senha do painel
  sync.js            transforma dados da API do ML em pendências/respostas
  ml/
    oauth.js         login OAuth com o Mercado Livre (PKCE)
    tokens.js        guarda e renova o token de acesso de cada conta
    api.js           chamadas à API de mensagens do Mercado Livre
  routes/
    session.js       login/logout do painel
    accounts.js       conectar contas ML (OAuth) e listar
    webhooks.js       recebe avisos do Mercado Livre
    conversations.js  listar pendências, ver conversa, responder
public/
  login.html, index.html, app.js, style.css   painel web
```
