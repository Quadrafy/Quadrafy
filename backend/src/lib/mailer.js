/**
 * Envio de e-mails transacionais via Resend (API HTTP).
 *
 * A chave (RESEND_API_KEY) e o remetente (RESEND_FROM) vivem apenas no
 * servidor. Quando não configurados, o mailer fica desabilitado e apenas
 * registra um aviso — assim o ambiente de desenvolvimento continua rodando
 * sem credenciais.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Template HTML do e-mail de recuperação de senha, alinhado à identidade
 * visual (coral #ff6b4a sobre fundo creme). CSS inline + tabela para máxima
 * compatibilidade com clientes de e-mail.
 */
function passwordResetTemplate({ appName, resetUrl, name, ttlLabel }) {
  const safeName = name ? escapeHtml(name) : "";
  const safeUrl = escapeHtml(resetUrl);
  const greeting = safeName ? `Olá, ${safeName}!` : "Olá!";
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>Redefinir senha</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f2ee;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14171f;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 12px 40px rgba(20,23,31,0.08);">
            <tr>
              <td style="background:#14171f;padding:28px 32px;">
                <span style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">${escapeHtml(appName)}<span style="color:#ff6b4a;">.</span></span>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 8px;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#14171f;">${greeting}</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#626772;">
                  Recebemos um pedido para redefinir a senha da sua conta no ${escapeHtml(appName)}.
                  Clique no botão abaixo para criar uma nova senha. Este link expira em <strong style="color:#14171f;">${escapeHtml(ttlLabel)}</strong>.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 32px 28px;">
                <a href="${safeUrl}" style="display:inline-block;background:#ff6b4a;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 34px;border-radius:999px;">
                  Redefinir minha senha
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px;">
                <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#626772;">
                  Se o botão não funcionar, copie e cole este endereço no navegador:
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;word-break:break-all;">
                  <a href="${safeUrl}" style="color:#e75435;">${safeUrl}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid #eceae5;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#8a8f99;">
                  Se você não solicitou a redefinição, ignore este e-mail — sua senha continua a mesma.
                </p>
              </td>
            </tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#a7abb3;">
            © ${escapeHtml(appName)} · Este é um e-mail automático, não responda.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function createMailer(config) {
  const apiKey = config.resendApiKey;
  const from = config.resendFrom;
  const appName = config.appName;
  const enabled = Boolean(apiKey && from);

  async function send({ to, subject, html, text }) {
    if (!enabled) {
      console.warn(
        `[mailer] desabilitado (sem RESEND_API_KEY/RESEND_FROM) — e-mail "${subject}" para ${to} não enviado.`,
      );
      return { skipped: true };
    }
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(
        `Resend respondeu ${response.status}: ${detail.slice(0, 300)}`,
      );
      error.status = response.status;
      throw error;
    }
    return response.json().catch(() => ({}));
  }

  async function sendPasswordReset({ to, resetUrl, name, ttlLabel = "1 hora" }) {
    const subject = `Redefinição de senha • ${appName}`;
    const html = passwordResetTemplate({ appName, resetUrl, name, ttlLabel });
    const text = [
      name ? `Olá, ${name}!` : "Olá!",
      "",
      `Recebemos um pedido para redefinir a senha da sua conta no ${appName}.`,
      `Abra o link abaixo para criar uma nova senha (válido por ${ttlLabel}):`,
      "",
      resetUrl,
      "",
      "Se você não solicitou, ignore este e-mail — sua senha continua a mesma.",
      "",
      `— Equipe ${appName}`,
    ].join("\n");
    return send({ to, subject, html, text });
  }

  return { enabled, send, sendPasswordReset };
}
