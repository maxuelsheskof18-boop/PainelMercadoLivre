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
- Roda de graça: [Render](https://render.com) para hospedar o site e
  [Neon](https://neon.tech) para o banco de dados (ambos têm plano gratuito
  sem cartão de crédito).

## ⚠️ Duas coisas que a Mercado Livre exige (e que travam gente iniciante)

1. **HTTPS obrigatório.** As duas URLs que você vai cadastrar no aplicativo
   do Mercado Livre precisam começar com `https://`. Não dá para usar
   `http://localhost` — por isso este guia já manda direto para o deploy,
   sem passar por teste local.
2. **São duas URLs diferentes, não uma só:**
   - **URI de redirecionamento** (campo "Redirect URI" / "URIs de
     redirecionamento") → usada só no momento de login: `.../oauth/callback`
   - **URL de retorno de chamada de notificação** → usada para avisar de
     mensagem nova: `.../webhooks/mercadolivre`

   É comum colocar a mesma URL nos dois campos por engano — são coisas
   diferentes.

## O que você precisa ter

- Uma conta no Mercado Livre para cada loja que quiser conectar (você já tem).
- Uma conta gratuita no [Render](https://render.com) (pode entrar com GitHub
  ou e-mail).
- Uma conta gratuita no [Neon](https://neon.tech) (banco de dados).
- Um repositório no GitHub com este projeto (o Render publica a partir de um
  repositório Git). Se você nunca usou Git/GitHub, me chama que eu te ajudo
  com esse passo especificamente.

---

## Passo 1 — Criar o banco de dados gratuito (Neon)

1. Crie uma conta em https://neon.tech e um novo projeto (pode aceitar as
   opções padrão).
2. Na tela do projeto, procure **"Connection string"** (às vezes dentro de
   "Connect" ou "Dashboard") e copie o valor completo — algo como:
   ```
   postgresql://usuario:senha@ep-xxxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
3. Guarde essa string, você vai colar em `DATABASE_URL` no passo 4.

> O Neon "dorme" sozinho quando ninguém usa, mas acorda em milissegundos na
> próxima consulta — não precisa fazer nada manual, diferente de outros
> bancos gratuitos que ficam pausados até você entrar no site deles.

## Passo 2 — Criar o aplicativo no Mercado Livre

1. Acesse https://developers.mercadolivre.com.br/ e faça login com sua
   conta do Mercado Livre.
2. Vá em "Minhas aplicações" → "Criar aplicativo".
3. Preencha nome, descrição etc.
4. Nos campos de URL (você vai voltar aqui depois de ter a URL do Render —
   pode deixar um valor provisório por enquanto, tipo
   `https://exemplo.onrender.com/oauth/callback`, contanto que comece com
   `https://`, ou o Mercado Livre não deixa salvar).
5. Marque os escopos/fluxos: **"Código de autorização"** e **"Token de
   atualização"** (esse último é o que permite renovar o acesso sem você
   precisar autorizar de novo a cada 6 horas). Marque também o modelo de
   negócio como **vendedor** (não comprador), já que o painel responde
   mensagens como vendedor.
6. Salve e anote o **Client ID (App ID)** e o **Client Secret (Secret Key)**.

## Passo 3 — Subir o projeto para o GitHub

Se você já sabe usar Git, só criar um repositório e mandar este projeto para
lá (o `.gitignore` já exclui `node_modules` e `.env`). Se não sabe, me avisa
que eu monto esse repositório junto com você.

## Passo 4 — Publicar no Render

1. Crie uma conta em https://render.com.
2. Clique em **New +** → **Web Service** e escolha o repositório do GitHub
   que você criou no passo 3.
3. Configure:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free
4. Em **Environment**, adicione as variáveis (você pode copiar os nomes do
   `.env.example`):
   - `DATABASE_URL` → a connection string do Neon (passo 1)
   - `ML_CLIENT_ID` e `ML_CLIENT_SECRET` → do passo 2
   - `DASHBOARD_PASSWORD` → uma senha sua para abrir o painel
   - `SESSION_SECRET` → um texto aleatório longo (gere com
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
     no seu computador, se tiver Node instalado, ou peça pra mim gerar um)
   - `ML_AUTH_DOMAIN` → `https://auth.mercadolivre.com.br`
5. Clique em **Create Web Service** e espere o primeiro deploy terminar.
6. Você vai receber uma URL do tipo `https://seu-painel.onrender.com`.
   Volte em **Environment** e complete:
   - `PUBLIC_BASE_URL` → `https://seu-painel.onrender.com`
   - `ML_REDIRECT_URI` → `https://seu-painel.onrender.com/oauth/callback`

   Salvar essas variáveis faz o Render reiniciar o serviço sozinho.

## Passo 5 — Atualizar a configuração no Mercado Livre

Volte em https://developers.mercadolivre.com.br/ no seu aplicativo e
atualize (lembrando: são campos diferentes!):

- **URI de redirecionamento** → `https://seu-painel.onrender.com/oauth/callback`
- **URL de retorno de chamada de notificação** → `https://seu-painel.onrender.com/webhooks/mercadolivre`

Salve.

## Passo 6 — Usar

1. Acesse `https://seu-painel.onrender.com`, entre com a `DASHBOARD_PASSWORD`.
   (No plano gratuito, se ninguém acessou nos últimos 15 minutos, essa
   primeira abertura do dia pode demorar uns 30-60 segundos — é o Render
   "acordando" o serviço. Depois disso fica rápido.)
2. Clique em **"+ Conectar conta"** para cada loja/conta do Mercado Livre
   que você administra (a tela de login do Mercado Livre vai aparecer —
   entre com a conta daquela loja e autorize). Repita para a segunda loja.
3. As conversas pendentes aparecem na aba **Pendentes**, com o sininho
   mostrando o total. Clique em uma para ver a conversa e responder.
4. Ao enviar a resposta pelo painel, ela é enviada de verdade para o
   comprador no Mercado Livre, e a conversa passa para a aba **Respondidas**.
5. O botão **Atualizar** força uma sincronização na hora — útil logo depois
   de o painel "acordar", ou se quiser conferir sem esperar o aviso
   automático.

---

## Avisos importantes

- **O painel "dorme" no plano gratuito do Render**: depois de 15 minutos
  sem ninguém acessar, o Render desliga o serviço. Ele acorda sozinho
  quando alguém abre o link de novo (leva menos de um minuto), mas
  enquanto está dormindo ele não fica de olho em mensagens novas — é por
  isso que existe o botão **Atualizar** e a checagem automática a cada 10
  minutos, que roda assim que o painel está acordado. Combina bem com um
  uso de "abro algumas vezes por dia para ver e responder"; se você
  precisar de aviso instantâneo o tempo todo, dá pra migrar depois para um
  plano pago que não dorme (posso te ajudar quando quiser).
- **Sem notificação fora do navegador**: o sininho atualiza sozinho
  enquanto a página está aberta (a cada ~20s). Ele não manda notificação
  para o celular fora do painel — dá para adicionar depois (ex: aviso por
  e-mail ou Telegram) se quiser.
- **Primeira sincronização real**: os nomes de alguns campos que a API do
  Mercado Livre devolve (ex: apelido do comprador) podem variar um pouco
  dependendo do tipo de venda. O código já foi escrito de forma defensiva
  para não quebrar nesses casos, mas se algo aparecer estranho na primeira
  vez que mensagens de verdade chegarem, me chame com uma mensagem de
  exemplo (sem dados sensíveis) que eu ajusto rapidinho.
- **Segurança**: não compartilhe a senha do painel nem o `Client Secret`.
  Qualquer pessoa com a senha do painel consegue ler e responder mensagens
  em nome das suas lojas conectadas.
- **Dados**: tudo fica guardado no banco Postgres gratuito do Neon (não no
  servidor do Render, que apaga os arquivos locais a cada reinício).

## Estrutura do projeto

```
backend/
  server.js          servidor Express, junta todas as rotas
  db.js              conecta no Postgres (Neon) e cria as tabelas
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
    conversations.js  listar pendências, ver conversa, responder (montado em /api)
public/
  login.html, index.html, app.js, style.css   painel web
```
