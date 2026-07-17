import { randomUUID } from "node:crypto";

const JSON_BODY_LIMIT = 32 * 1024;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getRequestId(request) {
  const supplied = request.headers["x-request-id"];
  return typeof supplied === "string" && supplied.length <= 100
    ? supplied
    : randomUUID();
}

export async function readJson(
  request,
  { maxBytes = JSON_BODY_LIMIT } = {},
) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Envie o corpo como application/json.",
    );
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ApiError(
        413,
        "payload_too_large",
        "O corpo da requisição excede o limite permitido.",
      );
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new ApiError(400, "invalid_json", "O corpo JSON é obrigatório.");
  }

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("Expected an object");
    }
    return value;
  } catch {
    throw new ApiError(400, "invalid_json", "O corpo JSON é inválido.");
  }
}

export function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(payload);
}

export function sendData(response, status, data, extraHeaders) {
  sendJson(response, status, { data }, extraHeaders);
}

export function sendError(response, error, requestId) {
  const knownError = error instanceof ApiError;
  const status = knownError ? error.status : 500;
  const body = {
    error: {
      code: knownError ? error.code : "internal_error",
      message: knownError
        ? error.message
        : "Não foi possível concluir a solicitação.",
      requestId,
    },
  };

  if (knownError && error.details) body.error.details = error.details;
  sendJson(response, status, body);
}

export function parseCookies(request) {
  const header = request.headers.cookie ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return [part, ""];
        const key = part.slice(0, separator);
        const rawValue = part.slice(separator + 1);
        try {
          return [key, decodeURIComponent(rawValue)];
        } catch {
          return [key, ""];
        }
      }),
  );
}

export function sessionCookie(token, maxAgeSeconds, secure = false) {
  const parts = [
    `quadrafy_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure = false) {
  return sessionCookie("", 0, secure);
}

export function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;

  const host = request.headers.host;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "invalid_origin", "Origem da requisição inválida.");
  }

  if (!host || originHost !== host) {
    throw new ApiError(403, "invalid_origin", "Origem da requisição inválida.");
  }
}
