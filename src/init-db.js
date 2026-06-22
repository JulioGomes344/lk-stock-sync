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
      status        TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | entregue | cancelado
      cancelado_em  TEXT,                            -- quando foi marcado como cancelado
      redirecionar_para TEXT,                          -- texto livre: quem recebe/redireciona a compra
      tipo_origem   TEXT,                              -- 'estoque' | 'encomenda' | NULL (não definido)
      origem        TEXT NOT NULL DEFAULT 'manual',   -- manual | email
      email_id      TEXT,
      lote_id       TEXT,
      tracking_code TEXT,                              -- rastreio informado pelo operador/WhatsApp
      observacoes   TEXT,                              -- observações operacionais do operador/WhatsApp
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

    CREATE TABLE IF NOT EXISTS authorized_operators (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      channel    TEXT NOT NULL DEFAULT 'whatsapp',
      identifier TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'shipper',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      UNIQUE(channel, identifier)
    );

    CREATE TABLE IF NOT EXISTS operator_messages (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      channel            TEXT NOT NULL,
      group_id           TEXT,
      sender_identifier  TEXT,
      sender_name        TEXT,
      raw_message        TEXT NOT NULL,
      normalized_message TEXT,
      status             TEXT NOT NULL DEFAULT 'received',
      parser_result_json TEXT,
      error_message      TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id            TEXT,
      event_type          TEXT NOT NULL,
      old_status          TEXT,
      new_status          TEXT,
      old_value           TEXT,
      new_value           TEXT,
      source              TEXT NOT NULL DEFAULT 'whatsapp_group',
      operator_message_id INTEGER,
      sender_identifier   TEXT,
      sender_name         TEXT,
      raw_message         TEXT,
      confidence          TEXT DEFAULT 'high',
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES pedidos(id),
      FOREIGN KEY (operator_message_id) REFERENCES operator_messages(id)
    );

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      confirmation_code   TEXT NOT NULL,
      channel             TEXT NOT NULL,
      group_id            TEXT,
      sender_identifier   TEXT,
      original_message_id INTEGER,
      action_json         TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      expires_at          TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at        TEXT,
      FOREIGN KEY (original_message_id) REFERENCES operator_messages(id)
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
      prioridade_enviada_em: 'TEXT',
      cancelado_em: 'TEXT',
      redirecionar_para: 'TEXT',
      tipo_origem: 'TEXT',
      tracking_code: 'TEXT',
      observacoes: 'TEXT'
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
  // Cadastra operadores WhatsApp por variável de ambiente, sem precisar acessar o SQLite manualmente.
  // Formato: AUTHORIZED_OPERATORS="João:5511999999999,Maria:5521999999999"
  const operadoresEnv = (process.env.AUTHORIZED_OPERATORS || '').trim();

  if (operadoresEnv) {
    const upsertOperador = db.prepare(`
      INSERT INTO authorized_operators (name, channel, identifier, role, active, updated_at)
      VALUES (?, 'whatsapp', ?, 'shipper', 1, datetime('now'))
      ON CONFLICT(channel, identifier) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        active = 1,
        updated_at = datetime('now')
    `);

    for (const item of operadoresEnv.split(',')) {
      const [nome, numero] = item.split(':').map(x => (x || '').trim());
      const limpo = (numero || '').replace(/\D/g, '');

      if (nome && limpo) {
        upsertOperador.run(nome, limpo);
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
