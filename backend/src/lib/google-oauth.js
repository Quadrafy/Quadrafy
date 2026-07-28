/**
 * Login com Google (OAuth 2.0 / OpenID Connect).
 *
 * Fica desabilitado enquanto GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET não são
 * configurados — assim o fluxo pode ser publicado "pronto" e passa a funcionar
 * assim que as credenciais do Google Cloud forem preenchidas no .env.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function createGoogleOAuth(config) {
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  const redirectUri =
    config.googleRedirectUri ||
    `${config.appBaseUrl}/api/v1/auth/google/callback`;
  const enabled = Boolean(clientId && clientSecret);

  function authorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "online",
      prompt: "select_account",
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async function exchangeCode(code) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Google token exchange falhou (${response.status}): ${detail.slice(0, 200)}`,
      );
    }
    return response.json();
  }

  async function fetchUserInfo(accessToken) {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google userinfo falhou (${response.status}).`);
    }
    // { sub, email, email_verified, name, given_name, family_name, picture }
    return response.json();
  }

  return { enabled, redirectUri, authorizationUrl, exchangeCode, fetchUserInfo };
}
