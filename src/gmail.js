// ─── Sincronização Gmail → Pendentes ───
// Conecta via IMAP (App Password do Google), busca e-mails de confirmação
// das lojas conhecidas e cria pedidos Pendentes automaticamente, com itens
// e fotos dos produtos.
//
// Variáveis de ambiente:
//   GMAIL_USER         → seu e-mail do Gmail
//   GMAIL_APP_PASSWORD → senha de app (Conta Google → Segurança → Senhas de app)
//   GMAIL_DIAS         → janela de busca em dias (default 30)
// Sem credenciais → sincronização desativada (loga aviso e segue).
//
// Deduplicação dupla: por Message-ID do e-mail e por (loja + nº do pedido na
// loja). Rodar várias vezes nunca duplica pedido.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as store from './store.js';
import { identificarLoja, parsearEmail, ehConfirmacao, extrairNumeroPedidoGenerico, DOMINIOS, urlFotoStockX, parseEnvioStockX } from './parsers.js';

const USER = process.env.GMAIL_USER;
const PASS = process.env.GMAIL_APP_PASSWORD;
const DIAS = parseInt(process.env.GMAIL_DIAS || '30');

export const gmailConfigurado = () => !!(USER && PASS);

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

export async function sincronizarGmail() {
  if (!gmailConfigurado()) {
    return { ok: false, motivo: 'GMAIL_USER / GMAIL_APP_PASSWORD não configurados' };
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: USER, pass: PASS },
    logger: false
  });

  const resultado = { ok: true, processados: 0, criados: 0, ignorados: 0, erros: [] };
  const desde = new Date(Date.now() - DIAS * 86400000);

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
    console.log(`[gmail] buscando na pasta: ${caixa}`);

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

            // dedup 1: e-mail já processado
            if (store.emailJaProcessado(messageId)) { resultado.ignorados++; continue; }

            const loja = identificarLoja(mail.from?.value?.[0]?.address);
            if (!loja) { resultado.ignorados++; continue; }

            // StockX Shipped/Delivered: enriquece pedido existente com a foto real
            if (loja === 'StockX') {
              const envio = parseEnvioStockX({ subject: mail.subject, html: mail.html });
              if (envio) {
                const enriquecidos = store.anexarFotoPorPedidoLoja(loja, envio.pedido_loja, envio.foto_url);
                if (enriquecidos > 0) console.log(`✓ [gmail] foto anexada ao pedido StockX #${envio.pedido_loja} via e-mail de envio`);
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
              console.log(`⚠ [gmail] fallback: confirmação ${loja} ${numGenerico ? '#'+numGenerico : '(sem nº)'} registrada sem detalhes — conferir manualmente`);
            }
            if (!dados) { resultado.ignorados++; continue; } // marketing, envio, etc.

            // StockX: tenta construir a URL da foto a partir do nome (validada antes de salvar)
            if (loja === 'StockX') {
              for (const item of dados.itens) {
                if (!item.foto_url) {
                  const candidata = urlFotoStockX(item.nome);
                  if (candidata && await urlExiste(candidata)) item.foto_url = candidata;
                }
              }
            }

            // dedup 2: pedido da loja já registrado (ex: cadastro manual anterior)
            if (store.pedidoLojaJaExiste(loja, dados.pedido_loja)) { resultado.ignorados++; continue; }

            const pid = store.criarPedido({
              loja,
              data_compra: mail.date ? mail.date.toISOString().slice(0, 10) : null,
              valor: dados.valor,
              moeda: dados.moeda,
              origem: 'email',
              email_id: messageId,
              pedido_loja: dados.pedido_loja
            });
            for (const item of dados.itens) {
              const itemId = store.adicionarItem(pid, item);
              if (item.foto_url) store.anexarFoto(itemId, item.foto_url);
            }
            resultado.criados++;
            console.log(`✓ [gmail] ${loja} #${dados.pedido_loja} → pendente criado (${dados.itens.length} item(ns))`);
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
    console.error('✗ [gmail] falha na sincronização:', e.message);
    try { await client.logout(); } catch {}
  }
  return resultado;
}
