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

async function withTestServer(run) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-tasks05-test-"),
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
    await run({ api });
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

async function completeLevelTest(api, cookie, answers) {
  const response = await api("/api/v1/player/level-test", {
    method: "POST",
    cookie,
    body: {
      tempo_pratica: 2,
      frequencia_semanal: 2,
      experiencia_esportes_raquete: 2,
      autoavaliacao_golpes: 2,
      experiencia_competicoes: 2,
      tatica_posicionamento: 2,
      ...answers,
    },
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.user.profile.level;
}

async function registerPlayer(api, suffix, levelAnswers) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Ana",
      lastName: `Silva ${suffix}`,
      email: `jogador-tasks05-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      city: "Sao Paulo",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const payload = await response.json();
  let level = null;
  if (levelAnswers !== undefined) {
    level = await completeLevelTest(api, cookie, levelAnswers);
  }
  return { cookie, user: payload.data.user, level };
}

async function registerClub(api, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: `Arena Tasks05 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-tasks05-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const dashboard = await api("/api/v1/club/dashboard", { cookie });
  assert.equal(dashboard.status, 200);
  const payload = await dashboard.json();
  return { cookie, club: payload.data.club };
}

async function createCourt(api, clubCookie) {
  const response = await api("/api/v1/club/courts", {
    method: "POST",
    cookie: clubCookie,
    body: {
      name: "Quadra Tasks05",
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

function bookingStartAt(daysAhead = 30) {
  const value = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
  return new Date(`${key}T10:00:00-03:00`).toISOString();
}

async function createOpenMatch(api) {
  const clubAccount = await registerClub(api, "principal");
  const court = await createCourt(api, clubAccount.cookie);
  const organizer = await registerPlayer(api, "organizador", {});
  const response = await api("/api/v1/player/bookings", {
    method: "POST",
    cookie: organizer.cookie,
    body: {
      clubId: clubAccount.club.id,
      courtId: court.id,
      startAt: bookingStartAt(),
      paymentMethod: "pix",
      visibility: "open",
      levelMin: 0.5,
      levelMax: 7,
      levelRange: "0.50 - 7.00",
      availableSpots: 3,
    },
  });
  assert.equal(response.status, 201);
  const booking = (await response.json()).data.booking;
  return { organizer, matchId: booking.id };
}

test("TASK-13: participant leaves an open match and frees the spot; organizer with company cannot leave", async () => {
  await withTestServer(async ({ api }) => {
    const { organizer, matchId } = await createOpenMatch(api);
    const guest = await registerPlayer(api, "convidado", {});

    const join = await api(`/api/v1/matches/${matchId}/join`, {
      method: "POST",
      cookie: guest.cookie,
      body: { team: "team2", slot: 0 },
    });
    assert.equal(join.status, 200);

    const organizerLeave = await api(`/api/v1/matches/${matchId}/leave`, {
      method: "POST",
      cookie: organizer.cookie,
    });
    assert.equal(organizerLeave.status, 409);
    assert.equal(
      (await organizerLeave.json()).error.code,
      "organizer_cannot_leave",
    );

    const guestLeave = await api(`/api/v1/matches/${matchId}/leave`, {
      method: "POST",
      cookie: guest.cookie,
    });
    assert.equal(guestLeave.status, 200);
    const left = (await guestLeave.json()).data.match;
    assert.equal(left.availableSpots, 3);
    assert.ok(!left.participantIds.includes(guest.user.id));

    const secondLeave = await api(`/api/v1/matches/${matchId}/leave`, {
      method: "POST",
      cookie: guest.cookie,
    });
    assert.equal(secondLeave.status, 409);
  });
});

test("TASK-12: participant moves only their own position into an empty slot", async () => {
  await withTestServer(async ({ api }) => {
    const { matchId } = await createOpenMatch(api);
    const guest = await registerPlayer(api, "movedor", {});
    const outsider = await registerPlayer(api, "de-fora", {});

    const join = await api(`/api/v1/matches/${matchId}/join`, {
      method: "POST",
      cookie: guest.cookie,
      body: { team: "team1", slot: 1 },
    });
    assert.equal(join.status, 200);

    const move = await api(`/api/v1/matches/${matchId}/position`, {
      method: "PATCH",
      cookie: guest.cookie,
      body: { team: "team2", slot: 1 },
    });
    assert.equal(move.status, 200);
    const moved = (await move.json()).data.match;
    assert.equal(moved.teamIds.team2[1], guest.user.id);
    assert.equal(moved.teamIds.team1[1], null);

    const occupied = await api(`/api/v1/matches/${matchId}/position`, {
      method: "PATCH",
      cookie: guest.cookie,
      body: { team: "team1", slot: 0 },
    });
    assert.equal(occupied.status, 409);

    const notJoined = await api(`/api/v1/matches/${matchId}/position`, {
      method: "PATCH",
      cookie: outsider.cookie,
      body: { team: "team2", slot: 0 },
    });
    assert.equal(notJoined.status, 403);
  });
});

test("TASK-14: ranking orders players by level and reports the caller's own rank", async () => {
  await withTestServer(async ({ api }) => {
    const strong = await registerPlayer(api, "top", {
      tempo_pratica: 4,
      frequencia_semanal: 4,
      experiencia_esportes_raquete: 4,
      autoavaliacao_golpes: 4,
      experiencia_competicoes: 4,
      tatica_posicionamento: 4,
    });
    const weak = await registerPlayer(api, "base", {
      tempo_pratica: 1,
      frequencia_semanal: 1,
      experiencia_esportes_raquete: 1,
      autoavaliacao_golpes: 1,
      experiencia_competicoes: 1,
      tatica_posicionamento: 1,
    });

    const response = await api("/api/v1/players/ranking", {
      cookie: weak.cookie,
    });
    assert.equal(response.status, 200);
    // TASK-31: resposta agrupada pelas 7 categorias oficiais
    const { groups, me, total } = (await response.json()).data;
    assert.equal(total, 2);
    const allPlayers = groups.flatMap((group) => group.players);
    assert.equal(allPlayers.length, 2);
    const strongGroup = groups.find((group) =>
      group.players.some((player) => player.id === strong.user.id),
    );
    const weakGroup = groups.find((group) =>
      group.players.some((player) => player.id === weak.user.id),
    );
    assert.notEqual(strongGroup.technical, weakGroup.technical);
    // posição calculada dentro da própria categoria
    assert.ok(
      groups.every((group) =>
        group.players.every((player, index) => player.rank === index + 1),
      ),
    );
    assert.equal(me.id, weak.user.id);
    assert.equal(me.rank, 1);
    assert.equal(me.technical, weakGroup.technical);
    assert.ok(allPlayers.every((player) => !("email" in player)));

    const anonymous = await api("/api/v1/players/ranking");
    assert.equal(anonymous.status, 401);
  });
});
