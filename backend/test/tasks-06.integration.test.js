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
    path.join(os.tmpdir(), "quadrafy-tasks06-test-"),
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
    await run({ api, app });
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
      lastName: `Silva ${suffix}`,
      email: `jogador-tasks06-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      city: "Sao Paulo",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const payload = await response.json();
  const levelTest = await api("/api/v1/player/level-test", {
    method: "POST",
    cookie,
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
  return { cookie, user: payload.data.user };
}

async function registerClub(api) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: "Arena Tasks06",
      cnpj: "12.345.678/0001-90",
      email: "clube-tasks06@example.com",
      password: "SenhaSeguraClube123",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const dashboard = await api("/api/v1/club/dashboard", { cookie });
  const payload = await dashboard.json();
  return { cookie, club: payload.data.club };
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

// TASK-34: recua o horário de início da reserva para o passado, direto no
// store (o servidor de teste expõe os stores), simulando uma partida que já
// começou — pré-requisito para lançar resultado.
async function startMatchInThePast(app, matchId) {
  const booking = app.bookings.findById(matchId);
  booking.startAt = new Date(Date.now() - 60_000).toISOString();
  await app.bookings.persist();
}

// Cria uma partida aberta com 4 jogadores confirmados (2 duplas completas),
// já com o horário de início no passado (pronta para lançar resultado).
async function createFullMatch(api, app) {
  const clubAccount = await registerClub(api);
  const court = await api("/api/v1/club/courts", {
    method: "POST",
    cookie: clubAccount.cookie,
    body: {
      name: "Quadra Tasks06",
      type: "covered",
      price: 160,
      opensAt: "06:00",
      closesAt: "23:00",
      slotDurationMinutes: 60,
    },
  });
  const courtId = (await court.json()).data.court.id;
  const organizer = await registerPlayer(api, "organizador");
  const booking = await api("/api/v1/player/bookings", {
    method: "POST",
    cookie: organizer.cookie,
    body: {
      clubId: clubAccount.club.id,
      courtId,
      startAt: bookingStartAt(),
      paymentMethod: "pix",
      visibility: "open",
      levelMin: 0.5,
      levelMax: 7,
      levelRange: "0.50 - 7.00",
      availableSpots: 3,
    },
  });
  assert.equal(booking.status, 201);
  const matchId = (await booking.json()).data.booking.id;
  const partner = await registerPlayer(api, "parceiro");
  const rivalA = await registerPlayer(api, "rival-a");
  const rivalB = await registerPlayer(api, "rival-b");
  for (const [player, team, slot] of [
    [partner, "team1", 1],
    [rivalA, "team2", 0],
    [rivalB, "team2", 1],
  ]) {
    const join = await api(`/api/v1/matches/${matchId}/join`, {
      method: "POST",
      cookie: player.cookie,
      body: { team, slot },
    });
    assert.equal(join.status, 200);
  }
  await startMatchInThePast(app, matchId);
  return { matchId, organizer, partner, rivalA, rivalB };
}

async function profileOf(api, account) {
  const response = await api("/api/v1/player/profile", {
    cookie: account.cookie,
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.profile;
}

const WINNING_SETS = [
  { team1: 6, team2: 4 },
  { team1: 4, team2: 6 },
  { team1: 6, team2: 2 },
];

test("TASK-17/17B/18/19: full result flow with cross confirmation updates levels, stats and history", async () => {
  await withTestServer(async ({ api, app }) => {
    const { matchId, organizer, partner, rivalA, rivalB } =
      await createFullMatch(api, app);
    const before = {
      organizer: await profileOf(api, organizer),
      rivalA: await profileOf(api, rivalA),
    };

    // lançamento pelo organizador (team1)
    const report = await api(`/api/v1/matches/${matchId}/result`, {
      method: "POST",
      cookie: organizer.cookie,
      body: { sets: WINNING_SETS, winningTeam: "team1" },
    });
    assert.equal(report.status, 201);
    const reported = (await report.json()).data.result;
    assert.equal(reported.status, "pending");
    assert.equal(reported.winningTeam, "team1");

    // parceiro (mesmo time) não pode confirmar
    const sameTeam = await api(`/api/v1/matches/${matchId}/result/confirm`, {
      method: "POST",
      cookie: partner.cookie,
    });
    assert.equal(sameTeam.status, 409);

    // níveis intactos enquanto pendente
    const pendingProfile = await profileOf(api, organizer);
    assert.equal(pendingProfile.level, before.organizer.level);

    // adversário confirma → efetiva e recalcula
    const confirm = await api(`/api/v1/matches/${matchId}/result/confirm`, {
      method: "POST",
      cookie: rivalA.cookie,
    });
    assert.equal(confirm.status, 200);
    const confirmPayload = (await confirm.json()).data;
    assert.equal(confirmPayload.result.status, "confirmed");
    assert.equal(Object.keys(confirmPayload.levelChanges).length, 4);

    const winner = await profileOf(api, organizer);
    const loser = await profileOf(api, rivalA);
    assert.equal(winner.matchesPlayed, 1);
    assert.equal(winner.wins, 1);
    assert.equal(winner.winRate, 100);
    assert.ok(winner.level > before.organizer.level);
    assert.equal(loser.matchesPlayed, 1);
    assert.equal(loser.wins, 0);
    assert.equal(loser.winRate, 0);
    assert.ok(loser.level < before.rivalA.level);
    // TASKS-07: fiabilidade agora em percentual (0–100), partindo de 35%
    assert.ok(
      winner.levelConfidence > 35 && winner.levelConfidence < 45,
      `fiabilidade após 1 partida deve crescer pouco acima de 35%, got ${winner.levelConfidence}`,
    );
    assert.equal(typeof winner.levelCategory, "string");

    // dupla confirmação bloqueada
    const again = await api(`/api/v1/matches/${matchId}/result/confirm`, {
      method: "POST",
      cookie: rivalB.cookie,
    });
    assert.equal(again.status, 409);

    // TASK-19: histórico com teste inicial + partida
    const history = await api("/api/v1/player/level-history", {
      cookie: organizer.cookie,
    });
    assert.equal(history.status, 200);
    const entries = (await history.json()).data.history;
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.source),
      ["level_test", "match_result"],
    );
    assert.equal(entries[1].matchId, matchId);

    // TASK-23: estatísticas segmentadas e sequência
    const stats = await api("/api/v1/player/stats", {
      cookie: organizer.cookie,
    });
    const statsData = (await stats.json()).data.stats;
    assert.equal(statsData.matchesPlayed, 1);
    assert.equal(statsData.currentWinStreak, 1);
    assert.equal(statsData.winRateVsSimilarLevel, 100);
    assert.equal(statsData.winRateVsHigherLevel, null);

    // TASK-20: parceiros e rivais
    const connections = await api("/api/v1/player/connections", {
      cookie: organizer.cookie,
    });
    const { frequentPartners, recurringRivals } = (await connections.json())
      .data;
    assert.deepEqual(
      frequentPartners.map((player) => player.id),
      [partner.user.id],
    );
    assert.equal(frequentPartners[0].matches, 1);
    assert.equal(recurringRivals.length, 2);
    assert.ok(
      recurringRivals.every((player) =>
        [rivalA.user.id, rivalB.user.id].includes(player.id),
      ),
    );
    assert.ok(recurringRivals.every((player) => !("email" in player)));

    // resultado GET para participante
    const resultView = await api(`/api/v1/matches/${matchId}/result`, {
      cookie: rivalB.cookie,
    });
    assert.equal(resultView.status, 200);
    assert.equal((await resultView.json()).data.result.status, "confirmed");

    // TASKS-07 / TASK-29: explicador local do último resultado
    const explanationResponse = await api("/api/v1/player/level-explanation", {
      cookie: organizer.cookie,
    });
    assert.equal(explanationResponse.status, 200);
    const { explanation } = (await explanationResponse.json()).data;
    assert.equal(explanation.matchId, matchId);
    assert.equal(explanation.won, true);
    assert.match(
      explanation.summary,
      /^Nível: \d\.\d{2} \(.+\) \| Fiabilidade: \d{1,3}%$/,
    );
  });
});

test("result reporting requires a full match and rejects inconsistent scores", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api);
    const court = await api("/api/v1/club/courts", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Quadra Incompleta",
        type: "covered",
        price: 160,
        opensAt: "06:00",
        closesAt: "23:00",
        slotDurationMinutes: 60,
      },
    });
    const courtId = (await court.json()).data.court.id;
    const organizer = await registerPlayer(api, "solo");
    const booking = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: organizer.cookie,
      body: {
        clubId: clubAccount.club.id,
        courtId,
        startAt: bookingStartAt(),
        paymentMethod: "pix",
        visibility: "open",
        levelMin: 0.5,
        levelMax: 7,
        levelRange: "0.50 - 7.00",
        availableSpots: 3,
      },
    });
    const matchId = (await booking.json()).data.booking.id;

    // partida incompleta → 409
    const early = await api(`/api/v1/matches/${matchId}/result`, {
      method: "POST",
      cookie: organizer.cookie,
      body: { sets: WINNING_SETS },
    });
    assert.equal(early.status, 409);
    assert.equal((await early.json()).error.code, "match_not_full");
  });
});

test("result payload validation: exactly 3 sets, no ties, coherent winner", async () => {
  await withTestServer(async ({ api, app }) => {
    const { matchId, organizer } = await createFullMatch(api, app);
    const twoSets = await api(`/api/v1/matches/${matchId}/result`, {
      method: "POST",
      cookie: organizer.cookie,
      body: { sets: WINNING_SETS.slice(0, 2) },
    });
    assert.equal(twoSets.status, 422);
    const tie = await api(`/api/v1/matches/${matchId}/result`, {
      method: "POST",
      cookie: organizer.cookie,
      body: {
        sets: [
          { team1: 6, team2: 6 },
          { team1: 6, team2: 2 },
          { team1: 6, team2: 3 },
        ],
      },
    });
    assert.equal(tie.status, 422);
    const wrongWinner = await api(`/api/v1/matches/${matchId}/result`, {
      method: "POST",
      cookie: organizer.cookie,
      body: { sets: WINNING_SETS, winningTeam: "team2" },
    });
    assert.equal(wrongWinner.status, 422);
  });
});

test("TASK-21: player saves side, play style and preferred time blocks", async () => {
  await withTestServer(async ({ api }) => {
    const player = await registerPlayer(api, "preferencias");
    const update = await api("/api/v1/player/profile", {
      method: "PATCH",
      cookie: player.cookie,
      body: {
        preferredSide: "reves",
        playStyle: "competitivo",
        preferredTimes: ["mon_evening", "sat_morning", "mon_evening"],
      },
    });
    assert.equal(update.status, 200);
    const profile = (await update.json()).data.user.profile;
    assert.equal(profile.preferredSide, "reves");
    assert.equal(profile.playStyle, "competitivo");
    assert.deepEqual(profile.preferredTimes, ["mon_evening", "sat_morning"]);

    const invalid = await api("/api/v1/player/profile", {
      method: "PATCH",
      cookie: player.cookie,
      body: { preferredTimes: ["mon_dawn"] },
    });
    assert.equal(invalid.status, 422);

    const reload = await api("/api/v1/player/profile", {
      cookie: player.cookie,
    });
    const persisted = (await reload.json()).data.profile;
    assert.deepEqual(persisted.preferredTimes, ["mon_evening", "sat_morning"]);
  });
});
