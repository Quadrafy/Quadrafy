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
    path.join(os.tmpdir(), "quadrafy-part2-test-"),
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

    await run({ api, dataDirectory });
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

async function registerPlayer(api, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Ana",
      lastName: "Silva",
      email: `jogador-parte2-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
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
      responsibleName: "Marina Costa",
      arenaName: `Arena Parte 2 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-parte2-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const dashboard = await api("/api/v1/club/dashboard", { cookie });
  assert.equal(dashboard.status, 200);
  const payload = await dashboard.json();
  return { cookie, user: payload.data.user, club: payload.data.club };
}

async function createLegacyCourt(api, clubCookie, suffix = "principal") {
  const response = await api("/api/v1/club/courts", {
    method: "POST",
    cookie: clubCookie,
    body: {
      name: `Quadra Parte 2 ${suffix}`,
      type: "covered",
      price: 160,
      opensAt: "06:00",
      closesAt: "23:00",
      slotDurationMinutes: 60,
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.court;
}

function futureDateKey(daysAhead = 30) {
  const value = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
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

async function createBooking(
  api,
  playerCookie,
  { clubId, courtId, startAt, visibility = "private" },
) {
  const response = await api("/api/v1/player/bookings", {
    method: "POST",
    cookie: playerCookie,
    body: {
      clubId,
      courtId,
      startAt,
      paymentMethod: "pix",
      visibility,
      ...(visibility === "open"
        ? {
            levelMin: 0.5,
            levelMax: 7,
            levelRange: "0.50 - 7.00",
            availableSpots: 3,
          }
        : {}),
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.booking;
}

test("club owner updates a recurring booking through the public API with an attributable audit event", async () => {
  await withTestServer(async ({ api, dataDirectory }) => {
    const clubAccount = await registerClub(api, "editar-recorrencia");
    const court = await createLegacyCourt(
      api,
      clubAccount.cookie,
      "editar-recorrencia",
    );
    const targetCourtResponse = await api("/api/v1/club/courts", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Quadra destino 90 minutos",
        type: "covered",
        price: 190,
        openTime: "06:00",
        closeTime: "23:00",
        slotDuration: 90,
      },
    });
    assert.equal(targetCourtResponse.status, 201);
    const targetCourt = (await targetCourtResponse.json()).data.court;
    const weeklyCreation = await api(
      `/api/v1/club/courts/${court.id}/recurring-bookings`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: {
          clientName: "Cliente original",
          startTime: "19:00",
          recurrence: { frequency: "weekly", dayOfWeek: 2 },
        },
      },
    );
    assert.equal(weeklyCreation.status, 201);
    const original = (await weeklyCreation.json()).data.recurringBooking;
    const requestId = "part2-recurring-update-request";

    const updateResponse = await api(
      `/api/v1/club/recurring-bookings/${original.id}`,
      {
        method: "PATCH",
        cookie: clubAccount.cookie,
        headers: { "X-Request-Id": requestId },
        body: {
          courtId: targetCourt.id,
          clientName: "Cliente atualizado",
          startTime: "19:30",
          recurrence: { frequency: "monthly", dayOfMonth: 15 },
        },
      },
    );

    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json()).data.recurringBooking;
    assert.equal(updated.id, original.id);
    assert.equal(updated.clubId, original.clubId);
    assert.equal(updated.courtId, targetCourt.id);
    assert.equal(updated.courtName, targetCourt.name);
    assert.equal(updated.createdAt, original.createdAt);
    assert.notEqual(updated.updatedAt, original.updatedAt);
    assert.equal(updated.clientName, "Cliente atualizado");
    assert.equal(updated.startTime, "19:30");
    assert.deepEqual(updated.recurrence, {
      frequency: "monthly",
      dayOfMonth: 15,
    });

    const events = JSON.parse(
      await readFile(path.join(dataDirectory, "audit-log.json"), "utf8"),
    );
    const updateEvent = events.find(
      (event) =>
        event.action === "recurring_booking.updated" &&
        event.resourceId === original.id,
    );
    assert.ok(updateEvent);
    assert.equal(updateEvent.actorId, clubAccount.user.id);
    assert.equal(updateEvent.requestId, requestId);
    assert.equal(updateEvent.before.clientName, "Cliente original");
    assert.equal(updateEvent.before.startTime, "19:00");
    assert.equal(updateEvent.before.courtId, court.id);
    assert.equal(updateEvent.after.clientName, "Cliente atualizado");
    assert.equal(updateEvent.after.startTime, "19:30");
    assert.equal(updateEvent.after.courtId, targetCourt.id);
  });
});

test("recurring booking update rejects a duplicate agenda without changing the original", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "editar-duplicata");
    const court = await createLegacyCourt(
      api,
      clubAccount.cookie,
      "editar-duplicata",
    );
    const date = futureDateKey(45);
    const dayOfWeek = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    async function createRecurring(body) {
      const response = await api(
        `/api/v1/club/courts/${court.id}/recurring-bookings`,
        { method: "POST", cookie: clubAccount.cookie, body },
      );
      assert.equal(response.status, 201);
      return (await response.json()).data.recurringBooking;
    }
    const original = await createRecurring({
      clientName: "Cliente original",
      startTime: "19:00",
      recurrence: { frequency: "weekly", dayOfWeek },
    });
    await createRecurring({
      clientName: "Cliente destino",
      startTime: "20:00",
      recurrence: { frequency: "weekly", dayOfWeek },
    });

    const duplicateUpdate = await api(
      `/api/v1/club/recurring-bookings/${original.id}`,
      {
        method: "PATCH",
        cookie: clubAccount.cookie,
        body: {
          courtId: court.id,
          clientName: "Não deve persistir",
          startTime: "20:00",
          recurrence: { frequency: "weekly", dayOfWeek },
        },
      },
    );

    assert.equal(duplicateUpdate.status, 409);
    assert.equal(
      (await duplicateUpdate.json()).error.code,
      "recurring_booking_conflict",
    );
    const scheduleResponse = await api(`/api/v1/club/schedule?date=${date}`, {
      cookie: clubAccount.cookie,
    });
    assert.equal(scheduleResponse.status, 200);
    const persisted = (await scheduleResponse.json()).data.recurringBookings;
    assert.equal(
      persisted.find((entry) => entry.id === original.id)?.clientName,
      "Cliente original",
    );
  });
});

test("weekly and monthly recurrences cannot overlap on the same court and time", async () => {
  await withTestServer(async ({ api }) => {
    const owner = await registerClub(api, "recorrencia-cruzada");
    const court = await createLegacyCourt(
      api,
      owner.cookie,
      "recorrencia-cruzada",
    );

    const weekly = await api(
      `/api/v1/club/courts/${court.id}/recurring-bookings`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: {
          clientName: "Cliente Semanal",
          startTime: "19:00",
          recurrence: { frequency: "weekly", dayOfWeek: 1 },
        },
      },
    );
    assert.equal(weekly.status, 201);

    const monthly = await api(
      `/api/v1/club/courts/${court.id}/recurring-bookings`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: {
          clientName: "Cliente Mensal",
          startTime: "19:00",
          recurrence: { frequency: "monthly", dayOfMonth: 15 },
        },
      },
    );

    assert.equal(monthly.status, 409);
    assert.equal(
      (await monthly.json()).error.code,
      "recurring_booking_conflict",
    );
  });
});

test("club schedule exposes a consolidated seven-day view", async () => {
  await withTestServer(async ({ api }) => {
    const owner = await registerClub(api, "grade-semanal");
    const court = await createLegacyCourt(api, owner.cookie, "grade-semanal");
    const from = futureDateKey(30);

    const response = await api(
      "/api/v1/club/schedule?date=" + from + "&period=week",
      { cookie: owner.cookie },
    );

    assert.equal(response.status, 200);
    const schedule = (await response.json()).data;
    const expectedLastDate = new Date(from + "T12:00:00.000Z");
    expectedLastDate.setUTCDate(expectedLastDate.getUTCDate() + 6);
    assert.equal(schedule.period, "week");
    assert.equal(schedule.from, from);
    assert.equal(schedule.to, expectedLastDate.toISOString().slice(0, 10));
    assert.equal(schedule.days.length, 7);
    assert.equal(schedule.days[0].date, from);
    assert.equal(schedule.days.at(-1).date, schedule.to);
    assert.equal(schedule.days[0].courts[0].courtId, court.id);
    assert.ok(schedule.days.every((day) => Array.isArray(day.courts)));

    const invalid = await api(
      "/api/v1/club/schedule?date=" + from + "&period=month",
      { cookie: owner.cookie },
    );
    assert.equal(invalid.status, 422);
  });
});

test("recurring booking update rejects a confirmed one-off booking conflict", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "editar-conflito-avulso");
    const court = await createLegacyCourt(
      api,
      clubAccount.cookie,
      "editar-conflito-avulso",
    );
    const player = await registerPlayer(api, "editar-conflito-avulso");
    const date = futureDateKey(30);
    const dayOfWeek = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    const creation = await api(
      `/api/v1/club/courts/${court.id}/recurring-bookings`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: {
          clientName: "Cliente recorrente",
          startTime: "19:00",
          recurrence: { frequency: "weekly", dayOfWeek },
        },
      },
    );
    assert.equal(creation.status, 201);
    const recurring = (await creation.json()).data.recurringBooking;
    await createBooking(api, player.cookie, {
      clubId: clubAccount.club.id,
      courtId: court.id,
      startAt: bookingStartAt(date, "20:00"),
    });

    const conflictingUpdate = await api(
      `/api/v1/club/recurring-bookings/${recurring.id}`,
      {
        method: "PATCH",
        cookie: clubAccount.cookie,
        body: {
          courtId: court.id,
          clientName: "Cliente não alterado",
          startTime: "20:00",
          recurrence: { frequency: "weekly", dayOfWeek },
        },
      },
    );

    assert.equal(conflictingUpdate.status, 409);
    assert.equal(
      (await conflictingUpdate.json()).error.code,
      "recurring_booking_conflict",
    );
    const scheduleResponse = await api(`/api/v1/club/schedule?date=${date}`, {
      cookie: clubAccount.cookie,
    });
    assert.equal(scheduleResponse.status, 200);
    const schedule = (await scheduleResponse.json()).data;
    const originalSlot = schedule.courts
      .find((entry) => entry.courtId === court.id)
      .slots.find((slot) => slot.time === "19:00");
    assert.equal(originalSlot.recurringBooking.id, recurring.id);
    assert.equal(
      originalSlot.recurringBooking.clientName,
      "Cliente recorrente",
    );
  });
});

test("recurring booking update is restricted to its owner and a complete valid target court slot", async () => {
  await withTestServer(async ({ api }) => {
    const owner = await registerClub(api, "editar-seguranca-dono");
    const ownerCourt = await createLegacyCourt(
      api,
      owner.cookie,
      "editar-seguranca-dono",
    );
    const outsider = await registerClub(api, "editar-seguranca-terceiro");
    const outsiderCourt = await createLegacyCourt(
      api,
      outsider.cookie,
      "editar-seguranca-terceiro",
    );
    const creation = await api(
      `/api/v1/club/courts/${ownerCourt.id}/recurring-bookings`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: {
          clientName: "Cliente protegido",
          startTime: "19:00",
          recurrence: { frequency: "weekly", dayOfWeek: 2 },
        },
      },
    );
    assert.equal(creation.status, 201);
    const recurring = (await creation.json()).data.recurringBooking;
    const validBody = {
      courtId: ownerCourt.id,
      clientName: "Cliente protegido",
      startTime: "20:00",
      recurrence: { frequency: "monthly", dayOfMonth: 10 },
    };

    const outsiderUpdate = await api(
      `/api/v1/club/recurring-bookings/${recurring.id}`,
      {
        method: "PATCH",
        cookie: outsider.cookie,
        body: { ...validBody, courtId: outsiderCourt.id },
      },
    );
    assert.equal(outsiderUpdate.status, 404);
    assert.equal(
      (await outsiderUpdate.json()).error.code,
      "recurring_booking_not_found",
    );

    const foreignCourtUpdate = await api(
      `/api/v1/club/recurring-bookings/${recurring.id}`,
      {
        method: "PATCH",
        cookie: owner.cookie,
        body: { ...validBody, courtId: outsiderCourt.id },
      },
    );
    assert.equal(foreignCourtUpdate.status, 404);
    assert.equal(
      (await foreignCourtUpdate.json()).error.code,
      "court_not_found",
    );

    const incompleteUpdate = await api(
      `/api/v1/club/recurring-bookings/${recurring.id}`,
      {
        method: "PATCH",
        cookie: owner.cookie,
        body: {
          clientName: "Sem quadra",
          startTime: "20:00",
          recurrence: { frequency: "monthly", dayOfMonth: 10 },
        },
      },
    );
    assert.equal(incompleteUpdate.status, 422);
    assert.equal(
      (await incompleteUpdate.json()).error.code,
      "validation_failed",
    );

    const misalignedSlotUpdate = await api(
      `/api/v1/club/recurring-bookings/${recurring.id}`,
      {
        method: "PATCH",
        cookie: owner.cookie,
        body: { ...validBody, startTime: "19:30" },
      },
    );
    assert.equal(misalignedSlotUpdate.status, 422);
    assert.equal(
      (await misalignedSlotUpdate.json()).error.code,
      "invalid_slot",
    );

    const deactivation = await api(`/api/v1/club/courts/${ownerCourt.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { active: false },
    });
    assert.equal(deactivation.status, 200);
    const inactiveCourtUpdate = await api(
      `/api/v1/club/recurring-bookings/${recurring.id}`,
      { method: "PATCH", cookie: owner.cookie, body: validBody },
    );
    assert.equal(inactiveCourtUpdate.status, 404);
    assert.equal(
      (await inactiveCourtUpdate.json()).error.code,
      "court_not_found",
    );
  });
});

test("player edits the persisted profile and receives a deterministic level fallback without an API key", async () => {
  await withTestServer(async ({ api }) => {
    const firstPlayer = await registerPlayer(api, "perfil-um");
    const profileUpdate = await api("/api/v1/player/profile", {
      method: "PATCH",
      cookie: firstPlayer.cookie,
      body: {
        firstName: "Marina",
        lastName: "Costa",
        city: "Campinas",
        preferredSide: "drive",
        dominantHand: "right",
        availability: "Noites e fins de semana",
        playStyle: "competitivo",
      },
    });

    assert.equal(profileUpdate.status, 200);
    const updatedUser = (await profileUpdate.json()).data.user;
    assert.deepEqual(
      {
        firstName: updatedUser.profile.firstName,
        lastName: updatedUser.profile.lastName,
        city: updatedUser.profile.city,
        preferredSide: updatedUser.profile.preferredSide,
        dominantHand: updatedUser.profile.dominantHand,
        availability: updatedUser.profile.availability,
        playStyle: updatedUser.profile.playStyle,
      },
      {
        firstName: "Marina",
        lastName: "Costa",
        city: "Campinas",
        preferredSide: "drive",
        dominantHand: "right",
        availability: "Noites e fins de semana",
        playStyle: "competitivo",
      },
    );

    const persistedProfile = await api("/api/v1/auth/me", {
      cookie: firstPlayer.cookie,
    });
    assert.equal(persistedProfile.status, 200);
    assert.equal(
      (await persistedProfile.json()).data.user.profile.firstName,
      "Marina",
    );

    const answers = levelTestAnswers();
    const firstLevelTest = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: firstPlayer.cookie,
      body: answers,
    });

    assert.equal(firstLevelTest.status, 200);
    const firstLevelPayload = (await firstLevelTest.json()).data;
    assert.equal(typeof firstLevelPayload.result.nivel_inicial, "number");
    assert.equal(
      typeof firstLevelPayload.result.confiabilidade_inicial,
      "number",
    );
    assert.equal(typeof firstLevelPayload.result.categoria_sugerida, "string");
    assert.ok(firstLevelPayload.result.analise_tecnica.length > 0);
    assert.equal(
      firstLevelPayload.user.profile.level,
      firstLevelPayload.result.nivel_inicial,
    );
    assert.equal(
      firstLevelPayload.user.profile.levelConfidence,
      firstLevelPayload.result.confiabilidade_inicial,
    );
    assert.equal(
      firstLevelPayload.user.profile.levelCategory,
      firstLevelPayload.result.categoria_sugerida,
    );

    const secondPlayer = await registerPlayer(api, "perfil-dois");
    const secondLevelTest = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: secondPlayer.cookie,
      body: answers,
    });
    assert.equal(secondLevelTest.status, 200);
    const secondResult = (await secondLevelTest.json()).data.result;
    assert.deepEqual(
      secondResult,
      firstLevelPayload.result,
      "without an Anthropic key, equal answers must produce equal fallback results",
    );
  });
});

test("match chat is visible and writable only to confirmed participants", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "chat");
    const court = await createLegacyCourt(api, clubAccount.cookie, "chat");
    const creator = await registerPlayer(api, "chat-criador");
    const participant = await registerPlayer(api, "chat-participante");
    const outsider = await registerPlayer(api, "chat-forasteiro");
    const creatorLevel = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: creator.cookie,
      body: levelTestAnswers(),
    });
    assert.equal(creatorLevel.status, 200);
    const match = await createBooking(api, creator.cookie, {
      clubId: clubAccount.club.id,
      courtId: court.id,
      startAt: bookingStartAt(futureDateKey(30), "19:00"),
      visibility: "open",
    });

    const outsiderReading = await api(`/api/v1/matches/${match.id}/messages`, {
      cookie: outsider.cookie,
    });
    assert.equal(outsiderReading.status, 403);

    const outsiderWriting = await api(`/api/v1/matches/${match.id}/messages`, {
      method: "POST",
      cookie: outsider.cookie,
      body: { content: "Não deveria ser publicada" },
    });
    assert.equal(outsiderWriting.status, 403);

    const creatorMessageResponse = await api(
      `/api/v1/matches/${match.id}/messages`,
      {
        method: "POST",
        cookie: creator.cookie,
        body: { content: "Encontro vocês quinze minutos antes." },
      },
    );
    assert.equal(creatorMessageResponse.status, 201);
    const creatorMessage = (await creatorMessageResponse.json()).data.message;
    assert.equal(creatorMessage.matchId, match.id);
    assert.equal(creatorMessage.playerId, creator.user.id);
    assert.equal(
      creatorMessage.content,
      "Encontro vocês quinze minutos antes.",
    );
    assert.ok(creatorMessage.id);
    assert.ok(creatorMessage.createdAt);

    const participantLevel = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: participant.cookie,
      body: levelTestAnswers(),
    });
    assert.equal(participantLevel.status, 200);

    const join = await api(`/api/v1/matches/${match.id}/join`, {
      method: "POST",
      cookie: participant.cookie,
    });
    assert.equal(join.status, 200);

    const participantReading = await api(
      `/api/v1/matches/${match.id}/messages`,
      { cookie: participant.cookie },
    );
    assert.equal(participantReading.status, 200);
    const messagePage = (await participantReading.json()).data;
    assert.deepEqual(
      messagePage.messages.map((message) => message.id),
      [creatorMessage.id],
    );
    assert.equal(messagePage.nextCursor, null);

    const participantMessageResponse = await api(
      `/api/v1/matches/${match.id}/messages`,
      {
        method: "POST",
        cookie: participant.cookie,
        body: { content: "Combinado. Até lá." },
      },
    );
    assert.equal(participantMessageResponse.status, 201);
    assert.equal(
      (await participantMessageResponse.json()).data.message.playerId,
      participant.user.id,
    );
  });
});

test("booking detail supports opening with three fixed spots, protects participants and cancels", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "detalhe-reserva");
    const court = await createLegacyCourt(
      api,
      clubAccount.cookie,
      "detalhe-reserva",
    );
    const owner = await registerPlayer(api, "reserva-dono");
    const participant = await registerPlayer(api, "reserva-participante");
    const date = futureDateKey(40);
    const startAt = bookingStartAt(date, "18:00");
    const booking = await createBooking(api, owner.cookie, {
      clubId: clubAccount.club.id,
      courtId: court.id,
      startAt,
    });

    const detailResponse = await api(`/api/v1/player/bookings/${booking.id}`, {
      cookie: owner.cookie,
    });
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()).data.booking;
    assert.equal(detail.id, booking.id);
    assert.equal(detail.clubId, clubAccount.club.id);
    assert.equal(detail.courtId, court.id);
    assert.equal(detail.startAt, startAt);
    assert.equal(detail.price, 160);
    assert.equal(detail.paymentMethod, "pix");
    assert.equal(detail.status, "confirmed");
    assert.equal(detail.visibility, "private");
    assert.equal(detail.canCancel, true);
    assert.ok(detail.cancellableUntil);

    const privateDetailLeak = await api(
      `/api/v1/player/bookings/${booking.id}`,
      { cookie: participant.cookie },
    );
    assert.equal(privateDetailLeak.status, 404);

    const levelResponse = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: participant.cookie,
      body: levelTestAnswers(),
    });
    assert.equal(levelResponse.status, 200);
    const participantLevel = (await levelResponse.json()).data.result
      .nivel_inicial;
    const ownerLevelResponse = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: owner.cookie,
      body: levelTestAnswers(),
    });
    assert.equal(ownerLevelResponse.status, 200);
    const levelMin = Math.max(0, participantLevel - 0.5);
    const levelMax = Math.min(7, participantLevel + 0.5);

    const openResponse = await api(`/api/v1/player/bookings/${booking.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        visibility: "open",
        levelMin,
        levelMax,
        availableSpots: 1,
      },
    });
    assert.equal(openResponse.status, 200);
    const openedBooking = (await openResponse.json()).data.booking;
    assert.equal(openedBooking.visibility, "open");
    assert.equal(openedBooking.levelMin, levelMin);
    assert.equal(openedBooking.levelMax, levelMax);
    assert.equal(openedBooking.maxPlayers, 4);
    assert.equal(openedBooking.openSpots, 3);

    const openMatches = await api("/api/v1/matches", {
      cookie: participant.cookie,
    });
    assert.equal(openMatches.status, 200);
    assert.ok(
      (await openMatches.json()).data.matches.some(
        (candidate) => candidate.id === booking.id,
      ),
    );

    const join = await api(`/api/v1/matches/${booking.id}/join`, {
      method: "POST",
      cookie: participant.cookie,
    });
    assert.equal(join.status, 200);

    const participantMutation = await api(
      `/api/v1/player/bookings/${booking.id}`,
      {
        method: "PATCH",
        cookie: participant.cookie,
        body: { visibility: "private" },
      },
    );
    assert.equal(participantMutation.status, 404);

    const privateAgain = await api(`/api/v1/player/bookings/${booking.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { visibility: "private" },
    });
    assert.equal(privateAgain.status, 409);
    assert.equal(
      (await privateAgain.json()).error.code,
      "booking_has_participants",
    );

    const cancellation = await api(`/api/v1/player/bookings/${booking.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { status: "cancelled" },
    });
    assert.equal(cancellation.status, 200);
    const cancelledBooking = (await cancellation.json()).data.booking;
    assert.equal(cancelledBooking.status, "cancelled");
    assert.equal(cancelledBooking.canCancel, false);

    const cancelledMatch = await api(`/api/v1/matches/${booking.id}`, {
      cookie: owner.cookie,
    });
    assert.equal(cancelledMatch.status, 404);

    const publicClub = await api(
      `/api/v1/clubs/${clubAccount.club.id}?date=${date}`,
    );
    assert.equal(publicClub.status, 200);
    const availability = (await publicClub.json()).data.availability;
    const releasedSlot = availability
      .find((item) => item.courtId === court.id)
      .slots.find((slot) => slot.startAt === startAt);
    assert.equal(releasedSlot.available, true);
  });
});

test("court creation accepts half-hour boundaries and generates only 60 or 90 minute slots", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "duracao-quadras");

    async function createCourt(body) {
      return api("/api/v1/club/courts", {
        method: "POST",
        cookie: clubAccount.cookie,
        body,
      });
    }

    const sixtyMinuteResponse = await createCourt({
      name: "Quadra Sessenta",
      type: "covered",
      price: 120,
      openTime: "06:30",
      closeTime: "09:30",
      slotDuration: 60,
    });
    assert.equal(sixtyMinuteResponse.status, 201);
    const sixtyMinuteCourt = (await sixtyMinuteResponse.json()).data.court;
    assert.equal(sixtyMinuteCourt.openTime, "06:30");
    assert.equal(sixtyMinuteCourt.closeTime, "09:30");
    assert.equal(sixtyMinuteCourt.slotDuration, 60);

    const ninetyMinuteResponse = await createCourt({
      name: "Quadra Noventa",
      type: "outdoor",
      price: 180,
      openTime: "06:30",
      closeTime: "09:30",
      slotDuration: 90,
    });
    assert.equal(ninetyMinuteResponse.status, 201);
    const ninetyMinuteCourt = (await ninetyMinuteResponse.json()).data.court;
    assert.equal(ninetyMinuteCourt.slotDuration, 90);

    const offGridTime = await createCourt({
      name: "Quadra Fora da Grade",
      type: "covered",
      price: 100,
      openTime: "06:15",
      closeTime: "09:30",
      slotDuration: 60,
    });
    assert.equal(offGridTime.status, 422);

    const unsupportedDuration = await createCourt({
      name: "Quadra Setenta e Cinco",
      type: "covered",
      price: 100,
      openTime: "06:30",
      closeTime: "09:30",
      slotDuration: 75,
    });
    assert.equal(unsupportedDuration.status, 422);

    const availabilityResponse = await api(
      `/api/v1/clubs/${clubAccount.club.id}?date=${futureDateKey(20)}`,
    );
    assert.equal(availabilityResponse.status, 200);
    const availability = (await availabilityResponse.json()).data.availability;
    const sixtyMinuteSlots = availability.find(
      (item) => item.courtId === sixtyMinuteCourt.id,
    ).slots;
    assert.deepEqual(
      sixtyMinuteSlots.map((slot) => slot.time),
      ["06:30", "07:30", "08:30"],
    );
    const ninetyMinuteSlots = availability.find(
      (item) => item.courtId === ninetyMinuteCourt.id,
    ).slots;
    assert.deepEqual(
      ninetyMinuteSlots.map((slot) => slot.time),
      ["06:30", "08:00"],
    );
  });
});

test("weekly and monthly recurring bookings consolidate the club schedule, block players and release slots on delete", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "recorrencias");
    const court = await createLegacyCourt(
      api,
      clubAccount.cookie,
      "recorrencias",
    );
    const player = await registerPlayer(api, "recorrencias");
    const date = futureDateKey(45);
    const dayOfWeek = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    const dayOfMonth = Number(date.slice(-2));

    async function createRecurring(body) {
      return api(`/api/v1/club/courts/${court.id}/recurring-bookings`, {
        method: "POST",
        cookie: clubAccount.cookie,
        body,
      });
    }

    const weeklyResponse = await createRecurring({
      clientName: "Cliente Semanal",
      startTime: "19:00",
      recurrence: { frequency: "weekly", dayOfWeek },
    });
    assert.equal(weeklyResponse.status, 201);
    const weekly = (await weeklyResponse.json()).data.recurringBooking;
    assert.equal(weekly.courtId, court.id);
    assert.equal(weekly.clientName, "Cliente Semanal");
    assert.equal(weekly.startTime, "19:00");
    assert.deepEqual(weekly.recurrence, {
      frequency: "weekly",
      dayOfWeek,
    });

    const monthlyResponse = await createRecurring({
      clientName: "Cliente Mensal",
      startTime: "20:00",
      recurrence: { frequency: "monthly", dayOfMonth },
    });
    assert.equal(monthlyResponse.status, 201);
    const monthly = (await monthlyResponse.json()).data.recurringBooking;
    assert.deepEqual(monthly.recurrence, {
      frequency: "monthly",
      dayOfMonth,
    });

    const scheduleResponse = await api(`/api/v1/club/schedule?date=${date}`, {
      cookie: clubAccount.cookie,
    });
    assert.equal(scheduleResponse.status, 200);
    const schedule = (await scheduleResponse.json()).data;
    assert.equal(schedule.date, date);
    assert.deepEqual(
      new Set(schedule.recurringBookings.map((item) => item.id)),
      new Set([weekly.id, monthly.id]),
    );
    const scheduledCourt = schedule.courts.find(
      (item) => item.courtId === court.id,
    );
    assert.equal(scheduledCourt.courtName, court.name);
    assert.equal(scheduledCourt.slotDurationMinutes, 60);
    const weeklySlot = scheduledCourt.slots.find(
      (slot) => slot.time === "19:00",
    );
    const monthlySlot = scheduledCourt.slots.find(
      (slot) => slot.time === "20:00",
    );
    assert.equal(weeklySlot.status, "recurring");
    assert.equal(weeklySlot.recurringBooking.id, weekly.id);
    assert.equal(monthlySlot.status, "recurring");
    assert.equal(monthlySlot.recurringBooking.id, monthly.id);

    const blockedAvailabilityResponse = await api(
      `/api/v1/clubs/${clubAccount.club.id}?date=${date}`,
    );
    assert.equal(blockedAvailabilityResponse.status, 200);
    const blockedCourt = (
      await blockedAvailabilityResponse.json()
    ).data.availability.find((item) => item.courtId === court.id);
    assert.equal(
      blockedCourt.slots.find((slot) => slot.time === "19:00").available,
      false,
    );
    assert.equal(
      blockedCourt.slots.find((slot) => slot.time === "20:00").available,
      false,
    );

    const blockedBooking = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: player.cookie,
      body: {
        clubId: clubAccount.club.id,
        courtId: court.id,
        startAt: bookingStartAt(date, "19:00"),
        paymentMethod: "venue",
        visibility: "private",
      },
    });
    assert.equal(blockedBooking.status, 409);

    const deleteWeekly = await api(
      `/api/v1/club/recurring-bookings/${weekly.id}`,
      { method: "DELETE", cookie: clubAccount.cookie },
    );
    assert.equal(deleteWeekly.status, 204);

    const partiallyReleasedResponse = await api(
      `/api/v1/clubs/${clubAccount.club.id}?date=${date}`,
    );
    assert.equal(partiallyReleasedResponse.status, 200);
    const partiallyReleasedCourt = (
      await partiallyReleasedResponse.json()
    ).data.availability.find((item) => item.courtId === court.id);
    assert.equal(
      partiallyReleasedCourt.slots.find((slot) => slot.time === "19:00")
        .available,
      true,
    );
    assert.equal(
      partiallyReleasedCourt.slots.find((slot) => slot.time === "20:00")
        .available,
      false,
    );

    const releasedBooking = await createBooking(api, player.cookie, {
      clubId: clubAccount.club.id,
      courtId: court.id,
      startAt: bookingStartAt(date, "19:00"),
    });
    assert.equal(releasedBooking.status, "confirmed");

    const deleteMonthly = await api(
      `/api/v1/club/recurring-bookings/${monthly.id}`,
      { method: "DELETE", cookie: clubAccount.cookie },
    );
    assert.equal(deleteMonthly.status, 204);

    const finalScheduleResponse = await api(
      `/api/v1/club/schedule?date=${date}`,
      { cookie: clubAccount.cookie },
    );
    assert.equal(finalScheduleResponse.status, 200);
    const finalCourt = (await finalScheduleResponse.json()).data.courts.find(
      (item) => item.courtId === court.id,
    );
    assert.equal(
      finalCourt.slots.find((slot) => slot.time === "19:00").status,
      "booked",
    );
    assert.equal(
      finalCourt.slots.find((slot) => slot.time === "20:00").status,
      "available",
    );
  });
});
