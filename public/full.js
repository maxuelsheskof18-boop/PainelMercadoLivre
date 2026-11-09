// Busca de data Full — acompanhar e comandar pelo celular.
// Quem executa é a extensão no PC; aqui só lemos a "foto" que ela manda
// e gravamos comandos que ela busca no próximo minuto.

const $ = s => document.querySelector(s);
const ONLINE_MS = 3 * 60_000; // a extensão manda o estado a cada minuto
const TRAVADO_MS = 6 * 60_000; // um passo da busca nunca leva tanto: algo travou
const TIPOS = { ftl: 'Veículo particular', supplier: 'Envio pelo fornecedor', ftlp: 'Transportadora privada', pickup: 'Coleta a domicílio' };
const NOMES_CMD = { agendar: 'Reservar data', aprovar_envio: 'Criar envio aprovado', recusar_envio: 'Recusar envio', config: 'Mudar chave', verificar: 'Verificar agora' };
const NOMES_CHAVE = { ativo: 'Busca de datas', autoGlobal: 'Agendar sozinho', criarAtivo: 'Criar envios', criarAprovar: 'Pedir aprovação' };

const ICONE = {
  pc: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6v2h3v2H7v-2h3v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2v8h14V7H5Z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="m9.5 16.2-4-4 1.4-1.4 2.6 2.6 7-7 1.4 1.4-8.4 8.4Z"/></svg>',
  alerta: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 7h2v7h-2V7Zm0 9h2v2h-2v-2Z"/></svg>',
  pausa: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 6h3v12H8V6Zm5 0h3v12h-3V6Z"/></svg>'
};

let dados = { maquinas: [], comandos: [] };
let ultimaCarga = 0;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hora(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function soHora(ts) {
  return ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
}

function ms(ts) { return typeof ts === 'number' ? ts : new Date(ts).getTime(); }

function haQuanto(ts) {
  const s = Math.max(0, Math.round((Date.now() - ms(ts)) / 1000));
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  return `há ${Math.floor(s / 3600)} h`;
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
    if (e.message !== 'login') alert('Não enviei o pedido: ' + e.message);
  } finally {
    if (botao) botao.disabled = false;
  }
}

// Comando ainda não executado pelo PC (mostra "aguardando o PC").
function pendente(maquina, filtro) {
  return dados.comandos.find(c => c.maquina === maquina && ['pendente', 'executando'].includes(c.status) && filtro(c));
}

function online(m) { return Date.now() - ms(m.atualizado_em) < ONLINE_MS; }
function nomeMaquina(m) { return (m.dados && m.dados.maquina && m.dados.maquina.nome) || m.id; }

// Contas que aparecem num PC: a logada, as que ele conhece e as donas dos envios.
function contasDe(d) {
  const contas = { ...(d.contas || {}) };
  for (const e of d.envios || []) if (e.conta && !contas[e.conta]) contas[e.conta] = { nome: `conta ${e.conta}` };
  const atual = d.contaAtual || {};
  if (atual.userId && !contas[atual.userId]) contas[atual.userId] = { nome: atual.nome, email: atual.email };
  return contas;
}

// ---------- resumo e "precisa de você" ----------

function desenharResumo() {
  const ms_ = dados.maquinas;
  const ligados = ms_.filter(online).length;
  let naBusca = 0, comData = 0, agendadosHoje = 0, propostas = 0;
  const hoje = new Date().toDateString();
  for (const m of ms_) {
    const d = m.dados || {};
    for (const e of d.envios || []) {
      if (e.ativo && !e.agendado) naBusca++;
      if (e.ativo && !e.agendado && e.ultimo && e.ultimo.boas) comData++;
      if (e.agendado && e.agendado.quando && new Date(e.agendado.quando).toDateString() === hoje) agendadosHoje++;
    }
    propostas += Object.keys(d.propostas || {}).length;
  }
  const kpi = (rotulo, valor, destaque) => `<div class="kpi${destaque ? ' destaque' : ''}"><span>${rotulo}</span><b>${valor}</b></div>`;
  $('#resumo').innerHTML =
    kpi('PCs ligados', `${ligados}/${ms_.length}`, ms_.length && ligados < ms_.length) +
    kpi('Envios buscando data', naBusca) +
    kpi('Para aprovar', comData + propostas, comData + propostas > 0) +
    kpi('Agendados hoje', agendadosHoje);
}

// Tudo que espera um "sim" seu, de todos os PCs, no topo da página.
function desenharAcoes() {
  const blocos = [];
  for (const m of dados.maquinas) {
    const d = m.dados || {};
    const contas = contasDe(d);
    const atual = (d.contaAtual || {}).userId;
    for (const [conta, p] of Object.entries(d.propostas || {})) {
      blocos.push(`<div class="acao">${desenharProposta(m, conta, p, (contas[conta] || {}).nome)}</div>`);
    }
    for (const e of d.envios || []) {
      const u = e.ultimo || {};
      if (!e.ativo || e.agendado || !u.boas || !u.melhores) continue;
      blocos.push(`<div class="acao">
        <div class="acao-cab"><b>Data livre para o envio #${esc(e.id)}</b>
          <small>${esc(nomeMaquina(m))} · ${esc((contas[e.conta] || {}).nome || '')}${e.unidades ? ' · ' + e.unidades + ' un.' : ''}</small></div>
        ${desenharVagas(m, e, e.conta === atual)}
      </div>`);
    }
  }
  $('#acoes').innerHTML = blocos.length
    ? `<h2>${ICONE.alerta} Precisa de você</h2>${blocos.join('')}`
    : '';
}

// ---------- PC ----------

function chave(maquina, rotulo, sub, ligado, dadosCfg, perigo) {
  const p = pendente(maquina, c => c.tipo === 'config' && c.dados.chave === dadosCfg.chave && (c.dados.conta || '') === (dadosCfg.conta || ''));
  const valor = p ? !!p.dados.valor : !!ligado;
  return `<div class="chave-linha">
    <div>${esc(rotulo)}<small>${esc(sub || '')}</small>${p ? '<span class="aguarda">aguardando o PC aplicar…</span>' : ''}</div>
    <label class="sw ${perigo ? 'perigo' : ''}"><input type="checkbox" aria-label="${esc(rotulo)}" ${valor ? 'checked' : ''} ${p ? 'disabled' : ''}
      data-cfg='${esc(JSON.stringify(dadosCfg))}' data-maq="${esc(maquina)}"><span></span></label>
  </div>`;
}

// O quadro "o que o PC está fazendo": anima enquanto busca, conta até a próxima busca
// quando está parado e fica vermelho se algo deu errado ou travou.
function desenharAtividade(m) {
  const d = m.dados || {};
  const a = d.atividade;
  const intervalo = (Number(d.intervaloMin) || 3) * 60_000;

  if (!online(m)) {
    return `<div class="atividade erro"><div class="ativ-linha">
      <span class="ativ-icone">${ICONE.alerta}</span>
      <span class="texto"><b>PC sem sinal</b><span class="det">Não manda notícia ${haQuanto(m.atualizado_em)} — desligado, Chrome fechado ou sem internet. Os pedidos ficam na fila até ele voltar.</span></span>
    </div></div>`;
  }
  if (a && a.fase !== 'parado') {
    const travado = Date.now() - a.desde > TRAVADO_MS;
    return `<div class="atividade ${travado ? 'erro' : 'rodando'}">
      <div class="ativ-linha">
        ${travado ? `<span class="ativ-icone">${ICONE.alerta}</span>` : '<span class="spinner" aria-hidden="true"></span>'}
        <span class="texto"><b>${travado ? 'Parece travado' : a.fase === 'criando' ? 'Criando envio' : a.fase === 'agendando' ? 'Reservando data' : a.fase === 'comando' ? 'Fazendo seu pedido' : 'Buscando datas agora'}</b>
          <span class="det">${esc(a.texto)}</span></span>
        <span class="quando" data-ha="${a.desde}">${haQuanto(a.desde)}</span>
      </div>
      ${travado ? '' : '<div class="barra"><i></i></div>'}
    </div>`;
  }
  if (!d.ativo) {
    return `<div class="atividade parado"><div class="ativ-linha">
      <span class="ativ-icone">${ICONE.pausa}</span>
      <span class="texto"><b>Busca desligada</b><span class="det">Ligue a chave abaixo para o PC voltar a procurar datas.</span></span>
    </div></div>`;
  }
  const ultima = (a && a.desde) || d.ultimoCiclo;
  const erro = a && a.ok === false;
  // A busca acontece a cada N min (+ até 20 s de folga); se passou muito disso, algo parou.
  const atrasada = ultima && Date.now() - ms(ultima) > intervalo * 2 + 120_000;
  const titulo = erro ? 'A última busca teve problema' : atrasada ? 'A busca está atrasada' : 'Tudo certo';
  return `<div class="atividade ${erro || atrasada ? 'erro' : 'ok'}">
    <div class="ativ-linha">
      <span class="ativ-icone">${erro || atrasada ? ICONE.alerta : ICONE.ok}</span>
      <span class="texto"><b>${titulo}</b>
        <span class="det">${atrasada && !erro ? `Nenhuma busca ${haQuanto(ultima)}. Confira se o Chrome do PC está aberto.` : esc(a ? a.texto : 'Aguardando a primeira busca')}</span></span>
      ${ultima ? `<span class="quando">última ${soHora(ultima)}</span>` : ''}
    </div>
    ${ultima && !atrasada ? `<div class="barra" title="Tempo até a próxima busca"><i data-prox="${ms(ultima)}" data-intervalo="${intervalo}"></i></div>
      <span class="mudo" data-prox-texto="${ms(ultima)}" data-intervalo="${intervalo}"></span>` : ''}
  </div>`;
}

function seloEnvio(e) {
  if (e.agendado) return '<span class="selo ok">Agendado</span>';
  const u = e.ultimo;
  if (!u) return '<span class="selo">Aguardando busca</span>';
  if (u.erro) return '<span class="selo erro">Erro</span>';
  if (u.boas) return `<span class="selo achou"><i></i>${u.boas} data(s) livre(s)</span>`;
  if (u.total) return '<span class="selo nada">Fora do filtro</span>';
  return '<span class="selo nada">Sem datas</span>';
}

function desenharVagas(m, e, logada) {
  const u = e.ultimo || {};
  const p = pendente(m.id, c => c.tipo === 'agendar' && String(c.dados.envioId) === String(e.id));
  if (p) return `<div class="vagas"><div class="vaga"><span>${esc(p.dados.vaga && p.dados.vaga.texto)}<small>O PC vai reservar na próxima passada (até 1 min)…</small></span><span class="spinner"></span></div></div>`;
  return `<div class="vagas">${u.melhores.slice(0, 4).map(v => {
    const botao = !logada
      ? '<span class="mudo">conta não logada neste PC</span>'
      : `<button class="btn verde peq" data-agendar='${esc(JSON.stringify({ envioId: e.id, conta: e.conta, vaga: v }))}' data-maq="${esc(m.id)}">Aprovar e reservar</button>`;
    // "qui 12/11 03:00 · BRSP06" → "qui 12/11 · 03:00–03:05" e o centro embaixo.
    const [quando] = String(v.texto || '').split(' · ');
    const dia = quando.replace(/\s*\d{1,2}:\d{2}$/, '');
    const local = [v.centro, v.nome && v.nome !== v.centro ? v.nome : ''].filter(Boolean).join(' · ');
    return `<div class="vaga"><span>${esc(dia)} · ${esc(v.hora || '')}${v.horaFim ? '–' + esc(v.horaFim) : ''}${v.custo ? ` · R$ ${esc(v.custo)}` : ''}<small>${esc(local)}</small></span>${botao}</div>`;
  }).join('')}</div>`;
}

function desenharEnvio(m, e, logada) {
  const u = e.ultimo || {};
  let corpo = '';
  if (e.agendado) corpo = `<div class="env-info">✔ Reservado: ${esc(e.agendado.texto || '')}</div>`;
  else if (u.erro) corpo = `<div class="env-info" style="color:var(--vermelho)">${esc(u.erro)}</div>`;
  else if (u.boas && u.melhores) corpo = desenharVagas(m, e, logada);
  else if (u.total && u.primeira) corpo = `<div class="env-info mudo">Primeira data fora do filtro: ${esc(u.primeira.texto)}</div>`;
  return `<li class="envio">
    <div class="env-cab"><b>#${esc(e.id)}</b>${seloEnvio(e)}</div>
    <div class="env-info mudo">${esc([e.titulo, e.unidades ? e.unidades + ' un.' : '', TIPOS[e.tipo], u.quando ? 'verificado ' + hora(u.quando) : ''].filter(Boolean).join(' · '))}</div>
    ${corpo}
  </li>`;
}

function desenharProposta(m, conta, p, nomeConta) {
  const ja = pendente(m.id, c => ['aprovar_envio', 'recusar_envio'].includes(c.tipo) && String(c.dados.propostaId) === String(p.id));
  return `<div class="acao-cab"><b>Envio pronto para criar</b><small>${esc(nomeMaquina(m))}${nomeConta ? ' · ' + esc(nomeConta) : ''} · montado ${hora(p.criada)}</small></div>
    <div class="env-info">${p.itens.length} produto(s) · <b>${p.totalUn} un.</b>${p.vol ? ` · ~${Number(p.vol).toLocaleString('pt-BR')} m³` : ''}${p.grandes ? ` · ${p.grandes} un. grandes` : ''}</div>
    <details><summary class="mudo">ver produtos</summary>
      <ul class="env-info">${p.itens.slice(0, 40).map(i => `<li>${esc(i.nome || i.id)} — <b>${i.unidades} un.</b>${i.regra ? ` <span class="mudo">(${esc(i.regra)})</span>` : ''}</li>`).join('')}
      ${p.itens.length > 40 ? `<li class="mudo">+${p.itens.length - 40} produto(s)</li>` : ''}</ul>
    </details>
    ${ja ? '<span class="aguarda"><span class="spinner"></span> Resposta enviada — o PC executa na próxima passada…</span>' : `<div class="linha-botoes">
      <button class="btn verde" data-proposta="aprovar_envio" data-id="${esc(p.id)}" data-conta="${esc(conta)}" data-maq="${esc(m.id)}">Aprovar e criar</button>
      <button class="btn vermelho" data-proposta="recusar_envio" data-id="${esc(p.id)}" data-conta="${esc(conta)}" data-maq="${esc(m.id)}">Recusar</button>
    </div>`}`;
}

function desenharMaquina(m) {
  const d = m.dados || {};
  const on = online(m);
  const atual = d.contaAtual || {};
  const contas = contasDe(d);

  const blocosConta = Object.entries(contas).map(([id, c]) => {
    const logada = id === atual.userId;
    const criar = (d.criarContas || {})[id] || {};
    const envios = (d.envios || []).filter(e => e.conta === id && (e.ativo || e.agendado));
    return `<div class="conta">
      <div class="conta-cab"><h3>${esc(c.nome)}</h3>${logada ? '<span class="selo on"><i></i>logada no PC</span>' : '<span class="selo">não logada</span>'}
        ${c.email ? `<small>${esc(c.email)}</small>` : ''}</div>
      <div class="chaves">
        ${chave(m.id, 'Criar envios automaticamente', criar.status || '', criar.ativo, { chave: 'criarAtivo', conta: id }, true)}
        ${chave(m.id, 'Pedir minha aprovação antes de criar', 'o envio só é criado depois do seu OK', criar.aprovar !== false, { chave: 'criarAprovar', conta: id })}
      </div>
      ${envios.length ? `<ul class="envios">${envios.map(e => desenharEnvio(m, e, logada)).join('')}</ul>` : '<p class="mudo" style="margin-top:10px">Nenhum envio desta conta na busca.</p>'}
    </div>`;
  }).join('');

  const verificando = pendente(m.id, c => c.tipo === 'verificar');
  return `<section class="maquina">
    <div class="maq-cab">
      <div class="maq-nome"><span class="maq-icone">${ICONE.pc}</span>
        <div><h2>${esc(nomeMaquina(m))}</h2>
          <p>${esc([atual.nome, d.versao ? 'extensão ' + d.versao : '', 'notícia ' + haQuanto(m.atualizado_em)].filter(Boolean).join(' · '))}</p></div></div>
      <span class="selo ${on ? 'on' : 'off'}"><i></i>${on ? 'Ligado' : 'Sem sinal'}</span>
    </div>
    ${desenharAtividade(m)}
    <div class="controles">
      ${chave(m.id, 'Busca de datas', d.intervaloMin ? `a cada ${d.intervaloMin} min` : '', d.ativo, { chave: 'ativo' })}
      ${chave(m.id, 'Agendar sozinho', 'reserva a 1ª data que passar nos filtros', d.autoGlobal, { chave: 'autoGlobal' }, true)}
    </div>
    <div class="maq-botoes">
      ${verificando ? '<span class="aguarda"><span class="spinner"></span> Pedido de verificação na fila do PC…</span>'
        : `<button class="btn azul" data-verificar="${esc(m.id)}">Verificar agora</button>`}
    </div>
    ${blocosConta}
    <details class="historico"><summary>Histórico do PC</summary>
      <ul class="log">${(d.log || []).map(l => `<li><time>${hora(l.quando)}</time><span class="${esc(l.tipo)}">${esc(l.msg)}</span></li>`).join('') || '<li class="mudo">Nada ainda.</li>'}</ul>
    </details>
  </section>`;
}

function desenharComandos() {
  $('#comandos').innerHTML = dados.comandos.map(c => {
    const res = c.resultado ? (c.resultado.erro || c.resultado.texto || '') : '';
    const st = { pendente: 'na fila', executando: 'executando', feito: 'feito', erro: 'erro', cancelado: 'cancelado' }[c.status] || c.status;
    const maq = dados.maquinas.find(m => m.id === c.maquina);
    const detalhe = c.tipo === 'config' ? `${NOMES_CHAVE[c.dados.chave] || c.dados.chave}: ${c.dados.valor ? 'ligar' : 'desligar'}`
      : c.tipo === 'agendar' ? `#${c.dados.envioId} · ${c.dados.vaga ? c.dados.vaga.texto : ''}` : '';
    const classe = c.status === 'feito' ? 'on' : c.status === 'erro' ? 'erro' : ['pendente', 'executando'].includes(c.status) ? 'azul' : '';
    return `<li><div>${esc(NOMES_CMD[c.tipo] || c.tipo)} <span class="mudo">${esc(detalhe)}</span>
        <div class="res">${esc(maq ? nomeMaquina(maq) : c.maquina)} · ${hora(c.criado_em)}${res ? ' · ' + esc(res) : ''}</div></div>
      <div class="dir"><span class="selo ${classe}">${esc(st)}</span>
        ${c.status === 'pendente' ? `<button class="btn fantasma peq" data-cancelar="${c.id}">Cancelar</button>` : ''}</div></li>`;
  }).join('') || '<li class="mudo">Nenhum pedido ainda.</li>';
}

function desenhar() {
  // Redesenhar no meio de um toque num botão/chave atrapalha: espera soltar.
  if (document.activeElement && document.activeElement.matches('input, button') && document.activeElement.disabled) return;
  desenharResumo();
  desenharAcoes();
  $('#app').innerHTML = dados.maquinas.length
    ? dados.maquinas.map(desenharMaquina).join('')
    : `<div class="vazio">Nenhum PC conectado ainda. Na extensão "ML Full - Busca de Data", preencha
       "Acompanhar pelo celular" com o endereço deste painel e o token.</div>`;
  desenharComandos();
  relogios();
}

// Contagens que andam sozinhas entre uma carga e outra (a cada 1 s).
function relogios() {
  for (const el of document.querySelectorAll('[data-ha]')) el.textContent = haQuanto(Number(el.dataset.ha));
  for (const el of document.querySelectorAll('[data-prox]')) {
    const frac = (Date.now() - Number(el.dataset.prox)) / Number(el.dataset.intervalo);
    el.style.width = Math.min(100, Math.max(0, frac * 100)) + '%';
  }
  for (const el of document.querySelectorAll('[data-prox-texto]')) {
    const falta = Number(el.dataset.proxTexto) + Number(el.dataset.intervalo) - Date.now();
    el.textContent = falta > 60_000 ? `Próxima busca em ~${Math.ceil(falta / 60_000)} min`
      : falta > 0 ? `Próxima busca em ${Math.ceil(falta / 1000)}s` : 'Próxima busca a qualquer momento…';
  }
  const vivo = $('#aoVivo');
  if (ultimaCarga) {
    const atraso = Date.now() - ultimaCarga;
    vivo.className = 'ao-vivo ' + (atraso < 30_000 ? 'ok' : 'erro');
    vivo.querySelector('span').textContent = atraso < 30_000 ? `ao vivo · ${soHora(ultimaCarga)}` : `sem atualizar ${haQuanto(ultimaCarga)}`;
  }
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
    const maq = dados.maquinas.find(m => m.id === b.dataset.maq);
    if (!confirm(`Reservar o envio #${d.envioId} para ${d.vaga.texto}?\n\nO PC "${maq ? nomeMaquina(maq) : ''}" faz a reserva no Mercado Livre sozinho — não precisa abrir nada. Se esse horário sair antes, ele pega outro horário no mesmo dia e centro.`)) return;
    comandar(b.dataset.maq, 'agendar', d, b);
  } else if (b.dataset.proposta) {
    const aprovar = b.dataset.proposta === 'aprovar_envio';
    if (!confirm(aprovar ? 'Criar este envio Full no Mercado Livre? O PC cria e já começa a buscar a data.' : 'Recusar este envio? Ele não será criado.')) return;
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
    ultimaCarga = Date.now();
    desenhar();
  } catch (e) {
    if (e.message !== 'login') {
      $('#aoVivo').className = 'ao-vivo erro';
      $('#aoVivo').querySelector('span').textContent = 'erro: ' + e.message;
    }
  }
}

carregar();
setInterval(() => { if (!document.hidden) carregar(); }, 10_000);
setInterval(relogios, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) carregar(); });
