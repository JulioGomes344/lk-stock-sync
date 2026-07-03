import db from './db.js';
import { nanoid } from 'nanoid';

// Lojas padrão — sempre aparecem no select
export const LOJAS_PADRAO = [
  'StockX', 'GOAT', 'Alo Yoga', 'Lululemon',
  'Nude Project', 'Aimé Leon Dore', 'Rhode'
];

// Retorna lojas padrão + lojas que o usuário cadastrou na hora (sem duplicar)
export function listarLojas() {
  const custom = db.prepare('SELECT nome FROM lojas ORDER BY nome').all().map(r => r.nome);
  const todas = [...LOJAS_PADRAO];
  custom.forEach(n => { if (!todas.includes(n)) todas.push(n); });
  return todas;
}

// Salva uma loja nova para reaparecer nas próximas vezes
function registrarLoja(nome) {
  if (!nome) return;
  const limpo = nome.trim();
  if (!limpo || LOJAS_PADRAO.includes(limpo)) return;
  db.prepare('INSERT OR IGNORE INTO lojas (nome) VALUES (?)').run(limpo);
}

// Limiares de alerta de perda (em dias)
// ── SEMÁFORO POR IDADE DO PEDIDO (desde a data da compra) ──
// verde:    até 2 semanas  → dentro do prazo
// amarelo:  3ª e 4ª semana → prazo prestes a expirar
// vermelho: a partir de 4 semanas → atrasado (dispara e-mail)
const SEMANAS_VERDE = 2;     // 0–14 dias
const SEMANAS_AMARELO = 4;   // 15–28 dias
const DIAS_VERDE = SEMANAS_VERDE * 7;     // 14
const DIAS_VERMELHO = SEMANAS_AMARELO * 7; // 28

// ── helpers de data ──
const diasDesde = (iso) => {
  if (!iso) return null;
  // aceita 'YYYY-MM-DD' (data_compra) ou 'YYYY-MM-DD HH:MM:SS' (timestamps)
  const norm = iso.includes(' ') ? iso.replace(' ', 'T') + 'Z'
             : iso.length === 10 ? iso + 'T00:00:00Z'
             : iso;
  const ms = Date.now() - new Date(norm).getTime();
  return Math.floor(ms / 86400000);
};

// Retorna o status visual de um pedido pela idade desde a compra.
// Base = data_compra; se ausente, usa criado_em como fallback.
export function semaforo(pedido) {
  const base = pedido.data_compra || pedido.criado_em;
  const dias = diasDesde(base);
  if (dias === null) return { cor: 'verde', dias: null, semanas: 0, label: 'No prazo' };
  const semanas = Math.floor(dias / 7);
  if (dias < DIAS_VERDE)    return { cor: 'verde',    dias, semanas, label: 'No prazo' };
  if (dias < DIAS_VERMELHO) return { cor: 'amarelo',  dias, semanas, label: 'Prazo prestes a expirar' };
  return { cor: 'vermelho', dias, semanas, label: 'Pedido atrasado' };
}

// ── PEDIDOS ──

export function criarPedido({ loja, data_compra, valor, moeda, origem = 'manual', email_id = null, pedido_loja = null, email_account = null }) {
  const id = nanoid(10);
  registrarLoja(loja); // se for loja nova, guarda para próximas vezes

  // Número sequencial global automático: maior seq atual + 1
  const { max } = db.prepare('SELECT MAX(seq) AS max FROM pedidos').get();
  const seq = (max || 0) + 1;
  const numero_pedido = String(seq).padStart(4, '0'); // 0001, 0002, ...

  db.prepare(`
    INSERT INTO pedidos (id, seq, loja, numero_pedido, pedido_loja, data_compra, valor, moeda, origem, email_id, email_account)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, seq, loja, numero_pedido, pedido_loja, data_compra || null, valor || null, moeda || 'USD', origem, email_id, email_account);
  return id;
}

function sanitizarSku(sku) {
  const limpo = String(sku || '')
    .replace(/\bSIZE\b.*$/i, '')
    .replace(/\b(?:US\s*)?(?:M|W|MEN'?S|MENS|WOMEN'?S|WOMENS|UNISEX)\s*\d+(?:\.5)?\b.*$/i, '')
    .trim();
  return limpo || null;
}

export function adicionarItem(pedido_id, { nome, sku = null, tamanho, qtd }) {
  const id = nanoid(10);
  db.prepare(`
    INSERT INTO itens (id, pedido_id, nome, sku, tamanho, qtd)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, pedido_id, nome, sanitizarSku(sku), tamanho || null, qtd || 1);
  return id;
}

export function getPedidoCompleto(id) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
  if (!pedido) return null;
  pedido.itens = db.prepare('SELECT * FROM itens WHERE pedido_id = ?').all(id);
  if (pedido.lote_id) pedido.lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(pedido.lote_id);
  return pedido;
}

function enriquecer(pedido) {
  pedido.itens = db.prepare('SELECT * FROM itens WHERE pedido_id = ?').all(pedido.id);
  pedido.qtd_itens = pedido.itens.reduce((s, i) => s + i.qtd, 0);
  pedido.qtd_fotos = pedido.itens.filter(i => i.foto_url).length;
  if (pedido.lote_id) pedido.lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(pedido.lote_id);

  // ── SEMÁFORO DE PRAZO (só para pedidos que ainda não chegaram) ──
  pedido.semaforo = pedido.status === 'entregue'
    ? { cor: 'neutro', label: 'Entregue', dias: diasDesde(pedido.data_compra || pedido.criado_em) }
    : semaforo(pedido);

  // ── ALERTA SECUNDÁRIO: divergência fotos × itens ──
  pedido.alertas = [];
  if (pedido.status === 'enviado' && pedido.qtd_fotos < pedido.itens.length)
    pedido.alertas.push({ tipo: 'fotos', msg: `${pedido.qtd_fotos}/${pedido.itens.length} fotos` });

  return pedido;
}

export function listarPorStatus(status) {
  const rows = db.prepare('SELECT * FROM pedidos WHERE status = ? AND excluido_em IS NULL ORDER BY criado_em DESC').all(status);
  return rows.map(enriquecer);
}

// ── REGRA CENTRAL: mover Pendente → Recebido → Enviado ──
export function marcarRecebido(pedido_id) {
  const pedido = getPedidoCompleto(pedido_id);
  if (!pedido) throw new Error('Pedido não encontrado');
  if (pedido.status === 'cancelado') throw new Error('PEDIDO_CANCELADO');
  if (pedido.status === 'entregue') throw new Error('PEDIDO_ENTREGUE');

  db.prepare('UPDATE pedidos SET status = ? WHERE id = ?')
    .run('recebido', pedido_id);
}

// Mover para Enviado exige: pelo menos 1 foto anexada E vínculo a um lote.
export function moverParaEnviado(pedido_id, lote_id) {
  const pedido = getPedidoCompleto(pedido_id);
  if (!pedido) throw new Error('Pedido não encontrado');

  const temFoto = pedido.itens.some(i => i.foto_url);
  if (!temFoto) throw new Error('FOTO_OBRIGATORIA');
  if (!lote_id) throw new Error('LOTE_OBRIGATORIO');

  db.prepare('UPDATE pedidos SET status = ?, lote_id = ? WHERE id = ?')
    .run('enviado', lote_id, pedido_id);
}

// ── LOTES ──

export function criarLote({ descricao, transportadora, codigo_rastreio, data_envio }) {
  const id = nanoid(8);
  db.prepare(`
    INSERT INTO lotes (id, descricao, transportadora, codigo_rastreio, data_envio)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, descricao || null, transportadora || null, codigo_rastreio || null, data_envio || new Date().toISOString().slice(0, 10));
  return id;
}

export function listarLotesAtivos() {
  return db.prepare(`SELECT * FROM lotes WHERE status = 'em_transito' AND excluido_em IS NULL ORDER BY criado_em DESC`).all();
}

export function listarLotesComPedidos() {
  const lotes = db.prepare('SELECT * FROM lotes WHERE excluido_em IS NULL ORDER BY criado_em DESC').all();
  return lotes.map(l => {
    l.pedidos = db.prepare('SELECT * FROM pedidos WHERE lote_id = ? AND excluido_em IS NULL').all(l.id).map(enriquecer);
    return l;
  });
}

// Quando o lote chega: move TODOS os pedidos dele para entregue de uma vez.
export function entregarLote(lote_id) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE pedidos SET status = 'entregue' WHERE lote_id = ?`).run(lote_id);
    db.prepare(`UPDATE lotes SET status = 'entregue' WHERE id = ?`).run(lote_id);
  });
  tx();
}

export function marcarEntregue(pedido_id) {
  db.prepare(`UPDATE pedidos SET status = 'entregue' WHERE id = ? AND status != 'cancelado' AND excluido_em IS NULL`).run(pedido_id);
}

// ── FOTOS ──
export function anexarFoto(item_id, foto_url) {
  db.prepare(`UPDATE itens SET foto_url = ?, foto_recebida_em = datetime('now') WHERE id = ?`)
    .run(foto_url, item_id);
}

// ── RESUMO / KPIs ──
export function resumo() {
  const r = {};
  for (const s of ['pendente', 'recebido', 'enviado', 'entregue', 'cancelado']) {
    r[s] = db.prepare('SELECT COUNT(*) c FROM pedidos WHERE status = ? AND excluido_em IS NULL').get(s).c;
  }
  // prioridade: pedidos com e-mail de prioridade enviado, ainda não chegados/cancelados
  r.prioridade = db.prepare(`
    SELECT COUNT(*) c FROM pedidos
    WHERE prioridade_enviada_em IS NOT NULL
      AND status NOT IN ('entregue','cancelado') AND excluido_em IS NULL
  `).get().c;
  return r;
}

// ── ATRASO: pedidos vermelhos (>4 semanas) ainda não entregues e ainda não avisados ──
export function pedidosAtrasadosNaoAvisados() {
  const rows = db.prepare(`
    SELECT * FROM pedidos
    WHERE status NOT IN ('entregue','cancelado') AND aviso_atraso_em IS NULL AND excluido_em IS NULL
  `).all();
  return rows
    .map(enriquecer)
    .filter(p => p.semaforo.cor === 'vermelho');
}

export function marcarAvisoEnviado(pedido_id) {
  db.prepare(`UPDATE pedidos SET aviso_atraso_em = datetime('now') WHERE id = ?`).run(pedido_id);
}

// Conta por cor — usado nos KPIs do topo
export function resumoSemaforo() {
  const rows = db.prepare(`SELECT * FROM pedidos WHERE status NOT IN ('entregue','cancelado') AND excluido_em IS NULL`).all().map(enriquecer);
  const r = { verde: 0, amarelo: 0, vermelho: 0 };
  rows.forEach(p => r[p.semaforo.cor]++);
  return r;
}

// ── LIXEIRA ──
// Nada é apagado de verdade ao "excluir": o pedido vai para a lixeira
// (excluido_em preenchido) e some das abas, contadores e alertas.
// A exclusão definitiva (com senha, validada no server) é que remove do banco.

export function moverParaLixeira(pedido_id) {
  db.prepare(`UPDATE pedidos SET excluido_em = datetime('now') WHERE id = ?`).run(pedido_id);
}

export function restaurarDaLixeira(pedido_id) {
  db.prepare(`UPDATE pedidos SET excluido_em = NULL WHERE id = ?`).run(pedido_id);
}

export function listarLixeira() {
  const rows = db.prepare(`SELECT * FROM pedidos WHERE excluido_em IS NOT NULL ORDER BY excluido_em DESC`).all();
  return rows.map(enriquecer);
}

// Exclusão definitiva: remove pedido + itens (CASCADE) e devolve as fotos locais
// para o chamador apagar os arquivos do disco.
export function excluirDefinitivo(pedido_id) {
  const fotos = db.prepare(
    `SELECT foto_url FROM itens WHERE pedido_id = ? AND foto_url LIKE '/uploads/%'`
  ).all(pedido_id).map(r => r.foto_url);
  db.prepare('DELETE FROM pedidos WHERE id = ?').run(pedido_id);
  return fotos;
}

// ── INTEGRAÇÃO GMAIL: deduplicação ──
// Um e-mail (Message-ID) ou um pedido da loja só entram uma vez.
export function emailJaProcessado(message_id) {
  return !!db.prepare('SELECT 1 FROM pedidos WHERE email_id = ?').get(message_id);
}

export function atualizarPedidoCapturadoPorEmail(message_id, { pedido_loja, itens = [], valor = null, moeda = null, email_account = null } = {}) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE email_id = ?').get(message_id);
  if (!pedido) return 0;
  let changes = 0;

  if (pedido_loja && !pedido.pedido_loja) {
    changes += db.prepare('UPDATE pedidos SET pedido_loja = ? WHERE id = ?').run(pedido_loja, pedido.id).changes;
  }
  if (valor != null && pedido.valor == null) {
    changes += db.prepare('UPDATE pedidos SET valor = ?, moeda = COALESCE(?, moeda) WHERE id = ?').run(valor, moeda, pedido.id).changes;
  }
  if (email_account && !pedido.email_account) {
    changes += db.prepare('UPDATE pedidos SET email_account = ? WHERE id = ?').run(email_account, pedido.id).changes;
  }

  const itensAtuais = db.prepare('SELECT * FROM itens WHERE pedido_id = ?').all(pedido.id);
  const placeholder = itensAtuais.length === 1 && /Conferir e-mail|itens não extraídos/i.test(itensAtuais[0].nome || '');
  if (placeholder && itens.length && !/Conferir e-mail|itens não extraídos/i.test(itens[0].nome || '')) {
    db.prepare('DELETE FROM itens WHERE pedido_id = ?').run(pedido.id);
    for (const item of itens) {
      const itemId = adicionarItem(pedido.id, item);
      if (item.foto_url) anexarFoto(itemId, item.foto_url);
    }
    changes += 1;
  } else if (itens.length && itensAtuais.length) {
    const updSku = db.prepare(`UPDATE itens SET sku = ? WHERE id = ? AND (sku IS NULL OR sku = '')`);
    itensAtuais.forEach((atual, idx) => {
      const novo = itens[idx];
      if (novo?.sku) changes += updSku.run(sanitizarSku(novo.sku), atual.id).changes;
    });
  }
  return changes;
}
export function pedidoLojaJaExiste(loja, pedido_loja) {
  if (!pedido_loja) return false;
  return !!db.prepare('SELECT 1 FROM pedidos WHERE loja = ? AND pedido_loja = ?').get(loja, pedido_loja);
}

export function ordemCompraJaExiste(pedido_loja) {
  if (!pedido_loja) return false;
  return !!db.prepare('SELECT 1 FROM pedidos WHERE pedido_loja = ?').get(pedido_loja);
}

// Anexa foto a todos os itens SEM foto de um pedido identificado pelo nº da loja.
// Usado pelo enriquecimento via e-mails de envio (StockX Shipped/Delivered).
export function anexarFotoPorPedidoLoja(loja, pedido_loja, foto_url) {
  if (!pedido_loja || !foto_url) return 0;
  const pedido = db.prepare('SELECT id FROM pedidos WHERE loja = ? AND pedido_loja = ?').get(loja, pedido_loja);
  if (!pedido) return 0;
  const r = db.prepare(`
    UPDATE itens SET foto_url = ?, foto_recebida_em = datetime('now')
    WHERE pedido_id = ? AND foto_url IS NULL
  `).run(foto_url, pedido.id);
  return r.changes;
}

// Pedido único com itens, semáforo e alertas (para avisos individuais por e-mail).
export function getPedidoEnriquecido(id) {
  const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
  return p ? enriquecer(p) : null;
}

// ── LIXEIRA DE LOTES ──
// Ao excluir um lote, os pedidos ENVIADOS dele voltam para Pendente (nada se
// perde); pedidos já ENTREGUES não são tocados. Restaurar traz o lote de volta
// (vazio, pois os pedidos foram desvinculados). Exclusão definitiva exige senha.

export function moverLoteParaLixeira(lote_id) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE pedidos SET status = 'recebido', lote_id = NULL
                WHERE lote_id = ? AND status = 'enviado'`).run(lote_id);
    db.prepare(`UPDATE lotes SET excluido_em = datetime('now') WHERE id = ?`).run(lote_id);
  });
  tx();
}

export function restaurarLoteDaLixeira(lote_id) {
  db.prepare(`UPDATE lotes SET excluido_em = NULL WHERE id = ?`).run(lote_id);
}

export function listarLotesLixeira() {
  const lotes = db.prepare(`SELECT * FROM lotes WHERE excluido_em IS NOT NULL ORDER BY excluido_em DESC`).all();
  return lotes.map(l => {
    l.pedidos = db.prepare('SELECT * FROM pedidos WHERE lote_id = ?').all(l.id);
    return l;
  });
}

export function excluirLoteDefinitivo(lote_id) {
  const tx = db.transaction(() => {
    // desvincula qualquer pedido remanescente (ex: entregues que mantinham o vínculo histórico)
    db.prepare(`UPDATE pedidos SET lote_id = NULL WHERE lote_id = ?`).run(lote_id);
    db.prepare(`DELETE FROM lotes WHERE id = ?`).run(lote_id);
  });
  tx();
}

// ── RECOMEÇO: apaga TODOS os pedidos, itens e lotes ──
// Irreversível. Protegido por senha na camada do servidor. Faça backup antes.
export function zerarTudo() {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM itens').run();
    db.prepare('DELETE FROM pedidos').run();
    db.prepare('DELETE FROM lotes').run();
  });
  tx();
}

// Caminho do arquivo do banco (para a rota de backup/download).
export function caminhoBanco() {
  return db.name;
}

// ── REGISTRO DE NOTIFICAÇÕES POR PEDIDO ──
export function marcarCompraConfirmada(pedido_id) {
  db.prepare(`UPDATE pedidos SET compra_confirmada_em = datetime('now') WHERE id = ?`).run(pedido_id);
}
export function marcarPrioridadeEnviada(pedido_id) {
  db.prepare(`UPDATE pedidos SET prioridade_enviada_em = datetime('now') WHERE id = ?`).run(pedido_id);
}

// ── PRIORIDADE ──
// Agrupa pedidos com e-mail de prioridade enviado, que ainda não chegaram.
export function listarPrioridade() {
  const rows = db.prepare(`
    SELECT * FROM pedidos
    WHERE prioridade_enviada_em IS NOT NULL
      AND status NOT IN ('entregue','cancelado')
      AND excluido_em IS NULL
    ORDER BY prioridade_enviada_em DESC
  `).all();
  return rows.map(enriquecer);
}

// ── CANCELAMENTOS ──
export function marcarCancelado(pedido_id) {
  db.prepare(`UPDATE pedidos SET status = 'cancelado', cancelado_em = datetime('now'), lote_id = NULL WHERE id = ?`).run(pedido_id);
}

export function listarCancelados() {
  const rows = db.prepare(`
    SELECT * FROM pedidos
    WHERE status = 'cancelado' AND excluido_em IS NULL
    ORDER BY cancelado_em DESC
  `).all();
  return rows.map(enriquecer);
}

// Confirmar recompra: volta para Pendente com a data da compra = hoje.
export function confirmarRecompra(pedido_id) {
  const hoje = new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE pedidos
    SET status = 'pendente', cancelado_em = NULL, data_compra = ?,
        aviso_atraso_em = NULL, prioridade_enviada_em = NULL
    WHERE id = ?
  `).run(hoje, pedido_id);
}

// Marca pedido como cancelado pelo nº da loja (para o futuro parser de cancelamento).
export function marcarCanceladoPorPedidoLoja(loja, pedido_loja) {
  if (!pedido_loja) return 0;
  const p = db.prepare(`SELECT id FROM pedidos WHERE loja = ? AND pedido_loja = ? AND status != 'cancelado'`).get(loja, pedido_loja);
  if (!p) return 0;
  marcarCancelado(p.id);
  return 1;
}

// Marca cancelado casando pelo NOME do produto (fallback p/ StockX, que não
// envia nº de pedido no cancelamento). Casa só pedidos ativos (não entregue/cancelado).
export function marcarCanceladoPorNome(loja, nome) {
  if (!nome) return 0;
  // normaliza: minúsculas, sem pontuação extra, pra casar variações leves
  const norm = (x) => (x || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const alvo = norm(nome);
  const candidatos = db.prepare(`
    SELECT p.id, i.nome FROM pedidos p
    JOIN itens i ON i.pedido_id = p.id
    WHERE p.loja = ? AND p.status NOT IN ('entregue','cancelado') AND p.excluido_em IS NULL
  `).all(loja);
  // casa se o nome do item começa com / contém o nome do cancelamento (ou vice-versa)
  const hit = candidatos.find(c => {
    const n = norm(c.nome);
    return n === alvo || n.includes(alvo) || alvo.includes(n);
  });
  if (!hit) return 0;
  marcarCancelado(hit.id);
  return 1;
}

// Salva o texto livre de redirecionamento da compra (quem recebe).
export function salvarRedirecionamento(pedido_id, texto) {
  db.prepare(`UPDATE pedidos SET redirecionar_para = ? WHERE id = ?`).run((texto || '').trim() || null, pedido_id);
}

// Define o tipo de origem. Clicar no tipo já ativo limpa (volta a não definido).
export function definirTipoOrigem(pedido_id, tipo) {
  const p = db.prepare('SELECT tipo_origem FROM pedidos WHERE id = ?').get(pedido_id);
  if (!p) return;
  const valido = (tipo === 'estoque' || tipo === 'encomenda') ? tipo : null;
  const novo = (p.tipo_origem === valido) ? null : valido;   // clicar no ativo desmarca
  db.prepare('UPDATE pedidos SET tipo_origem = ? WHERE id = ?').run(novo, pedido_id);
}

// ── OPERADOR VIA WHATSAPP ──
export function buscarOperadorAutorizado(channel, identifier) {
  return db.prepare(`
    SELECT * FROM authorized_operators
    WHERE channel = ? AND identifier = ? AND active = 1
  `).get(channel, identifier);
}

export function registrarMensagemOperador({ channel, groupId, senderIdentifier, senderName, rawMessage, normalizedMessage }) {
  const r = db.prepare(`
    INSERT INTO operator_messages (
      channel, group_id, sender_identifier, sender_name, raw_message, normalized_message, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'received')
  `).run(channel, groupId, senderIdentifier, senderName, rawMessage, normalizedMessage);
  return r.lastInsertRowid;
}

export function atualizarMensagemOperador(id, { status, parserResult, errorMessage } = {}) {
  db.prepare(`
    UPDATE operator_messages
    SET status = COALESCE(?, status),
        parser_result_json = COALESCE(?, parser_result_json),
        error_message = COALESCE(?, error_message)
    WHERE id = ?
  `).run(status || null, parserResult ? JSON.stringify(parserResult) : null, errorMessage || null, id);
}

function normalizarReferenciaProduto(ref) {
  return String(ref || '')
    .replace(/^#/, '')
    .replace(/\bSIZE\b.*$/i, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/SIZE$/i, '');
}

function itemPrincipalDoPedido(pedido_id) {
  if (!pedido_id) return null;
  return db.prepare(`
    SELECT sku, tamanho FROM itens
    WHERE pedido_id = ?
    ORDER BY CASE WHEN sku IS NOT NULL AND sku != '' THEN 0 ELSE 1 END, rowid ASC
    LIMIT 1
  `).get(pedido_id) || null;
}

function skuExibicao(sku) {
  return String(sku || '').replace(/\s+SIZE\b.*$/i, '').trim();
}

function skuPrincipalDoPedido(pedido_id) {
  return skuExibicao(itemPrincipalDoPedido(pedido_id)?.sku) || null;
}

function referenciaProdutoOperador(pedido) {
  const sku = skuPrincipalDoPedido(pedido?.id);
  return sku ? `SKU ${sku}` : `SKU não cadastrada (#${pedido?.numero_pedido || '?'})`;
}

function dataOperadorHoje() {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function formatarNumeroTamanho(n) {
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10).replace('.', '.');
}

function tamanhosUsDoItem(item) {
  const raw = String(item?.tamanho || '').trim();
  const m = raw.match(/(?:US\s*)?(?:M|MEN'?S|MENS|UNISEX)?\s*(\d+(?:\.5)?)/i);
  const w = raw.match(/(?:US\s*)?(?:W|WOMEN'?S|WOMENS)\s*(\d+(?:\.5)?)/i);
  const any = raw.match(/\b(\d+(?:\.5)?)\b/);

  if (w) {
    const womens = parseFloat(w[1]);
    return { mens: formatarNumeroTamanho(womens - 1.5), womens: formatarNumeroTamanho(womens) };
  }
  if (m || any) {
    const mens = parseFloat((m || any)[1]);
    return { mens: formatarNumeroTamanho(mens), womens: formatarNumeroTamanho(mens + 1.5) };
  }
  return { mens: '—', womens: raw || '—' };
}

function numeroTamanho(valor) {
  const match = String(valor ?? '').match(/\d+(?:\.5)?/);
  return match ? parseFloat(match[0]) : null;
}

function tamanhoIgual(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

function sistemaTamanhoDoItem(item) {
  const raw = String(item?.tamanho || '').trim();
  if (/\bUS\s*W\b|\bW(?:OMEN'?S|OMENS)?\b/i.test(raw)) return 'womens';
  if (/\bUS\s*M\b|\bM(?:EN'?S|ENS)?\b|\bUNISEX\b/i.test(raw)) return 'mens_unisex';
  if (/^(?:US\s*)?\d+(?:\.5)?$/i.test(raw)) return 'mens_unisex';
  return 'unknown';
}

function itemBateComTamanhos(item, sizes = {}) {
  const temMens = Number.isFinite(sizes?.mens);
  const temWomens = Number.isFinite(sizes?.womens);
  if (!temMens && !temWomens) return true;

  const sistema = sistemaTamanhoDoItem(item);
  const tamanhoOriginal = numeroTamanho(item?.tamanho);

  // Regra da aba Compras Pendentes:
  // - tamanho com W compara contra a linha US WOMENS;
  // - tamanho com M compara contra a linha US MENS/UNISEX;
  // - tamanho sem letra, só número, é tratado como Unisex e compara contra MENS/UNISEX.
  if (sistema === 'womens') return temWomens && tamanhoIgual(tamanhoOriginal, sizes.womens);
  if (sistema === 'mens_unisex') return temMens && tamanhoIgual(tamanhoOriginal, sizes.mens);

  const tamanhos = tamanhosUsDoItem(item);
  const mens = numeroTamanho(tamanhos.mens);
  const womens = numeroTamanho(tamanhos.womens);
  if (temMens && tamanhoIgual(mens, sizes.mens)) return true;
  if (temWomens && tamanhoIgual(womens, sizes.womens)) return true;
  return false;
}

function linhasProdutoOperador(pedido) {
  const item = itemPrincipalDoPedido(pedido?.id);
  const sku = skuExibicao(item?.sku) || `SKU NÃO CADASTRADA (#${pedido?.numero_pedido || '?'})`;
  const tamanhos = tamanhosUsDoItem(item);
  return [
    sku,
    `US MENS/UNISEX ${tamanhos.mens}`,
    `US WOMENS ${tamanhos.womens}`
  ].join('\n');
}

function respostaRecebidoOperador(pedido) {
  return `RECEBIDO ${dataOperadorHoje()}\n${linhasProdutoOperador(pedido)}`;
}

function respostaEnviadoOperador(pedidos, loteNome = null) {
  const lista = pedidos.map((pedido, idx) => `${idx + 1}. ${linhasProdutoOperador(pedido)}`).join('\n\n');
  const loteLinha = loteNome ? `\n${String(loteNome).trim().toUpperCase()}` : '';
  return `ENVIADO ${dataOperadorHoje()}${loteLinha}\n\n${lista}`;
}

export function buscarPedidoPorReferencia(ref, options = {}) {
  const limpo = String(ref || '').replace(/^#/, '').trim();
  if (!limpo) return null;

  const exato = db.prepare(`
    SELECT * FROM pedidos
    WHERE id = ?
       OR numero_pedido = ?
       OR numero_pedido = ?
       OR CAST(seq AS TEXT) = ?
       OR pedido_loja = ?
    LIMIT 1
  `).get(limpo, limpo, limpo.padStart(4, '0'), limpo, limpo);
  if (exato) return exato;

  // Match por SKU tolerante a hífen/pontuação: "HV8547-601" === "HV8547601".
  // Quando a mensagem formatada traz tamanho, a SKU sozinha não basta: o mesmo
  // modelo pode ter várias compras em tamanhos diferentes. Nesse caso exigimos
  // que SKU + tamanho batam antes de mover para recebido/enviado.
  const alvoSku = normalizarReferenciaProduto(limpo);
  if (alvoSku.length >= 5) {
    const candidatos = db.prepare(`
      SELECT DISTINCT p.*
      FROM pedidos p
      JOIN itens i ON i.pedido_id = p.id
      WHERE i.sku IS NOT NULL AND i.sku != '' AND p.excluido_em IS NULL
      ORDER BY CASE WHEN p.status = 'pendente' THEN 0 ELSE 1 END, p.criado_em DESC
    `).all();
    const porSku = candidatos.find(p => {
      const itens = db.prepare(`
        SELECT sku, tamanho
        FROM itens
        WHERE pedido_id = ? AND sku IS NOT NULL AND sku != ''
      `).all(p.id);
      const itensComSku = itens.filter(i => normalizarReferenciaProduto(i.sku) === alvoSku);
      if (!itensComSku.length) return false;
      return itensComSku.some(i => itemBateComTamanhos(i, options.sizes));
    });
    if (porSku) return porSku;
  }

  return null;
}

function obterOuCriarLotePorCodigo(codigo) {
  if (!codigo) return null;
  const descricao = String(codigo).trim().toUpperCase();
  const existente = db.prepare(`
    SELECT id FROM lotes
    WHERE UPPER(descricao) = ? AND excluido_em IS NULL
    LIMIT 1
  `).get(descricao);
  if (existente) return existente.id;
  return criarLote({ descricao, transportadora: null, codigo_rastreio: null, data_envio: new Date().toISOString().slice(0, 10) });
}

export function registrarEventoOperador({ orderId, eventType, oldStatus, newStatus, oldValue, newValue, operatorMessageId, senderIdentifier, senderName, rawMessage, confidence = 'high' }) {
  db.prepare(`
    INSERT INTO order_events (
      order_id, event_type, old_status, new_status, old_value, new_value, source,
      operator_message_id, sender_identifier, sender_name, raw_message, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, 'whatsapp_group', ?, ?, ?, ?, ?)
  `).run(orderId || null, eventType, oldStatus || null, newStatus || null, oldValue || null, newValue || null, operatorMessageId, senderIdentifier, senderName, rawMessage, confidence);
}

export function aplicarAcaoOperador(parsed, operator, operatorMessageId, rawMessage) {
  const actor = { senderIdentifier: operator.identifier, senderName: operator.name, operatorMessageId, rawMessage, confidence: parsed.confidence || 'high' };

  if (parsed.intent === 'mark_received') {
    const pedido = buscarPedidoPorReferencia(parsed.orderRef, { sizes: parsed.sizes });
    if (!pedido) return { status: 'not_found', reply: `Não encontrei o pedido ${parsed.orderRef}.` };
    const refProduto = referenciaProdutoOperador(pedido);
    if (pedido.status === 'entregue') return { status: 'blocked', reply: `${refProduto} já está entregue.` };
    if (pedido.status === 'cancelado') return { status: 'blocked', reply: `${refProduto} está cancelado.` };

    db.prepare(`UPDATE pedidos SET status = 'recebido' WHERE id = ?`).run(pedido.id);
    registrarEventoOperador({ orderId: pedido.id, eventType: 'status_changed', oldStatus: pedido.status, newStatus: 'recebido', ...actor });
    return { status: 'applied', reply: respostaRecebidoOperador(pedido) };
  }

  if (parsed.intent === 'mark_shipped') {
    const pedido = buscarPedidoPorReferencia(parsed.orderRef, { sizes: parsed.sizes });
    if (!pedido) return { status: 'not_found', reply: `Não encontrei o pedido ${parsed.orderRef}.` };
    const refProduto = referenciaProdutoOperador(pedido);
    if (pedido.status === 'entregue') return { status: 'blocked', reply: `${refProduto} já está entregue.` };
    if (pedido.status === 'cancelado') return { status: 'blocked', reply: `${refProduto} está cancelado.` };

    const loteId = obterOuCriarLotePorCodigo(parsed.batch);
    db.prepare(`
      UPDATE pedidos
      SET status = 'enviado',
          lote_id = COALESCE(?, lote_id),
          tracking_code = COALESCE(?, tracking_code)
      WHERE id = ?
    `).run(loteId, parsed.tracking, pedido.id);

    registrarEventoOperador({ orderId: pedido.id, eventType: 'status_changed', oldStatus: pedido.status, newStatus: 'enviado', newValue: parsed.batch || parsed.tracking || null, ...actor });
    return { status: 'applied', reply: respostaEnviadoOperador([pedido], parsed.batch) };
  }

  if (parsed.intent === 'mark_delivered') {
    const pedido = buscarPedidoPorReferencia(parsed.orderRef, { sizes: parsed.sizes });
    if (!pedido) return { status: 'not_found', reply: `Não encontrei o pedido ${parsed.orderRef}.` };
    const refProduto = referenciaProdutoOperador(pedido);
    if (pedido.status === 'cancelado') return { status: 'blocked', reply: `${refProduto} está cancelado.` };

    db.prepare(`UPDATE pedidos SET status = 'entregue' WHERE id = ?`).run(pedido.id);
    registrarEventoOperador({ orderId: pedido.id, eventType: 'status_changed', oldStatus: pedido.status, newStatus: 'entregue', ...actor });
    return { status: 'applied', reply: `Atualizado: ${refProduto} → Entregue` };
  }

  if (parsed.intent === 'set_tracking') {
    const pedido = buscarPedidoPorReferencia(parsed.orderRef, { sizes: parsed.sizes });
    if (!pedido) return { status: 'not_found', reply: `Não encontrei o pedido ${parsed.orderRef}.` };
    const refProduto = referenciaProdutoOperador(pedido);
    db.prepare(`UPDATE pedidos SET tracking_code = ? WHERE id = ?`).run(parsed.tracking, pedido.id);
    registrarEventoOperador({ orderId: pedido.id, eventType: 'tracking_updated', oldValue: pedido.tracking_code, newValue: parsed.tracking, ...actor });
    return { status: 'applied', reply: `Tracking atualizado: ${refProduto} → ${parsed.tracking}` };
  }

  if (parsed.intent === 'add_note' || parsed.intent === 'report_problem') {
    const pedido = buscarPedidoPorReferencia(parsed.orderRef, { sizes: parsed.sizes });
    if (!pedido) return { status: 'not_found', reply: `Não encontrei o pedido ${parsed.orderRef}.` };
    const refProduto = referenciaProdutoOperador(pedido);
    const prefix = parsed.intent === 'report_problem' ? '[Problema WhatsApp]' : '[Obs WhatsApp]';
    const nova = `${pedido.observacoes || ''}\n${prefix} ${parsed.note}`.trim();
    db.prepare(`UPDATE pedidos SET observacoes = ? WHERE id = ?`).run(nova, pedido.id);
    registrarEventoOperador({ orderId: pedido.id, eventType: parsed.intent === 'report_problem' ? 'problem_reported' : 'note_added', oldValue: pedido.observacoes, newValue: parsed.note, ...actor });
    return { status: 'applied', reply: `Registrado em ${refProduto}: ${parsed.note}` };
  }

  if (parsed.intent === 'assign_batch') {
    const loteId = obterOuCriarLotePorCodigo(parsed.batch);
    const pedidosEnviados = [];
    const fail = [];
    const tx = db.transaction(() => {
      for (const ref of parsed.orderRefs) {
        const pedido = buscarPedidoPorReferencia(ref);
        if (!pedido || ['entregue', 'cancelado'].includes(pedido.status)) { fail.push(ref); continue; }
        db.prepare(`UPDATE pedidos SET lote_id = ?, status = 'enviado' WHERE id = ?`).run(loteId, pedido.id);
        registrarEventoOperador({ orderId: pedido.id, eventType: 'batch_assigned', oldStatus: pedido.status, newStatus: 'enviado', newValue: parsed.batch, ...actor });
        pedidosEnviados.push(pedido);
      }
    });
    tx();
    if (!pedidosEnviados.length) return { status: 'not_found', reply: `Nenhum pedido válido encontrado para o lote ${parsed.batch.toUpperCase()}.` };
    const reply = respostaEnviadoOperador(pedidosEnviados, parsed.batch);
    return { status: fail.length ? 'partial' : 'applied', reply: fail.length ? `${reply}\n\nNão encontrados/bloqueados: ${fail.join(', ')}` : reply };
  }

  return { status: 'unknown', reply: 'Não entendi. Use: recebido 1050 ou enviado 1050 lote CX12 tracking LB123BR' };
}

export function listarHistoricoWhatsapp(limit = 100) {
  return db.prepare(`
    SELECT
      m.id,
      m.created_at,
      m.channel,
      m.group_id,
      m.sender_identifier,
      m.sender_name,
      m.raw_message,
      m.status,
      m.parser_result_json,
      m.error_message,
      e.order_id,
      e.event_type,
      e.old_status,
      e.new_status,
      e.old_value,
      e.new_value,
      p.numero_pedido,
      p.loja
    FROM operator_messages m
    LEFT JOIN order_events e ON e.operator_message_id = m.id
    LEFT JOIN pedidos p ON p.id = e.order_id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(limit);
}

export function listarFilaErrosWhatsapp(limit = 50) {
  return db.prepare(`
    SELECT id, created_at, channel, group_id, sender_identifier, sender_name,
           raw_message, status, parser_result_json, error_message
    FROM operator_messages
    WHERE status IN ('unauthorized','unknown','not_found','blocked','partial','error')
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit);
}
