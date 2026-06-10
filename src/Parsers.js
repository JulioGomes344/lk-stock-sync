// ─── Parsers de e-mail de confirmação por loja ───
// Mapeados a partir de e-mails reais (.eml) de cada loja em jun/2026.
// Cada parser recebe { subject, html, text } e retorna:
//   { pedido_loja, itens: [{ nome, tamanho, qtd, foto_url }], valor, moeda }
// ou null se o e-mail não for uma confirmação de pedido parseável.

const decode = (s) => (s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\u00a0/g, ' ')
  .trim();

// ── Remetentes conhecidos → loja ──
export const REMETENTES = {
  'help@nude-project.com':   'Nude Project',
  'orders@aimeleondore.com': 'Aimé Leon Dore',
  'noreply@stockx.com':      'StockX'
};

export function identificarLoja(fromAddress) {
  const addr = (fromAddress || '').toLowerCase();
  for (const [email, loja] of Object.entries(REMETENTES)) {
    if (addr.includes(email)) return loja;
  }
  return null;
}

// ── É confirmação de pedido? (filtra envio, marketing, etc.) ──
function ehConfirmacao(loja, subject) {
  const s = (subject || '').toLowerCase();
  if (loja === 'StockX') return s.includes('order confirmed');
  // Shopify (Nude, ALD): "Order #1234 confirmed"
  return /order\s*#?\d+\s*confirmed/i.test(subject || '');
}

// ── SHOPIFY PADRÃO (Nude Project e similares) ──
// Estrutura: classes order-list__item-title / item-variant / product-image
function parseShopifyPadrao({ subject, html, text }) {
  const pedido = (subject?.match(/#(\d{4,})/) || html?.match(/[Oo]rder\s*#?(\d{4,})/) || [])[1];

  const itens = [];
  // títulos vêm como "Nome do Produto × 1"
  const titulos = [...html.matchAll(/class="order-list__item-title"[^>]*>([^<]+)</g)].map(m => decode(m[1]));
  const variantes = [...html.matchAll(/class="order-list__item-variant"[^>]*>([^<]+)</g)].map(m => decode(m[1]));
  // a ordem dos atributos varia (src antes ou depois da classe) — captura a tag inteira
  const imagens = [...html.matchAll(/<img[^>]*class="order-list__product-image"[^>]*>/g)]
    .map(m => (m[0].match(/src="([^"]+)"/) || [])[1])
    .filter(Boolean);

  titulos.forEach((t, i) => {
    const qtdMatch = t.match(/[×x]\s*(\d+)\s*$/);
    const nome = t.replace(/\s*[×x]\s*\d+\s*$/, '').trim();
    itens.push({
      nome,
      tamanho: variantes[i] || null,
      qtd: qtdMatch ? parseInt(qtdMatch[1]) : 1,
      foto_url: imagens[i] || null
    });
  });

  // total: procura no texto plano primeiro (mais confiável)
  const tm = (text || '').match(/Total[:\s]*\$\s*([\d.,]+)/) || (html || '').match(/>Total<[\s\S]{0,200}?\$\s*([\d.,]+)/);
  const valor = tm ? parseFloat(tm[1].replace(/,/g, '')) : null;

  if (!pedido && !itens.length) return null;
  return { pedido_loja: pedido || null, itens, valor, moeda: 'USD' };
}

// ── AIMÉ LEON DORE (Shopify customizado) ──
// Itens vêm no alt da imagem: "Nome do Produto - VARIANTE / Tamanho"
function parseALD({ subject, html }) {
  const pedido = (subject?.match(/#(\d{4,})/) || [])[1];

  const itens = [];
  for (const m of html.matchAll(/class="product-image"\s+src="([^"]+)"\s+alt="([^"]+)"/g)) {
    const [, src, altRaw] = m;
    const alt = decode(altRaw);
    // "Unisphere Hat - PRISTINE / One Size" → nome | variante
    const sep = alt.lastIndexOf(' - ');
    const nome = sep > 0 ? alt.slice(0, sep) : alt;
    const tamanho = sep > 0 ? alt.slice(sep + 3) : null;
    itens.push({ nome, tamanho, qtd: 1, foto_url: src });
  }

  const hLimpo = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/\s+/g, ' ');
  const tm = hLimpo.match(/Total\|?\s*\|?\s*\$\s*([\d.,]+)/);
  const valor = tm ? parseFloat(tm[1].replace(/,/g, '')) : null;

  if (!pedido && !itens.length) return null;
  return { pedido_loja: pedido || null, itens, valor, moeda: 'USD' };
}

// ── STOCKX ──
// Nº do pedido: "Order number: 03-EBHH99EL1N" | nome no subject | tamanho "US M 6" no corpo
// StockX NÃO envia imagem do produto (só ícones) → foto_url fica null.
function parseStockX({ subject, html }) {
  const txt = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/\s+/g, ' ');

  const pedido = (txt.match(/Order number:\s*\|?\s*([0-9A-Z][0-9A-Z-]{6,})/i) || [])[1];

  // nome: do subject "👍 Order Confirmed: Onitsuka Tiger Mexico 66 SD Birch Peacoat Green"
  let nome = (subject || '').replace(/^[^:]*Order Confirmed:\s*/i, '').trim();
  // fallback: do corpo, o trecho antes do style-id
  if (!nome) {
    const m = txt.match(/\|([A-Z][^|]{8,80})\|\s*\|?[A-Z0-9]{4,}-[0-9]{2,}\|/);
    nome = m ? m[1].trim() : 'Pedido StockX';
  }

  // tamanho: "US M 6", "US W 8.5", "US 10" etc.
  const tamanho = (txt.match(/\b(US\s*[MW]?\s*[\d.]+)\b/) || [])[1] || null;

  // total: "Total Payment ... $377.86"
  const tm = txt.match(/Total Payment[^$]*\$\s*([\d.,]+)/i) || txt.match(/Purchase Price:[^$]*\$\s*([\d.,]+)/i);
  const valor = tm ? parseFloat(tm[1].replace(/,/g, '')) : null;

  if (!pedido) return null;
  return {
    pedido_loja: pedido,
    itens: [{ nome, tamanho, qtd: 1, foto_url: null }],
    valor, moeda: 'USD'
  };
}

// ── STOCKX: URL da foto construível a partir do nome ──
// Padrão validado: https://images.stockx.com/images/{Nome-Com-Hifens}-Product.jpg
export function urlFotoStockX(nome) {
  if (!nome) return null;
  const slug = nome.replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  return `https://images.stockx.com/images/${slug}-Product.jpg`;
}

// ── STOCKX: e-mails de Shipped/Delivered ──
// Não criam pedido, mas servem para ENRIQUECER um pedido existente com a
// foto real do produto (esses e-mails trazem a imagem; a confirmação não).
export function parseEnvioStockX({ subject, html }) {
  const s = (subject || '').toLowerCase();
  if (!s.includes('shipped') && !s.includes('delivered')) return null;
  const txt = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/\s+/g, ' ');
  const pedido = (txt.match(/Order number:\s*\|?\s*([0-9A-Z][0-9A-Z-]{6,})/i) || [])[1];
  const m = html.match(/<img[^>]+src="(https:\/\/images\.stockx\.com\/images\/[^"]+)"/);
  if (!pedido || !m) return null;
  return { pedido_loja: pedido, foto_url: m[1] };
}

// ── PONTO DE ENTRADA ──
export function parsearEmail(loja, { subject, html, text }) {
  if (!html) return null;
  if (!ehConfirmacao(loja, subject)) return null;
  try {
    if (loja === 'StockX') return parseStockX({ subject, html });
    if (loja === 'Aimé Leon Dore') return parseALD({ subject, html });
    // demais Shopify (Nude Project; Alo/Rhode tendem a seguir o padrão — validar com amostras)
    return parseShopifyPadrao({ subject, html, text });
  } catch (e) {
    console.error(`✗ [parser:${loja}] erro:`, e.message);
    return null;
  }
}
