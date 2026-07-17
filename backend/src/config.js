import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  };
}
