// ─── Parsers de e-mail de confirmação por loja ───
// Mapeados a partir de e-mails reais (.eml) de cada loja em jun/2026.
// Cada parser recebe { subject, html, text } e retorna:
//   { pedido_loja, itens: [{ nome, sku, tamanho, qtd, foto_url }], valor, moeda }
// ou null se o e-mail não for uma confirmação de pedido parseável.

const decode = (s) => (s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\u00a0/g, ' ')
  .trim();

const textoLimpo = (html = '', text = '') => decode(`${text || ''}\n${html || ''}`
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>|<\/div>|<\/tr>|<\/td>|<\/h[1-6]>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' '));

const sanitizarSku = (sku) => {
  const limpo = String(sku || '')
    .replace(/\bSIZE\b.*$/i, '')
    .replace(/\b(?:US\s*)?(?:M|W|MEN'?S|MENS|WOMEN'?S|WOMENS|UNISEX)\s*\d+(?:\.5)?\b.*$/i, '')
    .trim();
  return limpo || null;
};

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
  const m1 = (subject || '').match(/#\s*([0-9A-Z][0-9A-Z-]{4,})/i);
  if (m1) return m1[1];
  const txt = textoLimpo(html);
  const m2 = txt.match(/(?:order|purchase)\s*(?:number|no\.?|#)\s*[:#]?\s*([0-9A-Z][0-9A-Z-]{4,})/i)
    || txt.match(/\b(?:order|purchase)\s*#\s*([0-9A-Z][0-9A-Z-]{4,})/i);
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
      sku: null,
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
    itens.push({ nome, sku: null, tamanho, qtd: 1, foto_url: src });
  }

  const hLimpo = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/\s+/g, ' ');
  const tm = hLimpo.match(/Total\|?\s*\|?\s*\$\s*([\d.,]+)/);
  const valor = tm ? parseFloat(tm[1].replace(/,/g, '')) : null;

  if (!pedido && !itens.length) return null;
  return { pedido_loja: pedido || null, itens, valor, moeda: 'USD' };
}

// ── STOCKX ──
// Nº do pedido: "Order number: 03-EBHH99EL1N" | nome no subject | SKU/style code "HV8547-601" | tamanho "US M 6" no corpo
// StockX NÃO envia imagem do produto (só ícones) → foto_url fica null.
function parseStockX({ subject, html, text }) {
  const txt = textoLimpo(html, text);

  const pedido = extrairNumeroPedidoGenerico(subject, `${text || ''}\n${html || ''}`);

  // nome: do subject "👍 Order Confirmed: Onitsuka Tiger Mexico 66 SD Birch Peacoat Green"
  let nome = (subject || '')
    .replace(/^[^A-Z0-9]*(?:Your\s+)?Order\s+(?:Has\s+Been\s+)?Confirmed\s*:?\s*/i, '')
    .replace(/^.*?Order Confirmed:\s*/i, '')
    .trim();
  // fallback: do corpo, antes de Size/US/Style ID/Order number
  if (!nome) {
    const m = txt.match(/([A-Z][A-Za-z0-9 '&()./+-]{8,120})\s+(?:Size|US\s*[MW]?\s*[\d.]+|Style ID|Order number)/i);
    nome = m ? m[1].trim() : 'Pedido StockX';
  }

  // tamanho: "US M 6", "US W 8.5", "US 10" etc.
  const tamanho = (txt.match(/\b(US\s*[MW]?\s*[\d.]+)\b/) || [])[1] || null;

  // SKU/Style ID: StockX mostra o style code em um chip antes do tamanho
  // (ex.: "HV8547-601 US W 7"), e em alguns e-mails também rotula como
  // "Style ID"/"SKU". Evita capturar o nº do pedido, que costuma ter vários hífens.
  const skuRaw = ((txt.match(/\b(?:Style\s*ID|Style|SKU)\s*[:#]?\s*([A-Z0-9]{2,}[- ][A-Z0-9-]{2,})\b/i) || [])[1]
    || (txt.match(/\b([A-Z0-9]{5,12})\s+SIZE\b/i) || [])[1]
    || (txt.match(/\b([A-Z]{1,4}\d{3,6}-\d{3})\b(?=\s+US\s*[MW]?\s*[\d.]+)/i) || [])[1]
    || (txt.match(/\b([A-Z]{1,4}\d{3,6}-\d{3})\b/) || [])[1]
    || null);
  const sku = sanitizarSku(skuRaw);

  // total: "Total Payment ... $377.86"
  const tm = txt.match(/Total Payment[^$]*\$\s*([\d.,]+)/i)
    || txt.match(/Purchase Price[^$]*\$\s*([\d.,]+)/i)
    || txt.match(/Total[^$]{0,60}\$\s*([\d.,]+)/i);
  const valor = tm ? parseFloat(tm[1].replace(/,/g, '')) : null;

  if (!pedido) return null;
  return {
    pedido_loja: pedido,
    itens: [{ nome, sku, tamanho, qtd: 1, foto_url: null }],
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
  // GOAT costuma trazer a informação de forma explícita como "SKU: XXXXX" no bloco do item.
  const sku = sanitizarSku((txt.match(/\bSKU\s*:?\s*([A-Z0-9][A-Z0-9._-]{2,})\b/i) || [])[1]);
  const img = ((html.match(/<img[^>]+src="(https:\/\/image\.goat\.com\/[^"]+)"/) || [])[1]) || null;
  const tot = txt.match(/Total\s*[|\s]*\$\s*([\d.,]+)/);
  const valor = tot ? parseFloat(tot[1].replace(/,/g, '')) : null;

  if (!pedido && !nome) return null;
  return {
    pedido_loja: pedido || null,
    itens: [{ nome: nome || 'Pedido GOAT', sku, tamanho, qtd: 1, foto_url: img }],
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
  const pedido = extrairNumeroPedidoGenerico(subject, html);
  const m = html.match(/<img[^>]+src="(https:\/\/images\.stockx\.com\/images\/[^"]+)"/);
  if (!pedido || !m) return null;
  return { pedido_loja: pedido, foto_url: m[1] };
}

// ── PONTO DE ENTRADA ──
// ── CANCELAMENTOS ──
// Detecta e-mails de cancelamento REAIS e estruturados. Retorna
// { pedido_loja, nome } para casar com um pedido existente, ou null.
// Importante: e-mails do suporte humano (ex: support@goat.com "Re: Cancel Order")
// NÃO são tratados aqui — são conversas, não confirmações automáticas.
export function parsearCancelamento(loja, { subject, html, from }) {
  const addr = (from || '').toLowerCase();
  const subj = subject || '';

  // GOAT: só o remetente automático info@goat.com (nunca support@)
  if (loja === 'GOAT') {
    if (addr.includes('support@goat.com')) return null;       // suporte humano: ignora
    if (!/has been cancel|order cancel/i.test(subj)) return null;
    const num = (subj.match(/#(\d{5,})/) || [])[1];
    if (!num) return null;
    return { pedido_loja: num, nome: null };
  }

  // StockX: "Your Recent Order Has Been Canceled: <produto>" — sem nº no corpo,
  // então casamos pelo NOME do produto (vindo do assunto).
  if (loja === 'StockX') {
    if (!/has been cancel/i.test(subj)) return null;
    const nome = subj.replace(/^.*Cancel(l?)ed:\s*/i, '').trim();
    return { pedido_loja: null, nome: nome || null };
  }

  // Shopify (Nude, ALD) e outras: padrão "Order #123 canceled/cancelled"
  if (/cancel(l?)ed|cancelad/i.test(subj)) {
    const num = (subj.match(/#(\d{4,})/) || [])[1];
    if (num) return { pedido_loja: num, nome: null };
  }
  return null;
}

export function parsearEmail(loja, { subject, html, text }) {
  if (!html) return null;
  if (!ehConfirmacao(loja, subject)) return null;
  try {
    if (loja === 'StockX') return parseStockX({ subject, html, text });
    if (loja === 'GOAT') return parseGOAT({ subject, html });
    if (loja === 'Aimé Leon Dore') return parseALD({ subject, html });
    // demais Shopify (Nude Project; Alo/Rhode tendem a seguir o padrão — validar com amostras)
    return parseShopifyPadrao({ subject, html, text });
  } catch (e) {
    console.error(`✗ [parser:${loja}] erro:`, e.message);
    return null;
  }
}
