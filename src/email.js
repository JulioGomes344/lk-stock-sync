// ─── Envio de alertas via API HTTP do Resend ───
// Usa HTTPS (porta 443), que nunca é bloqueada — ao contrário das portas SMTP
// (587/465), que o Railway bloqueia na saída.
//
// Variáveis de ambiente:
// SMTP_PASS   → API key do Resend (começa com re_...). Mantivemos o mesmo nome
//               de variável para você não precisar reconfigurar nada no Railway.
//               (RESEND_API_KEY também funciona, se preferir renomear depois.)
// ALERT_TO    → destinatário(s), separados por vírgula
// ALERT_FROM  → remetente (precisa ser de domínio verificado no Resend)
// Sem chave configurada → DRY RUN: apenas loga no console.

const API_KEY = process.env.RESEND_API_KEY || process.env.SMTP_PASS;
const DRY = !API_KEY;

const FROM = process.env.ALERT_FROM || 'LK Sneakers <contato@lksneakers.com.br>';
const TO = (process.env.ALERT_TO || 'contato@lksneakers.com.br')
  .split(',').map(e => e.trim()).filter(Boolean);

// Destinatários padrão (para pré-preencher o campo de confirmação no painel)
export const destinatariosPadrao = () => TO.join(', ');

// URL pública do app — usada para transformar fotos locais (/uploads/...) em
// links absolutos que funcionam dentro do e-mail.
// Railway injeta RAILWAY_PUBLIC_DOMAIN automaticamente; APP_URL tem prioridade se definida.
const APP_URL = (process.env.APP_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''))
  .replace(/\/$/, '');

// Foto do parser (URL completa da loja) passa direto; foto local ganha o domínio do app.
function urlAbsoluta(foto) {
  if (!foto) return null;
  if (/^https?:\/\//i.test(foto)) return foto;
  return APP_URL ? APP_URL + foto : null; // sem APP_URL, omite a foto local
}

const LOGO_BRANCO = 'https://lksneakers.com.br/cdn/shop/files/LOGO-LK-BRANCO_885e01ed-68da-4988-b5a2-4ff4a10e238b.png?v=1763660281';

// Linhas de pedido (reutilizadas pelo alerta em lote e pelo aviso individual).
function montarLinhas(pedidos, { corPrazo = '#c4463a', labelPrazo = null } = {}) {
  return pedidos.map(p => {
    const statusLabel = p.status === 'enviado' ? 'Já enviado · em trânsito'
                      : p.status === 'recebido' ? 'Recebido no endereço do frete'
                      : 'Ainda a caminho do endereço do frete';
    const statusCor = p.status === 'enviado' ? '#b5b0a8'
                    : p.status === 'recebido' ? '#8a8580'
                    : '#c4463a';

    // Itens: miniatura quando houver foto (do parser ou do upload manual)
    const itensHtml = p.itens.map(i => {
      const foto = urlAbsoluta(i.foto_url);
      const nome = i.nome + (i.tamanho ? ' · ' + i.tamanho : '') + (i.qtd > 1 ? ' · x' + i.qtd : '');
      return `
        <table cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>
          ${foto ? `<td style="padding-right:10px;vertical-align:middle;">
            <img src="${foto}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;object-fit:cover;background:#1a1a1a;border:1px solid rgba(255,255,255,0.08);">
          </td>` : ''}
          <td style="vertical-align:middle;">
            <div style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:300;font-size:17px;color:#ffffff;">${nome}</div>
          </td>
        </tr></table>`;
    }).join('');

    return `
      <tr>
        <td style="padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#b5b0a8;">${p.loja}${p.numero_pedido ? ' · #' + p.numero_pedido : ''}</div>
          ${itensHtml}
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;color:#b5b0a8;margin-top:8px;">
            Compra: ${p.data_compra || 'sem data'}${p.valor ? ` · ${p.moeda} ${p.valor.toFixed(2)}` : ''}
          </div>
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;margin-top:3px;">
            <span style="color:${corPrazo};">${labelPrazo || `Atrasado · ${p.semaforo?.dias ?? '?'} dias desde a compra`}</span>
            <span style="color:${statusCor};"> · ${statusLabel}</span>
          </div>
        </td>
      </tr>`;
  }).join('');
}

// Casca do e-mail LK (fundo escuro, Cormorant + DM Sans) com conteúdo variável.
function montarShell({ kicker, corKicker = '#c4463a', titulo, texto, linhas }) {

  return `
  <div style="background:#0a0a0a;padding:0;margin:0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#0a0a0a;">
      <tr><td style="padding:40px 44px 30px;text-align:center;">
        <img src="${LOGO_BRANCO}" width="120" alt="LK Sneakers" style="display:block;margin:0 auto;">
      </td></tr>
      <tr><td style="padding:0 44px;text-align:center;">
        <div style="font-family:'DM Sans',Arial,sans-serif;font-size:8px;letter-spacing:4px;text-transform:uppercase;color:${corKicker};">${kicker}</div>
        <div style="width:28px;height:1px;background:rgba(255,255,255,0.15);margin:16px auto;"></div>
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:300;font-size:30px;color:#ffffff;margin:0;">
          ${titulo}
        </h1>
        <p style="font-family:'DM Sans',Arial,sans-serif;font-weight:300;font-size:13px;color:#b5b0a8;line-height:1.7;margin:14px 0 0;">
          ${texto}
        </p>
      </td></tr>
      <tr><td style="padding:28px 44px 10px;">
        <table width="100%" cellpadding="0" cellspacing="0">${linhas}</table>
      </td></tr>
      <tr><td style="padding:30px 44px 44px;text-align:center;">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-weight:300;font-size:12px;color:#b5b0a8;letter-spacing:1.5px;">O que é raro merece ser encontrado.</div>
      </td></tr>
    </table>
  </div>`;
}

// Envio bruto via API do Resend (com dry-run e timeout).
async function enviar(subject, html, resumoLog, destinatarios) {
  const to = (Array.isArray(destinatarios) && destinatarios.length) ? destinatarios : TO;

  if (DRY) {
    console.log('─── [DRY RUN] E-mail (configure SMTP_PASS com a API key do Resend) ───');
    console.log('Para:', to.join(', '), '| Assunto:', subject);
    if (resumoLog) console.log(resumoLog);
    return { enviado: false, dryRun: true };
  }

  try {
    // Timeout de 15s: nunca deixa a página pendurada
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('✗ Resend recusou o envio:', resp.status, body);
      return { enviado: false, erro: `Resend ${resp.status}: ${body.slice(0, 200)}` };
    }

    return { enviado: true };
  } catch (e) {
    const motivo = e.name === 'AbortError' ? 'timeout (15s)' : (e.code || e.message);
    console.error('✗ Falha ao enviar e-mail de atraso:', motivo);
    return { enviado: false, erro: motivo };
  }
}


// ── Alerta em lote: pedidos atrasados (usado pelo cron e pelo botão geral) ──
export async function enviarAlertaAtraso(pedidos) {
  if (!pedidos.length) return { enviado: false, motivo: 'sem pedidos atrasados' };
  const n = pedidos.length;
  const html = montarShell({
    kicker: 'Alerta de Prazo',
    corKicker: '#c4463a',
    titulo: `${n} ${n === 1 ? 'pedido atrasado' : 'pedidos atrasados'}`,
    texto: `${n === 1 ? 'O pedido abaixo passou' : 'Os pedidos abaixo passaram'} de 4 semanas desde a compra e ainda não ${n === 1 ? 'foi recebido' : 'foram recebidos'}.`,
    linhas: montarLinhas(pedidos)
  });
  const subject = `LK · ${n} ${n === 1 ? 'pedido atrasado' : 'pedidos atrasados'} (+4 semanas)`;
  return enviar(subject, html, 'Pedidos: ' + pedidos.map(p => `${p.loja} #${p.numero_pedido}`).join(', '));
}

// ── Aviso individual de um pedido: 'atraso' ou 'prioridade' ──
export async function enviarAvisoPedido(pedido, tipo) {
  const ref = `${pedido.loja}${pedido.pedido_loja ? ' #' + pedido.pedido_loja : ' #' + pedido.numero_pedido}`;

  if (tipo === 'prioridade') {
    const dias = pedido.semaforo?.dias;
    const html = montarShell({
      kicker: 'Prioridade de Envio',
      corKicker: '#b5b0a8',
      titulo: 'Priorizar este envio',
      texto: 'Solicitação de prioridade no envio do pedido abaixo, independentemente do prazo.',
      linhas: montarLinhas([pedido], {
        corPrazo: '#b5b0a8',
        labelPrazo: dias != null ? `${dias} dias desde a compra` : 'prazo em dia'
      })
    });
    return enviar(`LK · Priorizar envio — ${ref}`, html, `Pedido: ${ref}`);
  }

  // tipo 'atraso' (padrão)
  const html = montarShell({
    kicker: 'Alerta de Prazo',
    corKicker: '#c4463a',
    titulo: 'Pedido em atraso',
    texto: 'Aviso de atraso do pedido abaixo, enviado manualmente pelo painel.',
    linhas: montarLinhas([pedido])
  });
  return enviar(`LK · Pedido atrasado — ${ref}`, html, `Pedido: ${ref}`);
}

// ── Confirmação de compra (botão manual, destinatário escolhível) ──
// Layout editorial dedicado: foto grande do produto + nome, tamanho e valor.
export async function enviarConfirmacaoCompra(pedido, destinatarios) {
  const ref = `${pedido.loja}${pedido.pedido_loja ? ' #' + pedido.pedido_loja : ' #' + pedido.numero_pedido}`;
  const item = pedido.itens?.[0] || {};
  const foto = urlAbsoluta(item.foto_url);

  // bloco de cada item (nome + tamanho), abaixo da foto principal
  const itensHtml = (pedido.itens || []).map(i => {
    const tam = i.tamanho ? ` · ${i.tamanho}` : '';
    const qtd = i.qtd > 1 ? ` · x${i.qtd}` : '';
    return `<div style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:300;font-size:22px;color:#ffffff;line-height:1.35;margin:0 0 6px;">${i.nome}${tam}${qtd}</div>`;
  }).join('');

  const html = `
  <div style="background:#0a0a0a;padding:0;margin:0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#0a0a0a;">
      <tr><td style="padding:44px 44px 24px;text-align:center;">
        <img src="${LOGO_BRANCO}" width="110" alt="LK Sneakers" style="display:block;margin:0 auto;">
      </td></tr>
      <tr><td style="padding:0 44px;text-align:center;">
        <div style="font-family:'DM Sans',Arial,sans-serif;font-size:8px;letter-spacing:4px;text-transform:uppercase;color:#3a7d44;">Confirmação de Compra</div>
        <div style="width:28px;height:1px;background:rgba(255,255,255,0.15);margin:16px auto;"></div>
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:300;font-size:34px;color:#ffffff;margin:0 0 6px;">Compra confirmada</h1>
        <div style="font-family:'DM Sans',Arial,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#b5b0a8;">${ref}</div>
      </td></tr>

      ${foto ? `
      <tr><td style="padding:32px 44px 0;text-align:center;">
        <img src="${foto}" width="400" alt="" style="display:block;width:100%;max-width:400px;height:auto;margin:0 auto;background:#ffffff;border:1px solid rgba(255,255,255,0.08);">
      </td></tr>` : ''}

      <tr><td style="padding:32px 44px 0;text-align:center;">
        ${itensHtml}
      </td></tr>

      <tr><td style="padding:20px 44px 0;text-align:center;">
        <div style="width:28px;height:1px;background:rgba(255,255,255,0.15);margin:0 auto 18px;"></div>
        ${pedido.valor != null ? `<div style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:30px;color:#ffffff;">${pedido.moeda || 'USD'} ${Number(pedido.valor).toFixed(2)}</div>` : ''}
        ${pedido.data_compra ? `<div style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;color:#b5b0a8;margin-top:8px;">Compra em ${pedido.data_compra}</div>` : ''}
      </td></tr>

      <tr><td style="padding:40px 44px 44px;text-align:center;">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-weight:300;font-size:12px;color:#b5b0a8;letter-spacing:1.5px;">O que é raro merece ser encontrado.</div>
      </td></tr>
    </table>
  </div>`;

  return enviar(`LK · Confirmação de compra — ${ref}`, html, `Pedido: ${ref}`, destinatarios);
}
