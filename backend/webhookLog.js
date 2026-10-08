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

// Mesmo esquema, pros ENVIOS de resposta pelo painel (sucesso e falha): serve
// pra comparar o texto de um envio que o Mercado Livre recusou ("format is not
// allowed") com os que passaram, sem depender de log do Render.
const sends = [];

function recordSend(entry) {
  sends.unshift({ at: new Date().toISOString(), ...entry });
  if (sends.length > MAX) sends.length = MAX;
}

function getSends() {
  return sends;
}

module.exports = { record, getAll, recordSend, getSends };
