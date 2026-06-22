export async function sendWhatsappGroupMessage(text) {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  const groupId = process.env.WHATSAPP_GROUP_ID;

  if (!baseUrl || !apiKey || !instance || !groupId) {
    console.log('[whatsapp dry-run]', text);
    return { dryRun: true };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/message/sendText/${instance}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ number: groupId, text })
  });

  if (!response.ok) {
    const body = await response.text();
    console.error('Falha ao enviar WhatsApp:', response.status, body);
    return { ok: false, status: response.status };
  }
  return { ok: true };
}
