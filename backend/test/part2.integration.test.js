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
      responsibleName: "Marina Costa",
      arenaName: `Arena Parte 2 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-parte2-${suffix}@example.com`,
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
  { clubId, courtId, startAt, levelCategories = null },
) {
  const response = await api("/api/v1/player/bookings", {
    method: "POST",
    cookie: playerCookie,
    body: {
      clubId,
      courtId,
      startAt,
      levelCategories,
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).data.booking;
}


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
        playStyle: updatedUser.profile.playStyle,
      },
      {
        firstName: "Marina",
        lastName: "Costa",
        city: "Campinas",
        preferredSide: "drive",
        dominantHand: "right",
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

test("booking detail is always open with three fixed spots, protects non-participants and cancels", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "detalhe-reserva");
    const court = await createLegacyCourt(
      api,
      clubAccount.cookie,
      "detalhe-reserva",
    );
    const owner = await registerPlayer(api, "reserva-dono");
    const participant = await registerPlayer(api, "reserva-participante");
    const ownerLevelResponse = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: owner.cookie,
      body: levelTestAnswers(),
    });
    assert.equal(ownerLevelResponse.status, 200);
    const levelResponse = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: participant.cookie,
      body: levelTestAnswers(),
    });
    assert.equal(levelResponse.status, 200);
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
    assert.equal(detail.referencePrice, 160);
    assert.equal(detail.status, "confirmed");
    assert.equal(detail.maxPlayers, 4);
    assert.equal(detail.openSpots, 3);
    assert.equal(detail.canCancel, true);

    const nonParticipantDetailLeak = await api(
      `/api/v1/player/bookings/${booking.id}`,
      { cookie: participant.cookie },
    );
    assert.equal(nonParticipantDetailLeak.status, 404);

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

