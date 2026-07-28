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
const messages = [];

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "padelfy-phone-test-"));
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
    whatsapp: {
      enabled: true,
      async sendVerificationCode(payload) {
        messages.push(payload);
        return { id: "test" };
      },
      async sendText() {
        return { id: "test" };
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

let cookie;

test("phone verification sends a code by WhatsApp and confirms the number", async () => {
  const registration = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Bia",
      lastName: "Nunes",
      email: "phone-user@example.com",
      password: "SenhaSegura123",
      phone: "11987654321",
      level: "Iniciante",
      city: "Curitiba",
      gender: "female",
    },
  });
  assert.equal(registration.status, 201);
  cookie = registration.headers.get("set-cookie").split(";", 1)[0];

  const send = await api("/api/v1/auth/phone/send", { method: "POST", cookie });
  assert.equal(send.status, 200);
  assert.equal(messages.length, 1);
  const code = messages[0].code;
  assert.match(code, /^\d{6}$/);

  // Código errado é rejeitado.
  const wrong = await api("/api/v1/auth/phone/verify", {
    method: "POST",
    cookie,
    body: { code: "000000" },
  });
  assert.equal(wrong.status, 400);

  // Código certo confirma.
  const verify = await api("/api/v1/auth/phone/verify", {
    method: "POST",
    cookie,
    body: { code },
  });
  assert.equal(verify.status, 200);
  assert.equal((await verify.json()).data.verified, true);

  const me = await api("/api/v1/auth/me", { cookie });
  assert.equal((await me.json()).data.user.profile.phoneVerified, true);
});

test("phone endpoints require authentication", async () => {
  const send = await api("/api/v1/auth/phone/send", { method: "POST" });
  assert.equal(send.status, 401);
});
