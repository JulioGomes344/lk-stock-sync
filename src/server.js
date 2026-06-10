import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { nanoid } from 'nanoid';
import * as store from './store.js';
import { enviarAlertaAtraso } from './email.js';
import { initDb } from './init-db.js';

// Cria as tabelas e a pasta de uploads no boot (idempotente).
// Assim o app nunca sobe sem schema — não depende do start command.
initDb();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Upload de fotos (as que o vendedor envia). No Railway, aponte para o Volume.
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', 'uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_, file, cb) => cb(null, nanoid(12) + extname(file.originalname))
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

app.set('view engine', 'ejs');
app.set('views', join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ── DASHBOARD (3 abas) ──
app.get('/', (req, res) => {
  const aba = ['pendente', 'enviado', 'entregue'].includes(req.query.aba) ? req.query.aba : 'pendente';
  res.render('dashboard', {
    aba,
    resumo: store.resumo(),
    resumoSemaforo: store.resumoSemaforo(),
    pedidos: store.listarPorStatus(aba),
    lotes: store.listarLotesComPedidos(),
    lotesAtivos: store.listarLotesAtivos(),
    LOJAS: store.listarLojas()
  });
});

// ── CRIAR PEDIDO (manual) ──
app.post('/pedidos', (req, res) => {
  const { loja, loja_nova, data_compra, valor, moeda } = req.body;
  // Se o usuário escolheu "Outra" e digitou um nome, usa esse nome
  const lojaFinal = (loja === '__nova__' && loja_nova?.trim()) ? loja_nova.trim() : loja;
  const pid = store.criarPedido({ loja: lojaFinal, data_compra, valor: valor ? parseFloat(valor) : null, moeda });

  // itens vêm como arrays paralelos do form
  const nomes = [].concat(req.body.item_nome || []);
  const tams = [].concat(req.body.item_tamanho || []);
  const qtds = [].concat(req.body.item_qtd || []);
  nomes.forEach((nome, i) => {
    if (nome?.trim()) store.adicionarItem(pid, { nome, tamanho: tams[i], qtd: parseInt(qtds[i]) || 1 });
  });
  res.redirect('/?aba=pendente');
});

// ── ANEXAR FOTO a um item ──
app.post('/itens/:id/foto', upload.single('foto'), (req, res) => {
  if (req.file) store.anexarFoto(req.params.id, '/uploads/' + req.file.filename);
  res.redirect(req.get('Referrer') || '/');
});

// ── CRIAR LOTE ──
app.post('/lotes', (req, res) => {
  const { descricao, transportadora, codigo_rastreio, data_envio } = req.body;
  store.criarLote({ descricao, transportadora, codigo_rastreio, data_envio });
  res.redirect('/?aba=pendente');
});

// ── MOVER PEDIDO PARA ENVIADO (valida foto + lote) ──
app.post('/pedidos/:id/enviar', (req, res) => {
  try {
    store.moverParaEnviado(req.params.id, req.body.lote_id);
    res.redirect('/?aba=enviado');
  } catch (e) {
    const msgs = {
      FOTO_OBRIGATORIA: 'Anexe ao menos uma foto antes de marcar como enviado.',
      LOTE_OBRIGATORIO: 'Selecione ou crie um lote para este envio.'
    };
    res.status(400).render('erro', { msg: msgs[e.message] || e.message });
  }
});

// ── ENTREGAR LOTE INTEIRO ──
app.post('/lotes/:id/entregar', (req, res) => {
  store.entregarLote(req.params.id);
  res.redirect('/?aba=entregue');
});

// ── CHECAGEM MANUAL DE ATRASOS (dispara e-mail) ──
app.get('/check-atrasos', async (req, res) => {
  const atrasados = store.pedidosAtrasadosNaoAvisados();
  const r = await enviarAlertaAtraso(atrasados);
  // Só marca como avisado se realmente enviou (ou em modo teste)
  if (r.enviado || r.dryRun) atrasados.forEach(p => store.marcarAvisoEnviado(p.id));

  let msg;
  if (!atrasados.length) {
    msg = 'Nenhum pedido atrasado pendente de aviso.';
  } else if (r.enviado) {
    msg = `${atrasados.length} pedido(s) atrasado(s) — e-mail enviado com sucesso.`;
  } else if (r.dryRun) {
    msg = `${atrasados.length} pedido(s) atrasado(s) processado(s). (modo teste — veja o console)`;
  } else {
    msg = `Encontrei ${atrasados.length} pedido(s) atrasado(s), mas o envio do e-mail falhou (${r.erro}). Os pedidos NÃO foram marcados como avisados — tente de novo após ajustar o SMTP.`;
  }
  res.render('erro', { msg });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ LK Compras rodando em http://localhost:${PORT}`));
