// Registro em memoria (some quando o servico reinicia) das ultimas
// notificacoes de MENSAGEM processadas e o que deu certo/errado em cada uma.
// Serve pra conferir, pela rota /api/debug/webhook-message-log, se o webhook
// de mensagem esta mesmo achando o pack — o console.log do Render nao e
// acessivel pra quem usa o painel.
const MAX = 40;
const entries = [];

function record(entry) {
  entries.unshift({ at: new Date().toISOString(), ...entry });
  if (entries.length > MAX) entries.length = MAX;
}

function getAll() {
  return entries;
}

module.exports = { record, getAll };
