import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let dataDirectory;
let server;
let baseUrl;

beforeEach(async () => {
  dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-upload-test-"),
  );
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
    anthropicApiKey: "",
  });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dataDirectory, { recursive: true, force: true });
});

async function api(pathname, { method = "GET", body, cookie } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "GET" || method === "HEAD" ? {} : { Origin: baseUrl }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  return header.split(";", 1)[0];
}

async function registerPlayer(suffix = "principal") {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Ana",
      lastName: "Silva",
      email: `upload-player-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      city: "Sao Paulo",
    },
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  return { cookie: cookieFrom(response), user: payload.data.user };
}

async function registerClub(suffix = "principal") {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: `Arena Upload ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `upload-club-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
    },
  });
  assert.equal(response.status, 201);
  return { cookie: cookieFrom(response), user: (await response.json()).data.user };
}

test("player uploads a PNG through the public API and the image is publicly served", async () => {
  const account = await registerPlayer();
  const upload = await api("/api/v1/uploads/image", {
    method: "POST",
    cookie: account.cookie,
    body: {
      type: "player",
      mimeType: "image/png",
      data: PNG_BYTES.toString("base64"),
    },
  });

  assert.equal(upload.status, 201);
  const payload = await upload.json();
  const expectedUrl = `/uploads/players/${account.user.id}.png`;
  assert.equal(payload.data.url, expectedUrl);
  assert.deepEqual(
    await readFile(
      path.join(dataDirectory, "uploads", "players", `${account.user.id}.png`),
    ),
    PNG_BYTES,
  );

  const publicImage = await api(expectedUrl);
  assert.equal(publicImage.status, 200);
  assert.equal(publicImage.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), PNG_BYTES);
});

test("player profile GET returns the persisted uploaded photo URL", async () => {
  const account = await registerPlayer("profile");
  const expectedUrl = `/uploads/players/${account.user.id}.png`;
  const update = await api("/api/v1/player/profile", {
    method: "PATCH",
    cookie: account.cookie,
    body: { photoUrl: expectedUrl },
  });
  assert.equal(update.status, 200);

  const response = await api("/api/v1/player/profile", {
    cookie: account.cookie,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.profile.photoUrl, expectedUrl);
});

test("club cover upload persists in owner and public club responses", async () => {
  const account = await registerClub("cover");
  const dashboard = await api("/api/v1/club/dashboard", {
    cookie: account.cookie,
  });
  const club = (await dashboard.json()).data.club;
  const upload = await api("/api/v1/uploads/image", {
    method: "POST",
    cookie: account.cookie,
    body: {
      type: "club",
      resourceId: club.id,
      mimeType: "image/png",
      data: PNG_BYTES.toString("base64"),
    },
  });
  assert.equal(upload.status, 201);
  const photoUrl = (await upload.json()).data.url;

  const update = await api("/api/v1/club/profile", {
    method: "PATCH",
    cookie: account.cookie,
    body: {
      name: club.name,
      description: "Clube com capa pública.",
      phone: "11999999999",
      address: "Rua das Quadras, 100",
      photoUrl,
    },
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).data.club.photoUrl, photoUrl);

  const publicDetail = await api(`/api/v1/clubs/${club.id}`);
  assert.equal(publicDetail.status, 200);
  assert.equal((await publicDetail.json()).data.club.photoUrl, photoUrl);
});

test("logged player reads only the public profile fields of another player", async () => {
  const target = await registerPlayer("public-target");
  const viewer = await registerPlayer("public-viewer");
  const photoUrl = `/uploads/players/${target.user.id}.png`;
  await api("/api/v1/player/profile", {
    method: "PATCH",
    cookie: target.cookie,
    body: { city: "Curitiba", photoUrl },
  });
  const levelTest = await api("/api/v1/player/level-test", {
    method: "POST",
    cookie: target.cookie,
    body: {
      tempo_pratica: 2,
        frequencia_semanal: 2,
        experiencia_esportes_raquete: 2,
        autoavaliacao_golpes: 2,
        experiencia_competicoes: 2,
        tatica_posicionamento: 2,
    },
  });
  assert.equal(levelTest.status, 200);

  const response = await api(`/api/v1/players/${target.user.id}/profile`, {
    cookie: viewer.cookie,
  });
  assert.equal(response.status, 200);
  const player = (await response.json()).data.player;
  assert.equal(player.displayName, "Ana Silva");
  assert.equal(player.city, "Curitiba");
  assert.equal(player.photoUrl, photoUrl);
  assert.equal(typeof player.level, "number");
  assert.equal(typeof player.stats.matchesPlayed, "number");
  assert.equal(player.stats.winRate, null);
  assert.equal("email" in player, false);
  assert.equal("profile" in player, false);
});
