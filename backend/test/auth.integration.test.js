import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "quadrafy-test-"));
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
  });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
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

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("player registration creates a secure session and protects dashboards", async () => {
  const password = "SenhaMuitoSegura123";
  const registration = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Ana",
      lastName: "Silva",
      email: "ANA@example.com",
      password,
      level: "Intermediário",
      city: "São Paulo",
    },
  });

  assert.equal(registration.status, 201);
  assert.match(registration.headers.get("set-cookie"), /HttpOnly/);
  assert.match(registration.headers.get("set-cookie"), /SameSite=Lax/);
  const registrationBody = await registration.json();
  assert.equal(registrationBody.data.user.email, "ana@example.com");
  assert.equal(registrationBody.data.user.role, "player");
  assert.equal(registrationBody.data.user.passwordHash, undefined);
  const cookie = cookieFrom(registration);

  const me = await api("/api/v1/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.user.profile.firstName, "Ana");

  const playerPage = await api("/dashboard-player.html", { cookie });
  assert.equal(playerPage.status, 200);
  assert.match(playerPage.headers.get("content-type"), /text\/html/);

  const forbiddenPage = await api("/dashboard-club.html", { cookie });
  assert.equal(forbiddenPage.status, 302);
  assert.equal(forbiddenPage.headers.get("location"), "/dashboard-player.html");

  const storedUsers = await readFile(
    path.join(dataDirectory, "users.json"),
    "utf8",
  );
  assert.doesNotMatch(storedUsers, new RegExp(password));
  assert.match(storedUsers, /scrypt\$/);

  const logout = await api("/api/v1/auth/logout", {
    method: "POST",
    cookie,
  });
  assert.equal(logout.status, 204);

  const afterLogout = await api("/api/v1/auth/me", { cookie });
  assert.equal(afterLogout.status, 401);
});

test("club account receives only club access and can log in again", async () => {
  const registration = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Rafael Martins",
      arenaName: "Arena Horizonte",
      cnpj: "12.345.678/0001-90",
      email: "gestao@horizonte.com.br",
      password: "OutraSenhaSegura123",
    },
  });
  assert.equal(registration.status, 201);
  const cookie = cookieFrom(registration);

  const clubDashboard = await api("/api/v1/club/dashboard", { cookie });
  assert.equal(clubDashboard.status, 200);
  const dashboardBody = await clubDashboard.json();
  assert.equal(dashboardBody.data.identity.arenaName, "Arena Horizonte");

  const playerApi = await api("/api/v1/player/dashboard", { cookie });
  assert.equal(playerApi.status, 403);

  const login = await api("/api/v1/auth/login", {
    method: "POST",
    body: {
      email: "gestao@horizonte.com.br",
      password: "OutraSenhaSegura123",
    },
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).data.redirectTo, "/dashboard-club.html");
});

test("invalid credentials, duplicate e-mail and anonymous access use honest errors", async () => {
  const anonymous = await api("/dashboard-player.html");
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get("location"), /^\/login\.html/);

  const invalidLogin = await api("/api/v1/auth/login", {
    method: "POST",
    body: { email: "ana@example.com", password: "SenhaIncorreta999" },
  });
  assert.equal(invalidLogin.status, 401);
  const invalidBody = await invalidLogin.json();
  assert.equal(invalidBody.error.code, "invalid_credentials");
  assert.ok(invalidBody.error.requestId);

  const duplicate = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Outra",
      lastName: "Pessoa",
      email: "ana@example.com",
      password: "SenhaDuplicada123",
      level: "Iniciante",
      city: "Campinas",
    },
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "email_already_registered");
});

test("login throttles one IP even when the attacker rotates e-mail addresses", async () => {
  const isolatedDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-rate-limit-test-"),
  );
  const isolatedApp = await createApp({
    environment: "test",
    dataDirectory: isolatedDataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
  });
  const isolatedServer = createServer(isolatedApp.handler);

  try {
    await new Promise((resolve) =>
      isolatedServer.listen(0, "127.0.0.1", resolve),
    );
    const address = isolatedServer.address();
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;
    let blockedResponse;

    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await fetch(`${isolatedBaseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: isolatedBaseUrl,
        },
        body: JSON.stringify({
          email: `rotating-${attempt}@example.com`,
          password: "SenhaIncorreta999",
        }),
      });

      if (attempt === 30) {
        blockedResponse = response;
        break;
      }
      assert.equal(
        response.status,
        401,
        `expected login attempt ${attempt + 1} to remain available`,
      );
    }

    assert.equal(blockedResponse.status, 429);
    assert.equal((await blockedResponse.json()).error.code, "rate_limited");
    assert.match(blockedResponse.headers.get("retry-after"), /^\d+$/);
  } finally {
    if (isolatedServer.listening) {
      await new Promise((resolve) => isolatedServer.close(resolve));
    }
    await rm(isolatedDataDirectory, { recursive: true, force: true });
  }
});
