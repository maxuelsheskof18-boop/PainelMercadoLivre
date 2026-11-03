// Busca de data Full — acompanhar e comandar pelo celular.
// Quem executa é a extensão no PC; aqui só lemos a "foto" que ela manda
// e gravamos comandos que ela busca no próximo minuto.

const $ = s => document.querySelector(s);
const ONLINE_MS = 3 * 60_000; // a extensão manda o estado a cada minuto
const TIPOS = { ftl: 'Veículo particular', supplier: 'Envio pelo fornecedor', ftlp: 'Transportadora privada', pickup: 'Coleta a domicílio' };
const NOMES_CMD = { agendar: 'Agendar data', aprovar_envio: 'Aprovar envio', recusar_envio: 'Recusar envio', config: 'Mudar chave', verificar: 'Verificar agora' };

let dados = { maquinas: [], comandos: [] };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hora(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function haQuanto(ts) {
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  return `há ${Math.round(s / 3600)} h`;
}

async function api(url, opcoes = {}) {
  const r = await fetch(url, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opcoes });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function comandar(maquina, tipo, dadosCmd, botao) {
  if (botao) botao.disabled = true;
  try {
    await api('/api/full-agenda/comandos', { method: 'POST', body: JSON.stringify({ maquina, tipo, dados: dadosCmd }) });
    await carregar();
  } catch (e) {
    if (e.message !== 'login') alert('Não enviei o comando: ' + e.message);
  } finally {
    if (botao) botao.disabled = false;
  }
}

// Comando ainda não executado pelo PC para esta chave (mostra "aguardando PC").
function pendente(maquina, filtro) {
  return dados.comandos.find(c => c.maquina === maquina && ['pendente', 'executando'].includes(c.status) && filtro(c));
}

// ---------- desenho ----------

function chave(maquina, rotulo, sub, ligado, dadosCfg, perigo) {
  const p = pendente(maquina, c => c.tipo === 'config' && c.dados.chave === dadosCfg.chave && (c.dados.conta || '') === (dadosCfg.conta || ''));
  const valor = p ? !!p.dados.valor : !!ligado;
  return `<div class="chave-linha">
    <div>${esc(rotulo)}<small>${esc(sub || '')}</small>${p ? '<span class="aguarda">aguardando o PC aplicar…</span>' : ''}</div>
    <label class="sw ${perigo ? 'perigo' : ''}"><input type="checkbox" ${valor ? 'checked' : ''} ${p ? 'disabled' : ''}
      data-cfg='${esc(JSON.stringify(dadosCfg))}' data-maq="${esc(maquina)}"><span></span></label>
  </div>`;
}

function seloEnvio(e) {
  if (e.agendado) return '<span class="selo ok">Agendado</span>';
  const u = e.ultimo;
  if (!u) return '<span class="selo">Aguardando busca</span>';
  if (u.erro) return '<span class="selo erro">Erro</span>';
  if (u.boas) return `<span class="selo achou">${u.boas} vaga(s)</span>`;
  if (u.total) return '<span class="selo nada">Fora do filtro</span>';
  return '<span class="selo nada">Sem datas</span>';
}

function desenharEnvio(m, e, logada) {
  const u = e.ultimo || {};
  let corpo = '';
  if (e.agendado) corpo = `<div class="env-info">✔ ${esc(e.agendado.texto || '')}</div>`;
  else if (u.erro) corpo = `<div class="env-info">${esc(u.erro)}</div>`;
  else if (u.boas && u.melhores) {
    corpo = u.melhores.slice(0, 4).map(v => {
      const p = pendente(m.id, c => c.tipo === 'agendar' && String(c.dados.envioId) === String(e.id));
      const botao = !logada
        ? '<span class="mudo">logue nesta conta no PC</span>'
        : p ? '<span class="aguarda mudo">enviado ao PC…</span>'
        : `<button class="btn verde peq" data-agendar='${esc(JSON.stringify({ envioId: e.id, conta: e.conta, vaga: v }))}' data-maq="${esc(m.id)}">Agendar</button>`;
      return `<div class="vaga"><span>${esc(v.texto)}${v.horaFim ? ' – ' + esc(v.horaFim) : ''}</span>${botao}</div>`;
    }).join('');
  } else if (u.total && u.primeira) corpo = `<div class="env-info">Primeira vaga fora do filtro: ${esc(u.primeira.texto)}</div>`;
  return `<div class="envio">
    <div class="env-cab"><b>#${esc(e.id)}</b>${seloEnvio(e)}</div>
    <div class="env-info">${esc([e.titulo, e.unidades ? e.unidades + ' un.' : '', TIPOS[e.tipo], u.quando ? 'verificado ' + hora(u.quando) : ''].filter(Boolean).join(' · '))}</div>
    ${corpo}
  </div>`;
}

function desenharProposta(m, conta, p) {
  const ja = pendente(m.id, c => ['aprovar_envio', 'recusar_envio'].includes(c.tipo) && String(c.dados.propostaId) === String(p.id));
  return `<div class="proposta">
    <h4>Envio pronto para criar — ${p.itens.length} produto(s), ${p.totalUn} un.</h4>
    <span class="mudo">montado ${hora(p.criada)}</span>
    <ul>${p.itens.slice(0, 30).map(i => `<li>${esc(i.nome || i.id)} — <b>${i.unidades} un.</b>${i.regra ? ` <span class="mudo">(${esc(i.regra)})</span>` : ''}</li>`).join('')}
      ${p.itens.length > 30 ? `<li class="mudo">+${p.itens.length - 30} produto(s)</li>` : ''}</ul>
    ${ja ? '<span class="aguarda mudo">Resposta enviada ao PC…</span>' : `<div class="linha-botoes">
      <button class="btn verde" data-proposta="aprovar_envio" data-id="${esc(p.id)}" data-conta="${esc(conta)}" data-maq="${esc(m.id)}">Aprovar e criar</button>
      <button class="btn vermelho" data-proposta="recusar_envio" data-id="${esc(p.id)}" data-conta="${esc(conta)}" data-maq="${esc(m.id)}">Recusar</button>
    </div>`}
  </div>`;
}

function desenharMaquina(m) {
  const d = m.dados || {};
  const online = Date.now() - new Date(m.atualizado_em).getTime() < ONLINE_MS;
  const atual = d.contaAtual || {};
  const contas = { ...(d.contas || {}) };
  for (const e of d.envios || []) if (e.conta && !contas[e.conta]) contas[e.conta] = { nome: `conta ${e.conta}` };
  if (atual.userId && !contas[atual.userId]) contas[atual.userId] = { nome: atual.nome };

  const blocosConta = Object.entries(contas).map(([id, c]) => {
    const logada = id === atual.userId;
    const criar = (d.criarContas || {})[id] || {};
    const envios = (d.envios || []).filter(e => e.conta === id && (e.ativo || e.agendado));
    const proposta = (d.propostas || {})[id];
    return `<div class="conta">
      <h3>${esc(c.nome)} ${logada ? '<span class="logada">● logada no PC</span>' : ''}</h3>
      <div class="chaves">
        ${chave(m.id, 'Criar envios automaticamente', criar.status || '', criar.ativo, { chave: 'criarAtivo', conta: id }, true)}
        ${chave(m.id, 'Pedir minha aprovação antes de criar', 'o envio só é criado depois do seu OK', criar.aprovar !== false, { chave: 'criarAprovar', conta: id })}
      </div>
      ${proposta ? desenharProposta(m, id, proposta) : ''}
      ${envios.length ? envios.map(e => desenharEnvio(m, e, logada)).join('') : '<p class="mudo">Nenhum envio desta conta na busca.</p>'}
    </div>`;
  }).join('');

  return `<section class="maquina">
    <div class="maq-cab">
      <div><h2>💻 ${esc(d.maquina && d.maquina.nome || m.id)}</h2>
        <span class="mudo">atualizado ${haQuanto(m.atualizado_em)}${d.ultimoCiclo ? ' · última busca ' + hora(d.ultimoCiclo) : ''}</span></div>
      <span class="selo ${online ? 'on' : 'off'}">${online ? 'PC ligado' : 'PC parado'}</span>
    </div>
    ${online ? '' : '<p class="mudo">O PC não manda notícia há mais de 3 min (desligado, Chrome fechado ou sem internet). Os comandos ficam na fila até ele voltar.</p>'}
    <div class="chaves">
      ${chave(m.id, 'Busca de datas ligada', d.intervaloMin ? `a cada ${d.intervaloMin} min` : '', d.ativo, { chave: 'ativo' })}
      ${chave(m.id, 'Agendar sozinho', 'reserva a 1ª data que passar nos filtros', d.autoGlobal, { chave: 'autoGlobal' }, true)}
    </div>
    <div class="linha-botoes"><button class="btn azul" data-verificar="${esc(m.id)}">Verificar agora</button></div>
    ${blocosConta}
    <details><summary>Histórico do PC</summary>
      <ul class="log">${(d.log || []).map(l => `<li><time>${hora(l.quando)}</time><span class="${esc(l.tipo)}">${esc(l.msg)}</span></li>`).join('') || '<li class="mudo">Nada ainda.</li>'}</ul>
    </details>
  </section>`;
}

function desenharComandos() {
  $('#comandos').innerHTML = dados.comandos.map(c => {
    const res = c.resultado ? (c.resultado.erro || c.resultado.texto || '') : '';
    const st = { pendente: 'aguardando PC', executando: 'executando…', feito: 'feito', erro: 'erro', cancelado: 'cancelado' }[c.status] || c.status;
    const detalhe = c.tipo === 'config' ? `${c.dados.chave} → ${c.dados.valor ? 'ligar' : 'desligar'}`
      : c.tipo === 'agendar' ? `#${c.dados.envioId} ${c.dados.vaga ? c.dados.vaga.texto : ''}` : '';
    return `<li><div>${esc(NOMES_CMD[c.tipo] || c.tipo)} <span class="mudo">${esc(detalhe)}</span>
        <div class="res">${hora(c.criado_em)}${res ? ' · ' + esc(res) : ''}</div></div>
      <div><span class="selo ${c.status === 'feito' ? 'ok' : c.status === 'erro' ? 'erro' : ''}">${esc(st)}</span>
        ${c.status === 'pendente' ? `<button class="btn peq" data-cancelar="${c.id}">cancelar</button>` : ''}</div></li>`;
  }).join('') || '<li class="mudo">Nenhum comando ainda.</li>';
}

function desenhar() {
  $('#app').innerHTML = dados.maquinas.length
    ? dados.maquinas.map(desenharMaquina).join('')
    : `<p class="mudo centro">Nenhum PC conectado ainda. Na extensão "ML Full - Busca de Data", abra o painel e preencha
       "Acompanhar pelo celular" com o endereço deste painel e o token.</p>`;
  desenharComandos();
  $('#atualizado').textContent = 'atualizado ' + hora(dados.agora);
}

// ---------- ações ----------

document.addEventListener('change', e => {
  const cfg = e.target.dataset && e.target.dataset.cfg;
  if (!cfg) return;
  const d = JSON.parse(cfg);
  const valor = e.target.checked;
  if (valor && ['autoGlobal', 'criarAtivo'].includes(d.chave)
      && !confirm(d.chave === 'autoGlobal' ? 'Ligar "Agendar sozinho"? O PC vai reservar datas no ML sem perguntar.' : 'Ligar a criação automática de envios nesta conta?')) {
    e.target.checked = false;
    return;
  }
  comandar(e.target.dataset.maq, 'config', { ...d, valor }, e.target);
});

document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.agendar) {
    const d = JSON.parse(b.dataset.agendar);
    if (!confirm(`Reservar no Mercado Livre o envio #${d.envioId} para ${d.vaga.texto}?`)) return;
    comandar(b.dataset.maq, 'agendar', d, b);
  } else if (b.dataset.proposta) {
    const aprovar = b.dataset.proposta === 'aprovar_envio';
    if (!confirm(aprovar ? 'Criar este envio Full no Mercado Livre?' : 'Recusar este envio? Ele não será criado.')) return;
    comandar(b.dataset.maq, b.dataset.proposta, { propostaId: b.dataset.id, conta: b.dataset.conta }, b);
  } else if (b.dataset.verificar) {
    comandar(b.dataset.verificar, 'verificar', {}, b);
  } else if (b.dataset.cancelar) {
    api('/api/full-agenda/comandos/' + b.dataset.cancelar, { method: 'DELETE' }).then(carregar).catch(err => alert(err.message));
  }
});

// ---------- carga ----------

async function carregar() {
  try {
    dados = await api('/api/full-agenda/estado');
    desenhar();
  } catch (e) {
    if (e.message !== 'login') $('#atualizado').textContent = 'erro: ' + e.message;
  }
}

carregar();
setInterval(() => { if (!document.hidden) carregar(); }, 10_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) carregar(); });
