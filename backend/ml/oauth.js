// Fluxo OAuth2 do Mercado Livre.
// Doc oficial: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
const crypto = require("crypto");

const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";

// Ver o mesmo comentario em ml/api.js (REQUEST_TIMEOUT_MS): nenhuma chamada
// externa deve poder travar pra sempre. Essa aqui e ainda mais critica —
// se renovar o token travasse sem limite, getValidAccessToken() nunca
// devolveria, e QUALQUER reconciliacao (mensagens/reclamacoes/perguntas)
// que dependesse dela travaria junto.
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Gera o par (verifier, challenge) usado pelo PKCE.
// Se o app nao tiver PKCE habilitado no Mercado Livre, esses campos extras
// sao simplesmente ignorados pelo servidor deles — entao e seguro sempre enviar.
function generatePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

function buildAuthorizeUrl({ state, codeChallenge }) {
  const authDomain = process.env.ML_AUTH_DOMAIN || "https://auth.mercadolivre.com.br";
  const url = new URL(`${authDomain}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.ML_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.ML_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function exchangeCodeForToken({ code, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    code,
    redirect_uri: process.env.ML_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Falha ao trocar code por token: ${res.status} ${JSON.stringify(data)}`
    );
  }
  return data; // { access_token, token_type, expires_in, scope, user_id, refresh_token }
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Falha ao renovar token: ${res.status} ${JSON.stringify(data)}`
    );
  }
  return data; // novo access_token + novo refresh_token (uso unico)
}

module.exports = {
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
};
