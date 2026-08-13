// ─── Sincronização Gmail → Pendentes ───
// Conecta via IMAP (App Password do Google), busca e-mails de confirmação
// das lojas conhecidas e cria pedidos Pendentes automaticamente, com itens
// e fotos dos produtos.
//
// Variáveis de ambiente:
//   GMAIL_USER         → seu e-mail do Gmail principal
//   GMAIL_APP_PASSWORD → senha de app do Gmail principal
//   GMAIL_USER_2 / GMAIL_APP_PASSWORD_2 → segunda caixa opcional
//   GMAIL_ACCOUNTS_JSON → opcional, lista JSON [{"user":"...","pass":"..."}]
//   GMAIL_DIAS         → janela de busca em dias (default 30)
// Sem credenciais → sincronização desativada (loga aviso e segue).
//
// Deduplicação dupla: por Message-ID do e-mail e por (loja + nº do pedido na
// loja). Rodar várias vezes nunca duplica pedido.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as store from './store.js';
import { identificarLoja, parsearEmail, parsearCancelamento, parsearEntrega, ehConfirmacao, extrairNumeroPedidoGenerico, DOMINIOS, urlFotoStockX, parseEnvioStockX } from './parsers.js';

const DIAS = parseInt(process.env.GMAIL_DIAS || '30');
// Data de corte fixa (opcional): GMAIL_DESDE=2026-06-11 ignora qualquer e-mail
// anterior a essa data, independentemente da janela de dias. Tem prioridade.
const DESDE_FIXA = process.env.GMAIL_DESDE ? new Date(process.env.GMAIL_DESDE + 'T00:00:00Z') : null;

function contasGmailConfiguradas() {
  const contas = [];

  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    contas.push({ user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD, label: process.env.GMAIL_LABEL || process.env.GMAIL_USER });
  }
  if (process.env.GMAIL_USER_2 && process.env.GMAIL_APP_PASSWORD_2) {
    contas.push({ user: process.env.GMAIL_USER_2, pass: process.env.GMAIL_APP_PASSWORD_2, label: process.env.GMAIL_LABEL_2 || process.env.GMAIL_USER_2 });
  }

  if (process.env.GMAIL_ACCOUNTS_JSON) {
    try {
      const extras = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON);
      if (Array.isArray(extras)) {
        for (const c of extras) {
          const user = c.user || c.email;
          const pass = c.pass || c.password || c.appPassword;
          if (user && pass && !contas.some(x => x.user === user)) {
            contas.push({ user, pass, label: c.label || user });
          }
        }
      }
    } catch (e) {
      console.error('✗ [gmail] GMAIL_ACCOUNTS_JSON inválido:', e.message);
    }
  }

  return contas;
}

export const gmailConfigurado = () => contasGmailConfiguradas().length > 0;

// Verifica se uma URL de imagem existe (HEAD com timeout curto).
async function urlExiste(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

async function sincronizarContaGmail(conta) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: conta.user, pass: conta.pass },
    logger: false
  });

  const resultado = { ok: true, conta: conta.label, processados: 0, criados: 0, ignorados: 0, erros: [] };
  // corte: a data fixa (GMAIL_DESDE) tem prioridade sobre a janela de dias
  const desde = DESDE_FIXA || new Date(Date.now() - DIAS * 86400000);

  try {
    await client.connect();

    // Busca em "Todos os e-mails" (cobre arquivados/etiquetados), não só na INBOX.
    // O nome da pasta varia com o idioma da conta ("All Mail", "Todos os e-mails"),
    // então localizamos pelo atributo especial \All do Gmail. Fallback: INBOX.
    let caixa = 'INBOX';
    try {
      const pastas = await client.list();
      const allMail = pastas.find(p => p.specialUse === '\\All');
      if (allMail) caixa = allMail.path;
    } catch { /* mantém INBOX */ }
    console.log(`[gmail:${conta.label}] buscando na pasta: ${caixa}`);

    const lock = await client.getMailboxLock(caixa);
    try {
      // busca por remetente, um de cada vez (OR composto no IMAP é frágil)
      for (const remetente of Object.keys(DOMINIOS)) {
        const uids = await client.search({ from: remetente, since: desde });
        if (!uids || !uids.length) continue;

        for await (const msg of client.fetch(uids, { source: true })) {
          resultado.processados++;
          try {
            const mail = await simpleParser(msg.source);
            const messageId = mail.messageId || `uid-${msg.uid}@${remetente}`;

            // reforço do corte por data: ignora e-mails anteriores à data definida
            if (DESDE_FIXA && mail.date && mail.date < DESDE_FIXA) { resultado.ignorados++; continue; }

            // dedup 1: e-mail já processado. Ainda parseamos abaixo para poder
            // corrigir capturas antigas em fallback (sem OC/itens), sem criar duplicata.
            const emailProcessado = store.emailJaProcessado(messageId);

            const loja = identificarLoja(mail.from?.value?.[0]?.address);
            if (!loja) { resultado.ignorados++; continue; }

            // ── CANCELAMENTO: move um pedido existente para a aba Cancelados ──
            const canc = parsearCancelamento(loja, { subject: mail.subject, html: mail.html, from: mail.from?.value?.[0]?.address });
            if (canc) {
              let n = 0;
              if (canc.pedido_loja) n = store.marcarCanceladoPorPedidoLoja(loja, canc.pedido_loja);
              if (n === 0 && canc.nome) n = store.marcarCanceladoPorNome(loja, canc.nome);
              if (n > 0) {
                resultado.cancelados = (resultado.cancelados || 0) + n;
                console.log(`✓ [gmail:${conta.label}] cancelamento ${loja} ${canc.pedido_loja ? '#'+canc.pedido_loja : '"'+canc.nome+'"'} → movido para Cancelados`);
              }
              resultado.ignorados++;
              continue;
            }

            // ── ENTREGA: move Pendente → Recebido ──
            // O e-mail de entrega da loja é a fonte de verdade do recebimento
            // no endereço do freight forwarder. Nunca cria pedido.
            const entrega = parsearEntrega(loja, { subject: mail.subject, html: mail.html, text: mail.text });
            if (entrega) {
              // aproveita a foto real do produto, que costuma vir nesses e-mails
              if (entrega.foto_url && entrega.pedido_loja) {
                store.anexarFotoPorPedidoLoja(loja, entrega.pedido_loja, entrega.foto_url);
              }
              const r = store.marcarRecebidoPorEmail(loja, entrega);
              const ref = entrega.pedido_loja ? '#' + entrega.pedido_loja : `"${entrega.nome}"`;
              if (r.atualizado) {
                resultado.recebidos = (resultado.recebidos || 0) + 1;
                console.log(`✓ [gmail:${conta.label}] entrega ${loja} ${ref} → pedido #${r.pedido.numero_pedido} movido para Recebido`);
              } else if (r.motivo === 'pedido_nao_encontrado') {
                resultado.entregasSemPedido = (resultado.entregasSemPedido || 0) + 1;
                console.log(`⚠ [gmail:${conta.label}] entrega ${loja} ${ref} sem pedido correspondente — conferir manualmente`);
              } else {
                console.log(`· [gmail:${conta.label}] entrega ${loja} ${ref} ignorada (pedido ${r.motivo?.replace('ja_', 'já ')})`);
              }
              resultado.ignorados++;
              continue;
            }

            // StockX Shipped: enriquece pedido existente com a foto real
            if (loja === 'StockX') {
              const envio = parseEnvioStockX({ subject: mail.subject, html: mail.html });
              if (envio) {
                const enriquecidos = store.anexarFotoPorPedidoLoja(loja, envio.pedido_loja, envio.foto_url);
                if (enriquecidos > 0) console.log(`✓ [gmail:${conta.label}] foto anexada ao pedido StockX #${envio.pedido_loja} via e-mail de envio`);
                resultado.ignorados++;
                continue;
              }
            }

            let dados = parsearEmail(loja, { subject: mail.subject, html: mail.html, text: mail.text });

            // ── FALLBACK DE GARANTIA ──
            // É da loja + parece confirmação + parser detalhado falhou?
            // Registra um pendente mínimo em vez de perder a compra.
            if (!dados && ehConfirmacao(loja, mail.subject)) {
              const numGenerico = extrairNumeroPedidoGenerico(mail.subject, mail.html);
              dados = {
                pedido_loja: numGenerico,
                itens: [{ nome: '⚠ Conferir e-mail — itens não extraídos automaticamente', tamanho: null, qtd: 1, foto_url: null }],
                valor: null,
                moeda: 'USD',
                _fallback: true
              };
              console.log(`⚠ [gmail:${conta.label}] fallback: confirmação ${loja} ${numGenerico ? '#'+numGenerico : '(sem nº)'} registrada sem detalhes — conferir manualmente`);
            }
            if (!dados) { resultado.ignorados++; continue; } // marketing, envio, etc.

            if (emailProcessado) {
              const atualizados = store.atualizarPedidoCapturadoPorEmail(messageId, { ...dados, email_account: conta.label });
              if (atualizados > 0) resultado.atualizados = (resultado.atualizados || 0) + atualizados;
              resultado.ignorados++;
              continue;
            }

            // StockX: tenta construir a URL da foto a partir do nome (validada antes de salvar)
            if (loja === 'StockX') {
              for (const item of dados.itens) {
                if (!item.foto_url) {
                  const candidata = urlFotoStockX(item.nome);
                  if (candidata && await urlExiste(candidata)) item.foto_url = candidata;
                }
              }
            }

            // dedup 2: ordem de compra já registrada. Evita duplicar quando a mesma compra
            // aparece em duas caixas Gmail. Mantém fallback por loja para compatibilidade.
            if (store.ordemCompraJaExiste(dados.pedido_loja) || store.pedidoLojaJaExiste(loja, dados.pedido_loja)) {
              resultado.ignorados++;
              continue;
            }

            const pid = store.criarPedido({
              loja,
              data_compra: mail.date ? mail.date.toISOString().slice(0, 10) : null,
              valor: dados.valor,
              moeda: dados.moeda,
              origem: 'email',
              email_id: messageId,
              pedido_loja: dados.pedido_loja,
              email_account: conta.label
            });
            for (const item of dados.itens) {
              const itemId = store.adicionarItem(pid, item);
              if (item.foto_url) store.anexarFoto(itemId, item.foto_url);
            }
            resultado.criados++;
            console.log(`✓ [gmail:${conta.label}] ${loja} #${dados.pedido_loja} → pendente criado (${dados.itens.length} item(ns))`);
          } catch (e) {
            resultado.erros.push(e.message);
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    resultado.ok = false;
    resultado.motivo = e.message;
    console.error(`✗ [gmail:${conta.label}] falha na sincronização:`, e.message);
    try { await client.logout(); } catch {}
  }
  return resultado;
}

export async function sincronizarGmail() {
  const contas = contasGmailConfiguradas();
  if (!contas.length) {
    return { ok: false, motivo: 'GMAIL_USER / GMAIL_APP_PASSWORD não configurados' };
  }

  const final = { ok: true, contas: contas.length, processados: 0, criados: 0, ignorados: 0, erros: [], porConta: [] };
  for (const conta of contas) {
    const r = await sincronizarContaGmail(conta);
    final.porConta.push(r);
    final.processados += r.processados || 0;
    final.criados += r.criados || 0;
    final.ignorados += r.ignorados || 0;
    if (r.recebidos) final.recebidos = (final.recebidos || 0) + r.recebidos;
    if (r.entregasSemPedido) final.entregasSemPedido = (final.entregasSemPedido || 0) + r.entregasSemPedido;
    if (r.cancelados) final.cancelados = (final.cancelados || 0) + r.cancelados;
    if (r.atualizados) final.atualizados = (final.atualizados || 0) + r.atualizados;
    if (!r.ok) final.ok = false;
    if (r.erros?.length) final.erros.push(...r.erros.map(e => `${conta.label}: ${e}`));
    if (r.motivo) final.erros.push(`${conta.label}: ${r.motivo}`);
  }
  if (!final.ok) final.motivo = final.erros.join(' | ') || 'falha em uma ou mais caixas Gmail';
  return final;
}
