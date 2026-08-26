// Fluxo OAuth2 do Melhor Envio (usado so pra CALCULAR frete — nao inclui
// compra/geracao de etiqueta, que o usuario prefere fazer direto no site
// deles). Doc oficial: https://docs.melhorenvio.com.br/reference/fluxo-de-autorização
//
// Por padrao aponta pro ambiente de SANDBOX (teste, sem gastar nada de
// verdade) — troque MELHORENVIO_BASE_URL pra "https://melhorenvio.com.br"
// so quando tudo estiver testado e voce tiver criado o aplicativo tambem no
// ambiente de producao (sao contas/aplicativos SEPARADOS, um em cada
// ambiente).
const BASE_URL = process.env.MELHORENVIO_BASE_URL || "https://sandbox.melhorenvio.com.br";

// A API do Melhor Envio exige um User-Agent identificando a aplicacao e um
// e-mail de contato tecnico em toda chamada (nao so no OAuth).
const USER_AGENT =
  process.env.MELHORENVIO_USER_AGENT || "Painel de Mensagens (contatofiglimp@gmail.com)";

// So pedimos a permissao de calcular frete — nenhuma permissao de carrinho,
// compra ou geracao de etiqueta, ja que essa parte fica por conta do
// proprio site do Melhor Envio.
const SCOPES = "shipping-calculate";

function buildAuthorizeUrl({ state }) {
  const url = new URL(`${BASE_URL}/oauth/authorize`);
  url.searchParams.set("client_id", process.env.MELHORENVIO_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.MELHORENVIO_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPES);
  return url.toString();
}

async function tokenRequest(body) {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Melhor Envio ${res.status} em /oauth/token: ${JSON.stringify(data)}`);
  }
  return data; // { access_token, refresh_token, expires_in, token_type }
}

async function exchangeCodeForToken(code) {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: process.env.MELHORENVIO_CLIENT_ID,
    client_secret: process.env.MELHORENVIO_CLIENT_SECRET,
    redirect_uri: process.env.MELHORENVIO_REDIRECT_URI,
    code,
  });
}

async function refreshAccessToken(refreshToken) {
  return tokenRequest({
    grant_type: "refresh_token",
    client_id: process.env.MELHORENVIO_CLIENT_ID,
    client_secret: process.env.MELHORENVIO_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
}

module.exports = {
  BASE_URL,
  USER_AGENT,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
};
