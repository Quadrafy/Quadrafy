import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

test("permite a origem do Vercel em mutações e bloqueia origens não listadas", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "padelfy-origin-"));
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    allowedOrigins: ["https://padelfy.vercel.app"],
  });
  const server = createServer(app.handler);

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/v1/auth/register`;
    const body = {
      role: "player",
      firstName: "Origem",
      lastName: "Confiável",
      email: "origem-confiavel@example.com",
      password: "SenhaSeguraOrigem123",
      phone: "11912345678",
      city: "São Paulo",
    };

    const trusted = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://padelfy.vercel.app",
      },
      body: JSON.stringify(body),
    });
    assert.equal(trusted.status, 201);

    const untrusted = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://malicioso.example",
      },
      body: JSON.stringify({ ...body, email: "origem-maliciosa@example.com" }),
    });
    assert.equal(untrusted.status, 403);
    assert.equal((await untrusted.json()).error.code, "invalid_origin");
  } finally {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
