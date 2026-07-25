import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

let baseUrl;
let dataDirectory;
let server;
const sentEmails = [];

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "quadrafy-reset-test-"));
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
    // Mailer falso: captura o e-mail em vez de enviar pelo Resend.
    mailer: {
      enabled: true,
      async sendPasswordReset(payload) {
        sentEmails.push(payload);
        return { id: "test-email" };
      },
    },
  });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDirectory, { recursive: true, force: true });
});

async function api(pathname, { method = "GET", body, cookie } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: baseUrl } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const email = "reset-user@example.com";
const originalPassword = "SenhaOriginal123";
const newPassword = "SenhaNova456AB";

test("full password recovery flow updates the password and consumes the token", async () => {
  const registration = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Rita",
      lastName: "Souza",
      email,
      password: originalPassword,
      phone: "11912345678",
      level: "Iniciante",
      city: "Santos",
    },
  });
  assert.equal(registration.status, 201);

  // Pedido de recuperação: resposta neutra + e-mail com link contendo o token.
  const forgot = await api("/api/v1/auth/forgot-password", {
    method: "POST",
    body: { email },
  });
  assert.equal(forgot.status, 200);
  assert.match((await forgot.json()).data.message, /link/i);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, email);

  const token = new URL(sentEmails[0].resetUrl).searchParams.get("token");
  assert.ok(token && token.length >= 20);

  // Redefinição com o token válido.
  const reset = await api("/api/v1/auth/reset-password", {
    method: "POST",
    body: { token, password: newPassword },
  });
  assert.equal(reset.status, 200);

  // Senha antiga não funciona mais; a nova sim.
  const oldLogin = await api("/api/v1/auth/login", {
    method: "POST",
    body: { email, password: originalPassword },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await api("/api/v1/auth/login", {
    method: "POST",
    body: { email, password: newPassword },
  });
  assert.equal(newLogin.status, 200);

  // Token de uso único: repetir falha.
  const reused = await api("/api/v1/auth/reset-password", {
    method: "POST",
    body: { token, password: "OutraSenha789XZ" },
  });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error.code, "invalid_reset_token");
});

test("forgot-password does not reveal whether an e-mail exists", async () => {
  const before = sentEmails.length;
  const response = await api("/api/v1/auth/forgot-password", {
    method: "POST",
    body: { email: "does-not-exist@example.com" },
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).data.message, /link/i);
  // Nenhum e-mail é disparado para conta inexistente.
  assert.equal(sentEmails.length, before);
});

test("reset-password rejects a malformed token", async () => {
  const response = await api("/api/v1/auth/reset-password", {
    method: "POST",
    body: { token: "não-é-um-token-válido", password: newPassword },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_reset_token");
});
