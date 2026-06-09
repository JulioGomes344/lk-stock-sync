import db from './db.js';

// ─────────────────────────────────────────────────────────────
// SCHEMA — 3 tabelas que sustentam todo o conceito
// pedidos → itens → lotes
// Na migração para Postgres (Fase 2), só trocar a sintaxe de
// AUTOINCREMENT/TEXT; a lógica das queries permanece igual.
// ─────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS lotes (
    id              TEXT PRIMARY KEY,
    descricao       TEXT,
    transportadora  TEXT,
    codigo_rastreio TEXT,
    data_envio      TEXT,
    status          TEXT NOT NULL DEFAULT 'em_transito', -- em_transito | entregue
    criado_em       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pedidos (
    id            TEXT PRIMARY KEY,
    loja          TEXT NOT NULL,
    numero_pedido TEXT,
    data_compra   TEXT,
    valor         REAL,
    moeda         TEXT DEFAULT 'USD',
    status        TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | entregue
    origem        TEXT NOT NULL DEFAULT 'manual',   -- manual | email
    email_id      TEXT,
    lote_id       TEXT,
    aviso_atraso_em TEXT,                            -- quando o e-mail de atraso foi enviado
    criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lote_id) REFERENCES lotes(id)
  );

  CREATE TABLE IF NOT EXISTS itens (
    id               TEXT PRIMARY KEY,
    pedido_id        TEXT NOT NULL,
    nome             TEXT NOT NULL,
    tamanho          TEXT,
    qtd              INTEGER NOT NULL DEFAULT 1,
    foto_url         TEXT,
    foto_recebida_em TEXT,
    FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
  );
`);

console.log('✓ Schema criado / verificado');
