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
const verifications = [];

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "padelfy-verify-test-"));
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
    mailer: {
      enabled: true,
      async sendPasswordReset() {
        return { id: "test" };
      },
      async sendEmailVerification(payload) {
        verifications.push(payload);
        return { id: "test-verify" };
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

const email = "verify-user@example.com";
let cookie;

test("registration sends a verification e-mail and creates an unverified account", async () => {
  const registration = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Caio",
      lastName: "Lima",
      email,
      password: "SenhaSegura123",
      phone: "11912345678",
      level: "Iniciante",
      city: "Recife",
    },
  });
  assert.equal(registration.status, 201);
  cookie = registration.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].to, email);

  const me = await api("/api/v1/auth/me", { cookie });
  assert.equal((await me.json()).data.user.profile.emailVerified, false);
});

test("resend-verification issues a fresh link for the logged-in user", async () => {
  const response = await api("/api/v1/auth/resend-verification", {
    method: "POST",
    cookie,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.verified, false);
  assert.equal(verifications.length, 2);
});

test("verifying with the token activates the account and is single-use", async () => {
  const token = new URL(verifications[1].verifyUrl).searchParams.get("token");
  assert.ok(token && token.length >= 20);

  const verify = await api("/api/v1/auth/verify-email", {
    method: "POST",
    body: { token },
  });
  assert.equal(verify.status, 200);

  const me = await api("/api/v1/auth/me", { cookie });
  assert.equal((await me.json()).data.user.profile.emailVerified, true);

  const reused = await api("/api/v1/auth/verify-email", {
    method: "POST",
    body: { token },
  });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error.code, "invalid_verification_token");
});

test("verify-email rejects a malformed token", async () => {
  const response = await api("/api/v1/auth/verify-email", {
    method: "POST",
    body: { token: "curto" },
  });
  assert.equal(response.status, 400);
});
