export function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function splitOrderRefs(text) {
  return String(text || '')
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function meaningfulLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function cleanSkuLine(line) {
  return String(line || '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^SKU\s*[:·-]?\s*/i, '')
    .replace(/\s+SIZE\b.*$/i, '')
    .trim();
}

function parseUsSizeLine(line) {
  const raw = String(line || '').trim();
  const value = raw.match(/(\d+(?:\.5)?)/)?.[1];
  if (!value) return null;
  if (/US\s+(?:MENS?|MEN'?S|UNISEX|M\b)/i.test(raw)) return { mens: parseFloat(value) };
  if (/US\s+(?:WOMENS?|WOMEN'?S|W\b)/i.test(raw)) return { womens: parseFloat(value) };
  return null;
}

function parseUsSizes(lines) {
  return lines.reduce((acc, line) => {
    const parsed = parseUsSizeLine(line);
    if (!parsed) return acc;
    return { ...acc, ...parsed };
  }, {});
}

function looksLikeSku(line) {
  const sku = cleanSkuLine(line);
  return /^[A-Z0-9][A-Z0-9._-]{3,}$/i.test(sku) && !/^US\b/i.test(sku);
}

function parseReceivedBlock(text) {
  const lines = meaningfulLines(text);
  if (!/^recebido\b/i.test(lines[0] || '')) return null;
  const skuLine = lines.slice(1).find(looksLikeSku);
  if (!skuLine) return null;
  const sizes = parseUsSizes(lines.slice(1));
  return { intent: 'mark_received', orderRef: cleanSkuLine(skuLine), sizes, confidence: 'high' };
}

function parseShippedBlock(text) {
  const lines = meaningfulLines(text);
  if (!/^enviado\b/i.test(lines[0] || '')) return null;
  const batch = lines[1] && !/^\d+\./.test(lines[1]) && !/^US\b/i.test(lines[1])
    ? lines[1]
    : null;
  const productLines = batch ? lines.slice(2) : lines.slice(1);
  const orderRefs = productLines.filter(looksLikeSku).map(cleanSkuLine);
  if (!batch || !orderRefs.length) return null;
  return { intent: 'assign_batch', batch, orderRefs, confidence: 'high' };
}

export function parseOperatorMessage(text) {
  const block = parseReceivedBlock(text) || parseShippedBlock(text);
  if (block) return block;

  const normalized = normalizeText(text);
  let match;

  match = normalized.match(/^enviado\s+(\S+)(?:\s+lote\s+([a-z0-9-]+))?(?:\s+tracking\s+([a-z0-9-]+))?$/i);
  if (match) {
    return { intent: 'mark_shipped', orderRef: match[1], batch: match[2] || null, tracking: match[3] || null, confidence: 'high' };
  }

  match = normalized.match(/^recebido\s+(\S+)$/i);
  if (match) return { intent: 'mark_received', orderRef: match[1], confidence: 'high' };

  match = normalized.match(/^entregue\s+(\S+)$/i);
  if (match) return { intent: 'mark_delivered', orderRef: match[1], confidence: 'high' };

  match = normalized.match(/^tracking\s+(\S+)\s+([a-z0-9-]+)$/i);
  if (match) return { intent: 'set_tracking', orderRef: match[1], tracking: match[2], confidence: 'high' };

  match = normalized.match(/^problema\s+(\S+)\s+(.+)$/i);
  if (match) return { intent: 'report_problem', orderRef: match[1], note: match[2], confidence: 'high' };

  match = normalized.match(/^obs\s+(\S+)\s+(.+)$/i);
  if (match) return { intent: 'add_note', orderRef: match[1], note: match[2], confidence: 'high' };

  match = normalized.match(/^lote\s+([a-z0-9-]+)\s+pedidos\s+(.+)$/i);
  if (match) return { intent: 'assign_batch', batch: match[1], orderRefs: splitOrderRefs(match[2]), confidence: 'high' };

  return { intent: 'unknown', confidence: 'low' };
}
