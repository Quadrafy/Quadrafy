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

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "padelfy-google-test-"));
  // Sem credenciais do Google configuradas → provider desabilitado.
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
  });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDirectory, { recursive: true, force: true });
});

test("providers endpoint reports google disabled without credentials", async () => {
  const response = await fetch(`${baseUrl}/api/v1/auth/providers`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.google, false);
});

test("google start redirects to login when not configured", async () => {
  const response = await fetch(`${baseUrl}/api/v1/auth/google/start`, {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /login\.html\?error=google_unavailable/);
});

test("providers endpoint reports google enabled when configured", async () => {
  const isolatedDir = await mkdtemp(
    path.join(os.tmpdir(), "padelfy-google-on-"),
  );
  const app = await createApp({
    environment: "test",
    dataDirectory: isolatedDir,
    frontendDirectory,
    sessionTtlHours: 1,
    googleClientId: "test-client-id",
    googleClientSecret: "test-secret",
    appBaseUrl: "https://www.padelfy.com.br",
  });
  const isolatedServer = createServer(app.handler);
  try {
    await new Promise((resolve) =>
      isolatedServer.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${isolatedServer.address().port}`;

    const providers = await fetch(`${url}/api/v1/auth/providers`);
    assert.equal((await providers.json()).data.google, true);

    // start deve redirecionar para o Google (accounts.google.com) com state.
    const start = await fetch(`${url}/api/v1/auth/google/start`, {
      redirect: "manual",
    });
    assert.equal(start.status, 302);
    const location = start.headers.get("location");
    assert.match(location, /accounts\.google\.com/);
    assert.match(location, /client_id=test-client-id/);
    assert.match(start.headers.get("set-cookie"), /padelfy_oauth_state=/);
  } finally {
    await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDir, { recursive: true, force: true });
  }
});
