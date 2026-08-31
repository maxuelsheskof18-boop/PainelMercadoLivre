// Chamadas a API do Melhor Envio. So a calculadora de frete (cotacao) foi
// implementada — a compra/geracao de etiqueta fica por conta do proprio
// site do Melhor Envio, por escolha do usuario.
const { BASE_URL, USER_AGENT } = require("./oauth");

// Calcula o frete entre dois CEPs para um pacote. "product" recebe peso e
// dimensoes (a API tambem aceita uma lista de produtos individuais, mas
// pra essa tela um unico "pacote" resumido e suficiente).
//
// Doc: https://docs.melhorenvio.com.br/reference/calculo-de-fretes-por-produtos
async function calculateShipping(accessToken, { fromPostalCode, toPostalCode, weight, height, width, length, insuranceValue }) {
  const body = {
    from: { postal_code: onlyDigits(fromPostalCode) },
    to: { postal_code: onlyDigits(toPostalCode) },
    products: [
      {
        name: "Produto",
        quantity: 1,
        // O campo que a API do Melhor Envio realmente usa pra calcular o
        // custo do seguro e "insurance_value" (nao "value" — esse nome
        // estava errado antes e fazia a API ignorar silenciosamente o valor
        // informado, sempre calculando o frete como se o seguro fosse o
        // minimo, por isso o preco nao mudava ao editar o campo no painel).
        // Doc: https://docs.melhorenvio.com.br/reference/calculo-de-fretes-por-produtos
        insurance_value: insuranceValue || 20,
        weight: Number(weight) || 0.3,
        width: Number(width) || 11,
        height: Number(height) || 4,
        length: Number(length) || 16,
      },
    ],
  };

  const res = await fetch(`${BASE_URL}/api/v2/me/shipment/calculate`, {
    method: "POST",
    // Ver o mesmo comentario em backend/ml/api.js (REQUEST_TIMEOUT_MS) —
    // nenhuma chamada externa deve poder travar pra sempre.
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Melhor Envio ${res.status} em /shipment/calculate`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

module.exports = { calculateShipping };
