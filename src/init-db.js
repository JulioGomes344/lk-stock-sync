import db from './db.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
// SCHEMA — 3 tabelas que sustentam todo o conceito
// pedidos → itens → lotes
// Na migração para Postgres (Fase 2), só trocar a sintaxe de
// AUTOINCREMENT/TEXT; a lógica das queries permanece igual.
// ─────────────────────────────────────────────────────────────

export function initDb() {
  // Garante que a pasta de uploads exista (importante no Volume do Railway,
  // que cria /data mas não a subpasta /data/uploads).
  const uploadDir = process.env.UPLOAD_DIR || join(__dirname, '..', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS lojas (
      nome      TEXT PRIMARY KEY,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lotes (
      id              TEXT PRIMARY KEY,
      descricao       TEXT,
      transportadora  TEXT,
      codigo_rastreio TEXT,
      data_envio      TEXT,
      status          TEXT NOT NULL DEFAULT 'em_transito', -- em_transito | entregue
      excluido_em     TEXT,                                 -- lixeira de lotes
      criado_em       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,                   -- número sequencial automático (#1, #2, ...)
      loja          TEXT NOT NULL,
      numero_pedido TEXT,
      pedido_loja   TEXT,                              -- nº do pedido NA LOJA (ex: #1420648, 03-EBHH99EL1N)
      data_compra   TEXT,
      valor         REAL,
      moeda         TEXT DEFAULT 'USD',
      status        TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | entregue
      origem        TEXT NOT NULL DEFAULT 'manual',   -- manual | email
      email_id      TEXT,
      lote_id       TEXT,
      aviso_atraso_em TEXT,                            -- quando o e-mail de atraso foi enviado
      compra_confirmada_em TEXT,                       -- quando o e-mail de confirmação de compra foi enviado
      prioridade_enviada_em TEXT,                      -- quando o e-mail de prioridade foi enviado
      excluido_em   TEXT,                              -- lixeira: quando foi movido (NULL = ativo)
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

  migrar();
  console.log('✓ Schema criado / verificado');
}

// ─────────────────────────────────────────────────────────────
// MIGRAÇÃO AUTOMÁTICA
// CREATE TABLE IF NOT EXISTS não adiciona colunas novas a tabelas
// que já existem. Esta função compara as colunas esperadas com as
// reais (via PRAGMA table_info) e faz ALTER TABLE só do que falta.
// Roda toda vez, é idempotente e nunca apaga dados.
// Para mudanças futuras de schema, basta adicionar a linha aqui.
// ─────────────────────────────────────────────────────────────
function migrar() {
  // colunas esperadas por tabela → definição SQL para o ALTER
  const esperado = {
    pedidos: {
      seq: 'INTEGER',
      pedido_loja: 'TEXT',
      aviso_atraso_em: 'TEXT',
      excluido_em: 'TEXT',
      compra_confirmada_em: 'TEXT',
      prioridade_enviada_em: 'TEXT'
    },
    itens: {
      foto_recebida_em: 'TEXT'
    },
    lotes: {
      codigo_rastreio: 'TEXT',
      excluido_em: 'TEXT'
    }
  };

  for (const [tabela, colunas] of Object.entries(esperado)) {
    const existentes = db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name);
    for (const [coluna, tipo] of Object.entries(colunas)) {
      if (!existentes.includes(coluna)) {
        db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
        console.log(`  ↳ migração: coluna ${tabela}.${coluna} adicionada`);
      }
    }
  }

  // Preenche seq para pedidos antigos que não tinham número sequencial,
  // respeitando a ordem de criação. Roda uma única vez (só onde seq é nulo).
  const semSeq = db.prepare(`SELECT id FROM pedidos WHERE seq IS NULL ORDER BY criado_em`).all();
  if (semSeq.length) {
    const { max } = db.prepare(`SELECT MAX(seq) AS max FROM pedidos WHERE seq IS NOT NULL`).get();
    let n = (max || 0);
    const upd = db.prepare(`UPDATE pedidos SET seq = ?, numero_pedido = ? WHERE id = ?`);
    const tx = db.transaction(() => {
      for (const p of semSeq) {
        n += 1;
        upd.run(n, String(n).padStart(4, '0'), p.id);
      }
    });
    tx();
    console.log(`  ↳ migração: ${semSeq.length} pedido(s) antigo(s) numerado(s) sequencialmente`);
  }
}

// Permite rodar direto: `node src/init-db.js` ou `npm run init-db`
if (import.meta.url === `file://${process.argv[1]}`) {
  initDb();
}
