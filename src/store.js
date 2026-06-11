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

export function criarPedido({ loja, data_compra, valor, moeda, origem = 'manual', email_id = null, pedido_loja = null }) {
  const id = nanoid(10);
  registrarLoja(loja); // se for loja nova, guarda para próximas vezes

  // Número sequencial global automático: maior seq atual + 1
  const { max } = db.prepare('SELECT MAX(seq) AS max FROM pedidos').get();
  const seq = (max || 0) + 1;
  const numero_pedido = String(seq).padStart(4, '0'); // 0001, 0002, ...

  db.prepare(`
    INSERT INTO pedidos (id, seq, loja, numero_pedido, pedido_loja, data_compra, valor, moeda, origem, email_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, seq, loja, numero_pedido, pedido_loja, data_compra || null, valor || null, moeda || 'USD', origem, email_id);
  return id;
}

export function adicionarItem(pedido_id, { nome, tamanho, qtd }) {
  const id = nanoid(10);
  db.prepare(`
    INSERT INTO itens (id, pedido_id, nome, tamanho, qtd)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, pedido_id, nome, tamanho || null, qtd || 1);
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

// ── REGRA CENTRAL: mover Pendente → Enviado ──
// Exige: pelo menos 1 foto anexada E vínculo a um lote.
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
  return db.prepare(`SELECT * FROM lotes WHERE status = 'em_transito' ORDER BY criado_em DESC`).all();
}

export function listarLotesComPedidos() {
  const lotes = db.prepare('SELECT * FROM lotes ORDER BY criado_em DESC').all();
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

// ── FOTOS ──
export function anexarFoto(item_id, foto_url) {
  db.prepare(`UPDATE itens SET foto_url = ?, foto_recebida_em = datetime('now') WHERE id = ?`)
    .run(foto_url, item_id);
}

// ── RESUMO / KPIs ──
export function resumo() {
  const r = {};
  for (const s of ['pendente', 'enviado', 'entregue']) {
    r[s] = db.prepare('SELECT COUNT(*) c FROM pedidos WHERE status = ? AND excluido_em IS NULL').get(s).c;
  }
  return r;
}

// ── ATRASO: pedidos vermelhos (>4 semanas) ainda não entregues e ainda não avisados ──
export function pedidosAtrasadosNaoAvisados() {
  const rows = db.prepare(`
    SELECT * FROM pedidos
    WHERE status != 'entregue' AND aviso_atraso_em IS NULL AND excluido_em IS NULL
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
  const rows = db.prepare(`SELECT * FROM pedidos WHERE status != 'entregue' AND excluido_em IS NULL`).all().map(enriquecer);
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
export function pedidoLojaJaExiste(loja, pedido_loja) {
  if (!pedido_loja) return false;
  return !!db.prepare('SELECT 1 FROM pedidos WHERE loja = ? AND pedido_loja = ?').get(loja, pedido_loja);
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
