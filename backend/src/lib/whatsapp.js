/**
 * Envio de mensagens WhatsApp via Evolution API (self-hosted).
 *
 * Fica desabilitado enquanto EVOLUTION_URL/EVOLUTION_API_KEY/EVOLUTION_INSTANCE
 * não são configurados — o fluxo de verificação de telefone pode ser publicado
 * "pronto" e passa a enviar de verdade assim que a instância for plugada.
 */

// Normaliza um telefone brasileiro (DDD + número) para o formato que a
// Evolution espera: dígitos com código do país (55). Aceita números já com 55.
export function toWhatsAppNumber(rawPhone) {
  const digits = String(rawPhone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55")) return digits;
  return `55${digits}`;
}

export function createWhatsApp(config) {
  const baseUrl = config.evolutionUrl;
  const apiKey = config.evolutionApiKey;
  const instance = config.evolutionInstance;
  const enabled = Boolean(baseUrl && apiKey && instance);

  async function sendText({ to, text }) {
    if (!enabled) {
      console.warn(
        `[whatsapp] desabilitado (sem credenciais Evolution) — mensagem para ${to} não enviada.`,
      );
      return { skipped: true };
    }
    const number = toWhatsAppNumber(to);
    const response = await fetch(
      `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: apiKey,
        },
        body: JSON.stringify({ number, text }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(
        `Evolution respondeu ${response.status}: ${detail.slice(0, 200)}`,
      );
      error.status = response.status;
      throw error;
    }
    return response.json().catch(() => ({}));
  }

  async function sendVerificationCode({ to, code, appName = "Padelfy" }) {
    const text = `${appName}: seu código de verificação é ${code}. Ele expira em alguns minutos. Se não foi você, ignore esta mensagem.`;
    return sendText({ to, text });
  }

  return { enabled, sendText, sendVerificationCode };
}
