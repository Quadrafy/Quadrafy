import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { MatchMessageStore } from "../src/stores/match-message-store.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

async function withTestServer(run) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-security-test-"),
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
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function api(
      pathname,
      { method = "GET", body, cookie, headers = {} } = {},
    ) {
      return fetch(`${baseUrl}${pathname}`, {
        method,
        redirect: "manual",
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== "GET" && method !== "HEAD" ? { Origin: baseUrl } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    }

    await run({ api, app, dataDirectory });
  } finally {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "the authenticated response must set a session cookie");
  return header.split(";", 1)[0];
}

async function errorFrom(response) {
  return (await response.json()).error;
}

async function registerPlayer(api, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Jogador",
      lastName: "Seguro",
      email: `security-player-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      phone: "11912345678",
      city: "Sao Paulo",
    },
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  return { cookie: cookieFrom(response), user: payload.data.user };
}

async function registerClub(api, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Responsavel Seguro",
      arenaName: `Arena Security ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `security-club-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
      phone: "11912345678",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const dashboard = await api("/api/v1/club/dashboard", { cookie });
  assert.equal(dashboard.status, 200);
  const payload = await dashboard.json();
  return { cookie, user: payload.data.user, club: payload.data.club };
}

async function createCourt(api, cookie, suffix) {
  const response = await api("/api/v1/club/courts", {
    method: "POST",
    cookie,
    body: {
      name: `Quadra Security ${suffix}`,
      type: "covered",
      price: 150,
      openTime: "08:00",
      closeTime: "12:00",
      slotDuration: 60,
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.court;
}

function futureDateKey(daysAhead = 30) {
  const value = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function bookingStartAt(dateKey, time) {
  return new Date(`${dateKey}T${time}:00-03:00`).toISOString();
}

function levelTestAnswers() {
  return {
    tempo_pratica: 2,
        frequencia_semanal: 2,
        experiencia_esportes_raquete: 2,
        autoavaliacao_golpes: 2,
        experiencia_competicoes: 2,
        tatica_posicionamento: 2,
  };
}

async function createPrivateBooking(api, cookie, { clubId, courtId, startAt }) {
  const response = await api("/api/v1/player/bookings", {
    method: "POST",
    cookie,
    body: {
      clubId,
      courtId,
      startAt,
      paymentMethod: "pix",
      visibility: "private",
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.booking;
}

test("invalid calendar dates return 422 instead of reaching slot generation", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "invalid-date");

    const publicResponse = await api(
      `/api/v1/clubs/${clubAccount.club.id}?date=2026-99-99`,
    );
    assert.equal(publicResponse.status, 422);
    assert.deepEqual((await errorFrom(publicResponse)).details, {
      field: "date",
    });

    const ownerResponse = await api("/api/v1/club/schedule?date=2026-02-31", {
      cookie: clubAccount.cookie,
    });
    assert.equal(ownerResponse.status, 422);
    assert.deepEqual((await errorFrom(ownerResponse)).details, {
      field: "date",
    });
  });
});

test("bookings more than 90 days ahead are rejected before inventory lookup", async () => {
  await withTestServer(async ({ api }) => {
    const player = await registerPlayer(api, "booking-horizon");
    const response = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: player.cookie,
      body: {
        clubId: "club-security-id",
        courtId: "court-security-id",
        startAt: new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000).toISOString(),
        paymentMethod: "venue",
        visibility: "private",
      },
    });

    assert.equal(response.status, 422);
    const error = await errorFrom(response);
    assert.equal(error.code, "booking_horizon_exceeded");
    assert.equal(error.details.field, "startAt");
    assert.equal(error.details.maximumDays, 90);
  });
});

test("an open-match creator needs an assessment and a compatible level", async () => {
  await withTestServer(async ({ api }) => {
    const player = await registerPlayer(api, "creator-level");
    const baseBody = {
      clubId: "club-security-id",
      courtId: "court-security-id",
      startAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      paymentMethod: "venue",
      visibility: "open",
      levelMin: 6,
      levelMax: 7,
    };

    const withoutAssessment = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: player.cookie,
      body: baseBody,
    });
    assert.equal(withoutAssessment.status, 409);
    assert.equal(
      (await errorFrom(withoutAssessment)).code,
      "level_assessment_required",
    );

    const assessment = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: player.cookie,
      body: levelTestAnswers(),
    });
    assert.equal(assessment.status, 200);
    const assessedLevel = (await assessment.json()).data.result.nivel_inicial;
    assert.ok(assessedLevel < baseBody.levelMin);

    const incompatibleRange = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: player.cookie,
      body: baseBody,
    });
    assert.equal(incompatibleRange.status, 409);
    assert.equal(
      (await errorFrom(incompatibleRange)).code,
      "level_not_eligible",
    );
  });
});

test("joining an open match after its start is rejected atomically", async () => {
  await withTestServer(async ({ api, app }) => {
    const player = await registerPlayer(api, "past-match");
    const match = await app.bookings.create({
      playerId: "historical-owner-id",
      clubId: "historical-club-id",
      courtId: "historical-court-id",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      price: 120,
      paymentMethod: "venue",
      visibility: "open",
      levelMin: null,
      levelMax: null,
      maxPlayers: 4,
      status: "confirmed",
    });

    const response = await api(`/api/v1/matches/${match.id}/join`, {
      method: "POST",
      cookie: player.cookie,
    });
    assert.equal(response.status, 409);
    assert.equal((await errorFrom(response)).code, "match_started");
  });
});

test("agenda conflicts and sensitive mutations produce attributable audit events", async () => {
  await withTestServer(async ({ api, dataDirectory }) => {
    const clubAccount = await registerClub(api, "audit");
    const court = await createCourt(api, clubAccount.cookie, "audit");
    const player = await registerPlayer(api, "audit");
    const date = futureDateKey(30);
    const startAt = bookingStartAt(date, "08:00");
    const booking = await createPrivateBooking(api, player.cookie, {
      clubId: clubAccount.club.id,
      courtId: court.id,
      startAt,
    });
    const dayOfWeek = new Date(`${date}T12:00:00.000Z`).getUTCDay();

    const conflictingRecurrence = await api(
      `/api/v1/club/courts/${court.id}/recurring-bookings`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: {
          clientName: "Cliente em conflito",
          startTime: "08:00",
          recurrence: { frequency: "weekly", dayOfWeek },
        },
      },
    );
    assert.equal(conflictingRecurrence.status, 409);
    assert.equal(
      (await errorFrom(conflictingRecurrence)).code,
      "recurring_booking_conflict",
    );

    const cancellationRequestId = "security-cancellation-request";
    const cancellation = await api(`/api/v1/player/bookings/${booking.id}`, {
      method: "PATCH",
      cookie: player.cookie,
      headers: { "X-Request-Id": cancellationRequestId },
      body: { status: "cancelled" },
    });
    assert.equal(cancellation.status, 200);

    const recurringCreation = await api(
      `/api/v1/club/courts/${court.id}/recurring-bookings`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        headers: { "X-Request-Id": "security-recurring-create-request" },
        body: {
          clientName: "Cliente auditavel",
          startTime: "09:00",
          recurrence: { frequency: "weekly", dayOfWeek },
        },
      },
    );
    assert.equal(recurringCreation.status, 201);
    const recurring = (await recurringCreation.json()).data.recurringBooking;

    const recurringDeleteRequestId = "security-recurring-delete-request";
    const recurringDeletion = await api(
      `/api/v1/club/recurring-bookings/${recurring.id}`,
      {
        method: "DELETE",
        cookie: clubAccount.cookie,
        headers: { "X-Request-Id": recurringDeleteRequestId },
      },
    );
    assert.equal(recurringDeletion.status, 204);

    const events = JSON.parse(
      await readFile(path.join(dataDirectory, "audit-log.json"), "utf8"),
    );
    const cancellationEvent = events.find(
      (event) =>
        event.action === "booking.cancelled" && event.resourceId === booking.id,
    );
    assert.ok(cancellationEvent);
    assert.equal(cancellationEvent.actorId, player.user.id);
    assert.equal(cancellationEvent.requestId, cancellationRequestId);
    assert.equal(cancellationEvent.before.status, "confirmed");
    assert.equal(cancellationEvent.after.status, "cancelled");

    const recurringDeleteEvent = events.find(
      (event) =>
        event.action === "recurring_booking.deleted" &&
        event.resourceId === recurring.id,
    );
    assert.ok(recurringDeleteEvent);
    assert.equal(recurringDeleteEvent.actorId, clubAccount.user.id);
    assert.equal(recurringDeleteEvent.requestId, recurringDeleteRequestId);
    assert.equal(recurringDeleteEvent.before.clientName, "Cliente auditavel");
    assert.ok(recurringDeleteEvent.after.deletedAt);
  });
});

test("chat retention keeps only the latest 1,000 messages per match", async () => {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-chat-retention-test-"),
  );
  try {
    const matchId = "retention-match";
    const otherMatchId = "unrelated-match";
    const seed = Array.from({ length: 1_000 }, (_, index) => ({
      id: `old-${String(index).padStart(4, "0")}`,
      matchId,
      playerId: "seed-player",
      content: `Mensagem ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }));
    seed.push({
      id: "unrelated-message",
      matchId: otherMatchId,
      playerId: "other-player",
      content: "Não deve ser removida",
      createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    });
    await writeFile(
      path.join(dataDirectory, "match-messages.json"),
      `${JSON.stringify(seed)}\n`,
      "utf8",
    );

    const store = new MatchMessageStore(dataDirectory);
    await store.initialize();
    const newest = await store.create({
      matchId,
      playerId: "new-player",
      content: "Mensagem mais recente",
    });

    const retained = store.listByMatch(matchId, { limit: 2_000 });
    assert.equal(retained.length, 1_000);
    assert.equal(retained[0].id, "old-0001");
    assert.equal(retained.at(-1).id, newest.id);
    assert.deepEqual(
      store
        .listByMatch(otherMatchId, { limit: 10 })
        .map((message) => message.id),
      ["unrelated-message"],
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
