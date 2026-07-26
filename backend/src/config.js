import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function allowedOrigins(value) {
  const candidates = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");

  return [
    ...new Set(
      candidates
        .map((candidate) => String(candidate).trim())
        .filter(Boolean)
        .map((candidate) => {
          try {
            const url = new URL(candidate);
            return ["http:", "https:"].includes(url.protocol)
              ? url.origin
              : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    ),
  ];
}

export function loadConfig(overrides = {}) {
  const environment =
    overrides.environment ?? process.env.NODE_ENV ?? "development";
  const sessionHours = positiveInteger(
    overrides.sessionTtlHours ?? process.env.SESSION_TTL_HOURS,
    168,
  );

  return {
    environment,
    isProduction: environment === "production",
    port: positiveInteger(overrides.port ?? process.env.PORT, 4173),
    sessionTtlMs: sessionHours * 60 * 60 * 1000,
    allowedOrigins: allowedOrigins(
      overrides.allowedOrigins ?? process.env.ALLOWED_ORIGINS,
    ),
    dataDirectory:
      overrides.dataDirectory ??
      process.env.DATA_DIR ??
      path.resolve(currentDirectory, "../data"),
    frontendDirectory:
      overrides.frontendDirectory ??
      path.resolve(currentDirectory, "../../frontend"),
    anthropicApiKey:
      overrides.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
    anthropicModel:
      overrides.anthropicModel ??
      process.env.ANTHROPIC_MODEL ??
      "claude-haiku-4-5-20251001",
    anthropicBaseUrl:
      overrides.anthropicBaseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com",
    anthropicTimeoutMs: positiveInteger(
      overrides.anthropicTimeoutMs ?? process.env.ANTHROPIC_TIMEOUT_MS,
      8_000,
    ),
    supabaseUrl: overrides.supabaseUrl ?? process.env.SUPABASE_URL ?? '',
    supabaseSecretKey:
      overrides.supabaseSecretKey ?? process.env.SUPABASE_SECRET_KEY ?? '',
    appName: overrides.appName ?? process.env.APP_NAME ?? "Padelfy",
    appBaseUrl: (
      overrides.appBaseUrl ??
      process.env.APP_BASE_URL ??
      "https://www.padelfy.com.br"
    ).replace(/\/+$/, ""),
    resendApiKey: overrides.resendApiKey ?? process.env.RESEND_API_KEY ?? "",
    resendFrom:
      overrides.resendFrom ??
      process.env.RESEND_FROM ??
      "Padelfy <no-reply@padelfy.com.br>",
    passwordResetTtlMs:
      positiveInteger(
        overrides.passwordResetTtlHours ??
          process.env.PASSWORD_RESET_TTL_HOURS,
        1,
      ) *
      60 *
      60 *
      1000,
    emailVerificationTtlMs:
      positiveInteger(
        overrides.emailVerificationTtlHours ??
          process.env.EMAIL_VERIFICATION_TTL_HOURS,
        24,
      ) *
      60 *
      60 *
      1000,
  };
}
