import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

async function withTestServer(run) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-club-profile-test-"),
  );
  let server;

  try {
    const app = await createApp({
      environment: "test",
      dataDirectory,
      frontendDirectory,
      sessionTtlHours: 1,
      anthropicApiKey: "",
    });
    server = createServer(app.handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const api = (pathname, { method = "GET", body, cookie } = {}) =>
      fetch(`${baseUrl}${pathname}`, {
        method,
        redirect: "manual",
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== "GET" && method !== "HEAD" ? { Origin: baseUrl } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    await run({ api, dataDirectory });
  } finally {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function sessionCookie(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  return header.split(";", 1)[0];
}

test("club owner saves public arena information and exposes its address", async () => {
  await withTestServer(async ({ api, dataDirectory }) => {
    const registration = await api("/api/v1/auth/register", {
      method: "POST",
      body: {
        role: "club",
        responsibleName: "Marina Costa",
        arenaName: "Arena Antiga",
        cnpj: "12.345.678/0001-90",
        email: "perfil-clube@example.com",
        password: "SenhaSeguraClube123",
      },
    });
    assert.equal(registration.status, 201);
    const cookie = sessionCookie(registration);
    const dashboard = await api("/api/v1/club/dashboard", { cookie });
    const clubId = (await dashboard.json()).data.club.id;

    const update = await api("/api/v1/club/profile", {
      method: "PATCH",
      cookie,
      body: {
        name: "Arena Quadrafy Paulista",
        description: "Quatro quadras cobertas e estacionamento no local.",
        phone: "(11) 99999-1234",
        address: "Alameda Santos, 1000 - Bela Vista, São Paulo - SP",
      },
    });

    assert.equal(update.status, 200);
    const updatedClub = (await update.json()).data.club;
    assert.equal(updatedClub.name, "Arena Quadrafy Paulista");
    assert.equal(
      updatedClub.description,
      "Quatro quadras cobertas e estacionamento no local.",
    );
    assert.equal(updatedClub.phone, "(11) 99999-1234");
    assert.equal(
      updatedClub.address,
      "Alameda Santos, 1000 - Bela Vista, São Paulo - SP",
    );

    const publicDetail = await api(`/api/v1/clubs/${clubId}`);
    assert.equal(publicDetail.status, 200);
    const publicClub = (await publicDetail.json()).data.club;
    assert.equal(publicClub.name, updatedClub.name);
    assert.equal(publicClub.address, updatedClub.address);

    const persisted = JSON.parse(
      await readFile(path.join(dataDirectory, "clubs.json"), "utf8"),
    );
    assert.equal(persisted[0].address, updatedClub.address);
  });
});

test("club profile rejects an empty public address", async () => {
  await withTestServer(async ({ api }) => {
    const registration = await api("/api/v1/auth/register", {
      method: "POST",
      body: {
        role: "club",
        responsibleName: "Marina Costa",
        arenaName: "Arena Validação",
        cnpj: "12.345.678/0001-90",
        email: "perfil-invalido@example.com",
        password: "SenhaSeguraClube123",
      },
    });
    const cookie = sessionCookie(registration);

    const response = await api("/api/v1/club/profile", {
      method: "PATCH",
      cookie,
      body: {
        name: "Arena Validação",
        description: "",
        phone: "",
        address: "",
      },
    });

    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.details.field, "address");
  });
});
