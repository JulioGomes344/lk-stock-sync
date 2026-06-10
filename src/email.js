import nodemailer from 'nodemailer';

// ─── Config por variáveis de ambiente ───
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS  → credenciais do servidor
// ALERT_TO    → e-mail que recebe os avisos (ex: contato@lksneakers.com.br)
// ALERT_FROM  → remetente (default: "LK Sneakers <contato@lksneakers.com.br>")
// Sem SMTP configurado → DRY RUN: apenas loga no console (bom para testar).

const DRY = !process.env.SMTP_HOST;

const PORT = parseInt(process.env.SMTP_PORT || '465');

const transporter = DRY ? null : nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: PORT,
  secure: PORT === 465,                 // 465 = SSL (porta liberada no Railway); 587 = STARTTLS
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // Timeouts curtos: se o envio travar, falha rápido em vez de pendurar a página
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000
});

const FROM = process.env.ALERT_FROM || 'LK Sneakers <contato@lksneakers.com.br>';
const TO = process.env.ALERT_TO || 'contato@lksneakers.com.br';

const LOGO_BRANCO = 'https://lksneakers.com.br/cdn/shop/files/LOGO-LK-BRANCO_885e01ed-68da-4988-b5a2-4ff4a10e238b.png?v=1763660281';

// Monta o HTML do alerta seguindo a identidade LK (fundo escuro, Cormorant + DM Sans).
function montarHtml(pedidos) {
  const linhas = pedidos.map(p => {
    const itens = p.itens.map(i => i.nome + (i.tamanho ? ' · ' + i.tamanho : '')).join(' / ') || 'Sem itens';
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#b5b0a8;">${p.loja}${p.numero_pedido ? ' · #' + p.numero_pedido : ''}</div>
          <div style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:300;font-size:18px;color:#ffffff;margin-top:3px;">${itens}</div>
          <div style="font-family:'DM Sans',Arial,sans-serif;font-size:11px;color:#c4463a;margin-top:4px;">Atrasado · ${p.semaforo.dias} dias desde a compra</div>
        </td>
      </tr>`;
  }).join('');

  return `
  <div style="background:#0a0a0a;padding:0;margin:0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#0a0a0a;">
      <tr><td style="padding:40px 44px 30px;text-align:center;">
        <img src="${LOGO_BRANCO}" width="120" alt="LK Sneakers" style="display:block;margin:0 auto;">
      </td></tr>
      <tr><td style="padding:0 44px;text-align:center;">
        <div style="font-family:'DM Sans',Arial,sans-serif;font-size:8px;letter-spacing:4px;text-transform:uppercase;color:#c4463a;">Alerta de Prazo</div>
        <div style="width:28px;height:1px;background:rgba(255,255,255,0.15);margin:16px auto;"></div>
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:300;font-size:30px;color:#ffffff;margin:0;">
          ${pedidos.length} ${pedidos.length === 1 ? 'pedido atrasado' : 'pedidos atrasados'}
        </h1>
        <p style="font-family:'DM Sans',Arial,sans-serif;font-weight:300;font-size:13px;color:#b5b0a8;line-height:1.7;margin:14px 0 0;">
          ${pedidos.length === 1 ? 'O pedido abaixo passou' : 'Os pedidos abaixo passaram'} de 4 semanas desde a compra e ainda não ${pedidos.length === 1 ? 'foi recebido' : 'foram recebidos'}.
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

// Envia (ou loga, em dry-run) o resumo de pedidos atrasados.
export async function enviarAlertaAtraso(pedidos) {
  if (!pedidos.length) return { enviado: false, motivo: 'sem pedidos atrasados' };

  const html = montarHtml(pedidos);
  const subject = `LK · ${pedidos.length} ${pedidos.length === 1 ? 'pedido atrasado' : 'pedidos atrasados'} (+4 semanas)`;

  if (DRY) {
    console.log('─── [DRY RUN] E-mail de atraso (configure SMTP_* para enviar de verdade) ───');
    console.log('Para:', TO, '| Assunto:', subject);
    console.log('Pedidos:', pedidos.map(p => `${p.loja} #${p.numero_pedido} (${p.semaforo.dias}d)`).join(', '));
    return { enviado: false, dryRun: true };
  }

  try {
    await transporter.sendMail({ from: FROM, to: TO, subject, html });
    return { enviado: true };
  } catch (e) {
    // Nunca deixa um erro de e-mail derrubar o app ou pendurar a página
    console.error('✗ Falha ao enviar e-mail de atraso:', e.code || e.message);
    return { enviado: false, erro: e.code || e.message };
  }
}
