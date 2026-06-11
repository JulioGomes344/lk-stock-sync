// ─── Parsers de e-mail de confirmação por loja ───
// Mapeados a partir de e-mails reais (.eml) de cada loja em jun/2026.
// Cada parser recebe { subject, html, text } e retorna:
//   { pedido_loja, itens: [{ nome, tamanho, qtd, foto_url }], valor, moeda }
// ou null se o e-mail não for uma confirmação de pedido parseável.

const decode = (s) => (s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\u00a0/g, ' ')
  .trim();

// ── Domínios conhecidos → loja ──
// Matching por DOMÍNIO (não endereço exato): qualquer remetente @stockx.com
// é StockX, mesmo que a loja troque o prefixo (noreply@, orders@, no-reply@...).
export const DOMINIOS = {
  'nude-project.com':  'Nude Project',
  'aimeleondore.com':  'Aimé Leon Dore',
  'stockx.com':        'StockX',
  'goat.com':          'GOAT'   // remetente real: no-reply@e.goat.com (subdomínio)
};
// compat: usado pelo gmail.js para montar as buscas IMAP
export const REMETENTES = Object.fromEntries(Object.entries(DOMINIOS).map(([d, l]) => [d, l]));

export function identificarLoja(fromAddress) {
  const addr = (fromAddress || '').toLowerCase();
  for (const [dominio, loja] of Object.entries(DOMINIOS)) {
    if (addr.endsWith('@' + dominio) || addr.includes('@' + dominio + '>') || addr.includes(dominio)) return loja;
  }
  return null;
}

// ── É confirmação de pedido? (filtra envio, marketing, etc.) ──
// Exportada para o fallback de garantia no gmail.js.
// Palavras-chave amplas: pega variações de texto que as lojas possam adotar.
export function ehConfirmacao(loja, subject) {
  const s = (subject || '').toLowerCase();
  const padroes = [
    /order\s*(#?\d+\s*)?confirmed/,   // "Order Confirmed", "Order #123 confirmed"
    /your order is confirmed/,
    /order confirmation/,
    /thank you for your (order|purchase)/,
    /pedido\s*(#?\d+\s*)?confirmado/,  // versões em português
    /confirma[çc][ãa]o d[eo] pedido/,
    /your goat order/                    // GOAT: "Your GOAT order #377805419"
  ];
  // nunca tratar e-mails de envio/entrega como confirmação
  if (/shipped|delivered|out for delivery|enviado|entregue|a caminho/.test(s)) return false;
  return padroes.some(rx => rx.test(s));
}

// ── Extração genérica do nº do pedido (para o fallback de garantia) ──
export function extrairNumeroPedidoGenerico(subject, html) {
  const m1 = (subject || '').match(/#(\d{4,})/);
  if (m1) return m1[1];
  const txt = (html || '').replace(/<[^>]+>/g, '|');
  const m2 = txt.match(/Order number:\s*\|?\s*([0-9A-Z][0-9A-Z-]{6,})/i) || txt.match(/[Oo]rder\s*#?(\d{4,})/);
  return m2 ? m2[1] : null;
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

// ── GOAT ──
// Nº no assunto ("Your GOAT order #377805419"); nome após "You ordered the";
// tamanho no bloco "US Women's 11.0 (EU 43 W) / New / good condition / SKU: ...";
// imagem em image.goat.com; total em "Total | $409.76".
function parseGOAT({ subject, html }) {
  const pedido = ((subject || '').match(/#(\d{5,})/) || [])[1];

  const txt = html
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '|').replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\|+/g, '|').replace(/\s+/g, ' ');

  let nome = ((txt.match(/You ordered the ([^|]+?)\s*\|/) || [])[1] || '').trim() || null;
  // fallback: o texto entre a imagem do produto e o bloco de tamanho
  if (!nome) {
    const m = txt.match(/image\.goat\.com[^|]*\|+\s*([^|]{8,120})\s*\|/);
    nome = m ? m[1].trim() : null;
  }

  const tamanho = ((txt.match(/\|\s*(US [^|/]+?)\s*\//) || [])[1] || '').trim() || null;
  const img = ((html.match(/<img[^>]+src="(https:\/\/image\.goat\.com\/[^"]+)"/) || [])[1]) || null;
  const tot = txt.match(/Total\s*[|\s]*\$\s*([\d.,]+)/);
  const valor = tot ? parseFloat(tot[1].replace(/,/g, '')) : null;

  if (!pedido && !nome) return null;
  return {
    pedido_loja: pedido || null,
    itens: [{ nome: nome || 'Pedido GOAT', tamanho, qtd: 1, foto_url: img }],
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
    if (loja === 'GOAT') return parseGOAT({ subject, html });
    if (loja === 'Aimé Leon Dore') return parseALD({ subject, html });
    // demais Shopify (Nude Project; Alo/Rhode tendem a seguir o padrão — validar com amostras)
    return parseShopifyPadrao({ subject, html, text });
  } catch (e) {
    console.error(`✗ [parser:${loja}] erro:`, e.message);
    return null;
  }
}
