import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { nanoid } from 'nanoid';
import * as store from './store.js';
import { enviarAlertaAtraso, enviarAvisoPedido, enviarConfirmacaoCompra, destinatariosPadrao } from './email.js';
import { initDb } from './init-db.js';
import { sincronizarGmail, gmailConfigurado } from './gmail.js';
import { exigirLogin, criarSessao, encerrarSessao, senhaCorreta, senhaConfigurada } from './auth.js';
import { parseOperatorMessage, normalizeText } from './operatorParser.js';
import { sendWhatsappGroupMessage } from './whatsappProvider.js';

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
// ── AUTENTICAÇÃO: tudo abaixo exige login ──
app.get('/login', (req, res) => res.render('login', { configurada: senhaConfigurada(), erro: null }));
app.post('/login', (req, res) => {
  if (senhaCorreta(req.body.senha)) {
    criarSessao(res);
    return res.redirect('/');
  }
  res.status(401).render('login', { configurada: senhaConfigurada(), erro: 'Senha incorreta.' });
});
app.get('/logout', (req, res) => { encerrarSessao(res); res.redirect('/login'); });
// Fotos ficam fora do login: nomes são códigos aleatórios não-adivinháveis,
// e o e-mail de atraso precisa carregar as imagens sem sessão.
app.use('/uploads', express.static(UPLOAD_DIR));

// ── WEBHOOK OPERADOR WHATSAPP (antes do login; protegido por token + grupo + allowlist) ──
function tokenWebhookValido(req) {
  const tokens = [
    process.env.OPERATOR_WEBHOOK_TOKEN,
    process.env.LK_STOCK_HERMES_ROUTE_SECRET
  ].filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some(token =>
    req.headers.authorization === `Bearer ${token}`
    || req.headers.apikey === token
    || req.query.token === token
  );
}

function normalizarPayloadEvolution(payload) {
  const data = payload?.data || payload;
  const key = data?.key || {};
  const message = data?.message || {};
  const text = message?.conversation
    || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption
    || '';

  return {
    channel: 'whatsapp',
    groupId: key.remoteJid,
    sender: {
      id: String(key.participant || data?.participant || '').replace('@s.whatsapp.net', ''),
      name: data?.pushName || data?.senderName || 'Operador'
    },
    message: {
      id: key.id || data?.id || null,
      text,
      timestamp: new Date().toISOString()
    }
  };
}

async function processarMensagemOperador(payload) {
  const { channel, groupId, sender, message } = payload;
  const text = message?.text || '';

  if (process.env.WHATSAPP_GROUP_ID && groupId !== process.env.WHATSAPP_GROUP_ID) {
    return { status: 'ignored', reply: null };
  }
  if (!text.trim()) return { status: 'ignored', reply: null };

  const operatorMessageId = store.registrarMensagemOperador({
    channel,
    groupId,
    senderIdentifier: sender?.id || null,
    senderName: sender?.name || null,
    rawMessage: text,
    normalizedMessage: normalizeText(text)
  });

  const operator = store.buscarOperadorAutorizado(channel, sender?.id);
  if (!operator) {
    store.atualizarMensagemOperador(operatorMessageId, { status: 'unauthorized' });
    return { status: 'unauthorized', reply: 'Número não autorizado para atualizar pedidos.' };
  }

  const parsed = parseOperatorMessage(text);
  store.atualizarMensagemOperador(operatorMessageId, { parserResult: parsed });

  if (parsed.intent === 'unknown') {
    store.atualizarMensagemOperador(operatorMessageId, { status: 'unknown' });
    return { status: 'unknown', reply: 'Não entendi. Use: recebido 1050 ou enviado 1050 lote CX12 tracking LB123BR' };
  }

  const result = store.aplicarAcaoOperador(parsed, operator, operatorMessageId, text);
  store.atualizarMensagemOperador(operatorMessageId, { status: result.status });
  return result;
}

app.post('/api/operator-message', async (req, res) => {
  if (!tokenWebhookValido(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = await processarMensagemOperador(req.body);
    if (result.reply) await sendWhatsappGroupMessage(result.reply);
    res.json(result);
  } catch (e) {
    console.error('operator-message error:', e);
    res.status(500).json({ error: 'operator_message_error' });
  }
});

app.post('/webhooks/evolution', async (req, res) => {
  if (!tokenWebhookValido(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = normalizarPayloadEvolution(req.body);
    const result = await processarMensagemOperador(payload);
    if (result.reply) await sendWhatsappGroupMessage(result.reply);
    res.json(result);
  } catch (e) {
    console.error('evolution webhook error:', e);
    res.status(500).json({ error: 'evolution_webhook_error' });
  }
});

app.use(exigirLogin);

// ── DASHBOARD (3 abas) ──
app.get('/', (req, res) => {
  const aba = ['pendente', 'recebido', 'enviado', 'entregue', 'prioridade', 'cancelados', 'lotes', 'lixeira', 'whatsapp'].includes(req.query.aba) ? req.query.aba : 'pendente';
  const filtroRedirecionar = String(req.query.redirecionar_para || '').trim();
  const filtroTipoOrigem = ['estoque', 'encomenda', 'sem_tipo'].includes(String(req.query.tipo_origem || '')) ? String(req.query.tipo_origem) : '';
  const manualProduto = String(req.query.manualProduto || '').trim();
  const pedidosBase = aba === 'lixeira' ? store.listarLixeira()
           : aba === 'whatsapp' ? []
           : aba === 'prioridade' ? store.listarPrioridade()
           : aba === 'cancelados' ? store.listarCancelados()
           : store.listarPorStatus(aba);
  const redirecionarOptions = [...new Set(pedidosBase.map(p => String(p.redirecionar_para || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const pedidosFiltrados = pedidosBase.filter(p => {
    if (filtroRedirecionar && String(p.redirecionar_para || '').trim() !== filtroRedirecionar) return false;
    if (filtroTipoOrigem === 'estoque' || filtroTipoOrigem === 'encomenda') return p.tipo_origem === filtroTipoOrigem;
    if (filtroTipoOrigem === 'sem_tipo') return !p.tipo_origem;
    return true;
  });
  res.render('dashboard', {
    aba,
    resumo: store.resumo(),
    resumoSemaforo: store.resumoSemaforo(),
    pedidos: pedidosFiltrados,
    totalPedidosSemFiltro: pedidosBase.length,
    filtrosCompras: { redirecionar_para: filtroRedirecionar, tipo_origem: filtroTipoOrigem, manualProduto },
    redirecionarOptions,
    lotes: store.listarLotesComPedidos(),
    lotesLixeira: aba === 'lixeira' ? store.listarLotesLixeira() : [],
    lotesAtivos: store.listarLotesAtivos(),
    historicoWhatsapp: aba === 'whatsapp' ? store.listarHistoricoWhatsapp(150) : [],
    filaErrosWhatsapp: aba === 'whatsapp' ? store.listarFilaErrosWhatsapp(50) : [],
    LOJAS: store.listarLojas(),
    destinatariosPadrao: destinatariosPadrao()
  });
});

// ── CRIAR PEDIDO (manual) ──
// upload.any() aceita os campos de foto indexados (item_foto_0, item_foto_1...)
// junto com os campos de texto do formulário
app.post('/pedidos', upload.any(), (req, res) => {
  const { loja, loja_nova, data_compra, valor, moeda, pedido_loja } = req.body;
  // Se o usuário escolheu "Outra" e digitou um nome, usa esse nome
  const lojaFinal = (loja === '__nova__' && loja_nova?.trim()) ? loja_nova.trim() : loja;
  const pid = store.criarPedido({ loja: lojaFinal, data_compra, valor: valor ? parseFloat(valor) : null, moeda, pedido_loja: pedido_loja?.trim() || null });

  // itens vêm como arrays paralelos do form; fotos casam pelo índice no fieldname
  const nomes = [].concat(req.body.item_nome || []);
  const skus = [].concat(req.body.item_sku || []);
  const tams = [].concat(req.body.item_tamanho || []);
  const qtds = [].concat(req.body.item_qtd || []);
  nomes.forEach((nome, i) => {
    if (!nome?.trim()) return;
    const itemId = store.adicionarItem(pid, { nome, sku: skus[i]?.trim() || null, tamanho: tams[i], qtd: parseInt(qtds[i]) || 1 });
    const foto = (req.files || []).find(f => f.fieldname === `item_foto_${i}`);
    if (foto) store.anexarFoto(itemId, '/uploads/' + foto.filename);
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

// ── MOVER PEDIDO PARA RECEBIDO ──
app.post('/pedidos/:id/receber', (req, res) => {
  try {
    store.marcarRecebido(req.params.id);
    res.redirect('/?aba=recebido');
  } catch (e) {
    const msgs = {
      PEDIDO_CANCELADO: 'Pedido cancelado não pode ser marcado como recebido.',
      PEDIDO_ENTREGUE: 'Pedido entregue não pode voltar para recebido.'
    };
    res.status(400).render('erro', { msg: msgs[e.message] || e.message });
  }
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

// ── ENTREGAR PEDIDO INDIVIDUAL ──
app.post('/pedidos/:id/entregar', (req, res) => {
  store.marcarEntregue(req.params.id);
  res.redirect('/?aba=entregue');
});

// ── ENTREGAR LOTE INTEIRO ──
app.post('/lotes/:id/entregar', (req, res) => {
  store.entregarLote(req.params.id);
  res.redirect('/?aba=entregue');
});

// ── SINCRONIZAÇÃO MANUAL DO GMAIL ──
app.get('/sync-gmail', async (req, res) => {
  const r = await sincronizarGmail();
  res.render('erro', {
    msg: r.ok
      ? `Sincronização concluída: ${r.criados} pedido(s) novo(s), ${r.atualizados || 0} pedido(s) corrigido(s), ${r.ignorados} ignorado(s) (já processados ou não-confirmação), ${r.processados} e-mail(s) lidos em ${r.contas || 1} caixa(s).`
      : `Sincronização indisponível: ${r.motivo}`
  });
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

// ── TIPO DE ORIGEM: seleção direta (estoque / encomenda; clicar no ativo limpa) ──
app.post('/pedidos/:id/tipo-origem', (req, res) => {
  store.definirTipoOrigem(req.params.id, req.body.tipo);
  res.redirect(req.get('Referrer') || '/');
});

// ── REDIRECIONAMENTO DA COMPRA (texto livre, salvo no pedido) ──
app.post('/pedidos/:id/redirecionar', (req, res) => {
  store.salvarRedirecionamento(req.params.id, req.body.redirecionar_para);
  res.redirect(req.get('Referrer') || '/');
});

// ── CANCELAMENTO E RECOMPRA ──
app.post('/pedidos/:id/cancelar', (req, res) => {
  store.marcarCancelado(req.params.id);
  res.redirect('/?aba=cancelados');
});

app.post('/pedidos/:id/recompra', (req, res) => {
  store.confirmarRecompra(req.params.id);
  res.redirect('/?aba=pendente');
});

// ── CONFIRMAÇÃO DE COMPRA (botão, destinatário escolhível) ──
app.post('/pedidos/:id/confirmar-compra', async (req, res) => {
  const pedido = store.getPedidoEnriquecido(req.params.id);
  if (!pedido) return res.status(404).render('erro', { msg: 'Pedido não encontrado.' });

  // destinatário(s): campo do form, separado por vírgula; vazio usa o padrão
  const destinatarios = (req.body.destinatario || '')
    .split(',').map(e => e.trim()).filter(Boolean);

  const r = await enviarConfirmacaoCompra(pedido, destinatarios);
  if (r.enviado || r.dryRun) store.marcarCompraConfirmada(pedido.id);

  res.render('erro', {
    msg: r.enviado
      ? `E-mail de confirmação de compra do pedido #${pedido.numero_pedido} enviado${destinatarios.length ? ' para ' + destinatarios.join(', ') : ''}.`
      : r.dryRun
        ? `Confirmação de compra processada em modo teste (veja o console).`
        : `Falha ao enviar a confirmação de compra (${r.erro}).`
  });
});

// ── LIXEIRA DE LOTES ──
app.post('/lotes/:id/excluir', (req, res) => {
  store.moverLoteParaLixeira(req.params.id);
  res.redirect('/?aba=lixeira');
});

app.post('/lotes/:id/restaurar', (req, res) => {
  store.restaurarLoteDaLixeira(req.params.id);
  res.redirect('/?aba=lotes');
});

app.post('/lotes/:id/excluir-definitivo', (req, res) => {
  const senhaDef = process.env.DELETE_PASSWORD;
  if (!senhaDef) {
    return res.status(400).render('erro', { msg: 'A exclusão definitiva está bloqueada: configure a variável DELETE_PASSWORD no Railway para habilitá-la.' });
  }
  if (req.body.senha !== senhaDef) {
    return res.status(403).render('erro', { msg: 'Senha incorreta. O lote permanece na lixeira.' });
  }
  store.excluirLoteDefinitivo(req.params.id);
  res.redirect('/?aba=lixeira');
});

// ── AVISO INDIVIDUAL POR PEDIDO: atraso ou prioridade de envio ──
app.post('/pedidos/:id/avisar', async (req, res) => {
  const pedido = store.getPedidoEnriquecido(req.params.id);
  if (!pedido) return res.status(404).render('erro', { msg: 'Pedido não encontrado.' });

  const tipo = req.body.tipo === 'prioridade' ? 'prioridade' : 'atraso';
  const r = await enviarAvisoPedido(pedido, tipo);

  // registra a notificação enviada
  if (r.enviado || r.dryRun) {
    if (tipo === 'atraso') store.marcarAvisoEnviado(pedido.id);       // cron não repete
    if (tipo === 'prioridade') store.marcarPrioridadeEnviada(pedido.id);
  }

  const nomeTipo = tipo === 'prioridade' ? 'priorização de envio' : 'aviso de atraso';
  res.render('erro', {
    msg: r.enviado
      ? `E-mail de ${nomeTipo} do pedido #${pedido.numero_pedido} enviado com sucesso.`
      : r.dryRun
        ? `E-mail de ${nomeTipo} processado em modo teste (veja o console).`
        : `Falha ao enviar o e-mail de ${nomeTipo} (${r.erro}). Tente novamente.`
  });
});

// ── LIXEIRA ──
// Senha para exclusão definitiva: variável DELETE_PASSWORD no Railway.
// Sem ela configurada, a exclusão definitiva fica bloqueada por segurança.

app.post('/pedidos/:id/excluir', (req, res) => {
  store.moverParaLixeira(req.params.id);
  res.redirect('/?aba=lixeira');
});

app.post('/pedidos/:id/restaurar', (req, res) => {
  store.restaurarDaLixeira(req.params.id);
  res.redirect('/?aba=lixeira');
});

app.post('/pedidos/:id/excluir-definitivo', (req, res) => {
  const senhaConfigurada = process.env.DELETE_PASSWORD;
  if (!senhaConfigurada) {
    return res.status(400).render('erro', {
      msg: 'A exclusão definitiva está bloqueada: configure a variável DELETE_PASSWORD no Railway para habilitá-la.'
    });
  }
  if (req.body.senha !== senhaConfigurada) {
    return res.status(403).render('erro', { msg: 'Senha incorreta. O pedido permanece na lixeira.' });
  }
  const fotos = store.excluirDefinitivo(req.params.id);
  // apaga também os arquivos de foto locais do pedido
  for (const f of fotos) {
    const caminho = join(UPLOAD_DIR, f.replace('/uploads/', ''));
    fs.unlink(caminho, () => {}); // ignora se já não existir
  }
  res.redirect('/?aba=lixeira');
});

// ── BACKUP: baixa o arquivo do banco (protegido pelo login) ──
app.get('/backup', (req, res) => {
  const arquivo = store.caminhoBanco();
  const nome = `lk-compras-backup-${new Date().toISOString().slice(0,10)}.db`;
  res.download(arquivo, nome, (err) => {
    if (err && !res.headersSent) res.status(500).render('erro', { msg: 'Não foi possível gerar o backup: ' + err.message });
  });
});

// ── ZERAR: apaga todos os pedidos/itens/lotes (recomeço) ──
// Exige a senha DELETE_PASSWORD. Irreversível.
app.post('/zerar', (req, res) => {
  const senhaDef = process.env.DELETE_PASSWORD;
  if (!senhaDef) {
    return res.status(400).render('erro', { msg: 'Recomeço bloqueado: configure a variável DELETE_PASSWORD no Railway para habilitá-lo.' });
  }
  if (req.body.senha !== senhaDef) {
    return res.status(403).render('erro', { msg: 'Senha incorreta. Nada foi apagado.' });
  }
  store.zerarTudo();
  res.render('erro', { msg: 'Histórico zerado com sucesso. O painel está limpo e pronto para recomeçar a partir de agora.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ LK Compras rodando em http://localhost:${PORT}`));

// ── CRON INTERNO: verificação automática de atrasos ──
// Roda no boot e depois a cada 1 hora. Seguro contra spam: cada pedido só é
// avisado uma vez (aviso_atraso_em), então as checagens repetidas não reenviam.
// Sem necessidade de serviço cron separado nem Volume compartilhado no Railway.
const UMA_HORA = 60 * 60 * 1000;

async function verificarAtrasosAutomatico() {
  try {
    const atrasados = store.pedidosAtrasadosNaoAvisados();
    if (!atrasados.length) return;
    const r = await enviarAlertaAtraso(atrasados);
    if (r.enviado || r.dryRun) {
      atrasados.forEach(p => store.marcarAvisoEnviado(p.id));
      console.log(`✓ [cron] ${atrasados.length} pedido(s) atrasado(s) avisado(s) por e-mail.`);
    } else {
      console.error(`✗ [cron] envio falhou (${r.erro}) — tentará de novo na próxima hora.`);
    }
  } catch (e) {
    console.error('✗ [cron] erro na verificação de atrasos:', e.message);
  }
}

setTimeout(verificarAtrasosAutomatico, 30 * 1000); // 30s após o boot
setInterval(verificarAtrasosAutomatico, UMA_HORA);  // depois, a cada hora

// ── CRON INTERNO: sincronização do Gmail a cada 30 min ──
const MEIA_HORA = 30 * 60 * 1000;
async function sincronizarGmailAutomatico() {
  if (!gmailConfigurado()) return; // sem credenciais, fica em silêncio
  const r = await sincronizarGmail();
  if (r.ok && r.criados > 0) console.log(`✓ [cron-gmail] ${r.criados} pedido(s) novo(s) importado(s).`);
}
setTimeout(sincronizarGmailAutomatico, 60 * 1000);  // 1min após o boot
setInterval(sincronizarGmailAutomatico, MEIA_HORA);
