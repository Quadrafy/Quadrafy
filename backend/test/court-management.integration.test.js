import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

let dataDirectory;
let server;
let baseUrl;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "quadrafy-court-test-"));
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
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function register(role, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body:
      role === "club"
        ? {
            role,
            responsibleName: "Gestora Quadrafy",
            arenaName: "Arena Teste",
            cnpj: "12.345.678/0001-90",
            email: `court-club-${suffix}@example.com`,
            password: "SenhaSeguraClube123",
          }
        : {
            role,
            firstName: "Ana",
            lastName: "Silva",
            city: "São Paulo",
            email: `court-player-${suffix}@example.com`,
            password: "SenhaSeguraJogador123",
          },
  });
  assert.equal(response.status, 201);
  return {
    cookie: cookieFrom(response),
    user: (await response.json()).data.user,
  };
}

function futureStart(days = 30) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return new Date(`${key}T19:00:00-03:00`).toISOString();
}

test("club edits every public court field including its uploaded photo", async () => {
  const owner = await register("club", "edit");
  await api("/api/v1/club/dashboard", { cookie: owner.cookie });
  const createdResponse = await api("/api/v1/club/courts", {
    method: "POST",
    cookie: owner.cookie,
    body: {
      name: "Quadra A",
      type: "covered",
      price: 120,
      openTime: "07:00",
      closeTime: "22:00",
      slotDuration: 60,
    },
  });
  const court = (await createdResponse.json()).data.court;
  const photoUrl = `/uploads/courts/${court.id}.png`;

  const response = await api(`/api/v1/club/courts/${court.id}`, {
    method: "PATCH",
    cookie: owner.cookie,
    body: {
      name: "Quadra Central",
      type: "outdoor",
      price: 175,
      openTime: "08:00",
      closeTime: "23:00",
      slotDuration: 90,
      photoUrl,
    },
  });

  assert.equal(response.status, 200);
  const updated = (await response.json()).data.court;
  assert.equal(updated.id, court.id);
  assert.equal(updated.clubId, court.clubId);
  assert.equal(updated.name, "Quadra Central");
  assert.equal(updated.type, "outdoor");
  assert.equal(updated.price, 175);
  assert.equal(updated.openTime, "08:00");
  assert.equal(updated.closeTime, "23:00");
  assert.equal(updated.slotDuration, 90);
  assert.equal(updated.opensAt, "08:00");
  assert.equal(updated.closesAt, "23:00");
  assert.equal(updated.slotDurationMinutes, 90);
  assert.equal(updated.photoUrl, photoUrl);
});

test("court deletion reports and cancels future bookings after explicit confirmation", async () => {
  const owner = await register("club", "delete");
  const dashboard = await api("/api/v1/club/dashboard", {
    cookie: owner.cookie,
  });
  const club = (await dashboard.json()).data.club;
  const createdResponse = await api("/api/v1/club/courts", {
    method: "POST",
    cookie: owner.cookie,
    body: {
      name: "Quadra para excluir",
      type: "covered",
      price: 130,
      openTime: "07:00",
      closeTime: "22:00",
      slotDuration: 60,
    },
  });
  const court = (await createdResponse.json()).data.court;
  const player = await register("player", "booking");
  const bookingResponse = await api("/api/v1/player/bookings", {
    method: "POST",
    cookie: player.cookie,
    body: {
      clubId: club.id,
      courtId: court.id,
      startAt: futureStart(),
      paymentMethod: "pix",
      visibility: "private",
    },
  });
  assert.equal(bookingResponse.status, 201);

  const impact = await api(
    `/api/v1/club/courts/${court.id}/deletion-impact`,
    { cookie: owner.cookie },
  );
  assert.equal(impact.status, 200);
  assert.equal((await impact.json()).data.futureBookings, 1);

  const unconfirmed = await api(`/api/v1/club/courts/${court.id}`, {
    method: "DELETE",
    cookie: owner.cookie,
  });
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).error.details.futureBookings, 1);

  const deletion = await api(
    `/api/v1/club/courts/${court.id}?confirm=true`,
    { method: "DELETE", cookie: owner.cookie },
  );
  assert.equal(deletion.status, 204);

  const ownerCourts = await api("/api/v1/club/courts", {
    cookie: owner.cookie,
  });
  assert.deepEqual((await ownerCourts.json()).data.courts, []);
  const playerBookings = await api("/api/v1/player/bookings", {
    cookie: player.cookie,
  });
  assert.equal(
    (await playerBookings.json()).data.bookings[0].status,
    "cancelled",
  );
});
