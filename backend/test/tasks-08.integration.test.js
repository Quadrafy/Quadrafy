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
    path.join(os.tmpdir(), "quadrafy-tasks08-test-"),
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
      email: `jogador-tasks08-${suffix}@example.com`,
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
      arenaName: "Arena Tasks08",
      cnpj: "12.345.678/0001-90",
      email: "clube-tasks08@example.com",
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

async function startMatchInThePast(app, matchId) {
  const booking = app.bookings.findById(matchId);
  booking.startAt = new Date(Date.now() - 60_000).toISOString();
  await app.bookings.persist();
}

async function createOpenMatch(api, joiners = []) {
  const clubAccount = await registerClub(api);
  const court = await api("/api/v1/club/courts", {
    method: "POST",
    cookie: clubAccount.cookie,
    body: {
      name: "Quadra Tasks08",
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
  for (const [player, team, slot] of joiners) {
    const join = await api(`/api/v1/matches/${matchId}/join`, {
      method: "POST",
      cookie: player.cookie,
      body: { team, slot },
    });
    assert.equal(join.status, 200);
  }
  return { matchId, organizer };
}

test("TASK-32: only the organizer removes another player, freeing the slot; self-removal blocked", async () => {
  await withTestServer(async ({ api }) => {
    const guest = await registerPlayer(api, "convidado");
    const stranger = await registerPlayer(api, "intruso");
    const { matchId, organizer } = await createOpenMatch(api, [
      [guest, "team2", 0],
    ]);

    // não-organizador não pode remover
    const forbidden = await api(`/api/v1/matches/${matchId}/remove-player`, {
      method: "POST",
      cookie: stranger.cookie,
      body: { playerId: guest.user.id },
    });
    assert.equal(forbidden.status, 403);

    // organizador não remove a si mesmo por esta via
    const self = await api(`/api/v1/matches/${matchId}/remove-player`, {
      method: "POST",
      cookie: organizer.cookie,
      body: { playerId: organizer.user.id },
    });
    assert.equal(self.status, 409);
    assert.equal((await self.json()).error.code, "cannot_remove_self");

    // remoção válida libera a vaga
    const removal = await api(`/api/v1/matches/${matchId}/remove-player`, {
      method: "POST",
      cookie: organizer.cookie,
      body: { playerId: guest.user.id },
    });
    assert.equal(removal.status, 200);
    const match = (await removal.json()).data.match;
    assert.ok(!match.participantIds.includes(guest.user.id));
    assert.equal(match.availableSpots, 3);

    // remover quem não participa → 409
    const again = await api(`/api/v1/matches/${matchId}/remove-player`, {
      method: "POST",
      cookie: organizer.cookie,
      body: { playerId: guest.user.id },
    });
    assert.equal(again.status, 409);

    // a vaga volta a aceitar outro jogador
    const rejoin = await api(`/api/v1/matches/${matchId}/join`, {
      method: "POST",
      cookie: stranger.cookie,
      body: { team: "team2", slot: 0 },
    });
    assert.equal(rejoin.status, 200);
  });
});

test("TASK-33/34/35: start time splits open vs history, gates result reporting and drives the pending badge", async () => {
  await withTestServer(async ({ api, app }) => {
    const partner = await registerPlayer(api, "parceiro");
    const rivalA = await registerPlayer(api, "rival-a");
    const rivalB = await registerPlayer(api, "rival-b");
    const { matchId, organizer } = await createOpenMatch(api, [
      [partner, "team1", 1],
      [rivalA, "team2", 0],
      [rivalB, "team2", 1],
    ]);

    // antes do horário: aparece em "abertos", não no histórico, sem pendência
    let open = (await (await api("/api/v1/matches", { cookie: organizer.cookie })).json()).data;
    assert.ok(open.matches.some((match) => match.id === matchId));
    assert.equal(open.pendingResults, 0);
    let history = (await (await api("/api/v1/matches?scope=history", { cookie: organizer.cookie })).json()).data;
    assert.equal(history.matches.length, 0);

    // TASK-34: lançar resultado antes do início → bloqueado
    const early = await api(`/api/v1/matches/${matchId}/result`, {
      method: "POST",
      cookie: organizer.cookie,
      body: {
        sets: [
          { team1: 6, team2: 4 },
          { team1: 6, team2: 3 },
          { team1: 6, team2: 2 },
        ],
      },
    });
    assert.equal(early.status, 409);
    assert.equal((await early.json()).error.code, "match_not_started");

    // passa o horário de início
    await startMatchInThePast(app, matchId);

    open = (await (await api("/api/v1/matches", { cookie: organizer.cookie })).json()).data;
    assert.ok(!open.matches.some((match) => match.id === matchId));
    assert.equal(open.pendingResults, 1);
    history = (await (await api("/api/v1/matches?scope=history", { cookie: organizer.cookie })).json()).data;
    assert.deepEqual(
      history.matches.map((match) => match.id),
      [matchId],
    );
    assert.equal(history.pendingResults, 1);

    // não-participante não vê a partida no próprio histórico
    const outsider = await registerPlayer(api, "de-fora");
    const outsiderHistory = (
      await (
        await api("/api/v1/matches?scope=history", { cookie: outsider.cookie })
      ).json()
    ).data;
    assert.equal(outsiderHistory.matches.length, 0);
    assert.equal(outsiderHistory.pendingResults, 0);

    // lançado (pendente de confirmação) ainda conta como pendência
    const report = await api(`/api/v1/matches/${matchId}/result`, {
      method: "POST",
      cookie: organizer.cookie,
      body: {
        sets: [
          { team1: 6, team2: 4 },
          { team1: 6, team2: 3 },
          { team1: 6, team2: 2 },
        ],
      },
    });
    assert.equal(report.status, 201);
    history = (await (await api("/api/v1/matches?scope=history", { cookie: organizer.cookie })).json()).data;
    assert.equal(history.pendingResults, 1);

    // TASK-36: confirmação zera a pendência e persiste o ΔNível dos 4
    const confirm = await api(`/api/v1/matches/${matchId}/result/confirm`, {
      method: "POST",
      cookie: rivalA.cookie,
    });
    assert.equal(confirm.status, 200);
    history = (await (await api("/api/v1/matches?scope=history", { cookie: organizer.cookie })).json()).data;
    assert.equal(history.pendingResults, 0);

    const view = (
      await (
        await api(`/api/v1/matches/${matchId}/result`, {
          cookie: rivalB.cookie,
        })
      ).json()
    ).data.result;
    assert.equal(view.status, "confirmed");
    assert.equal(Object.keys(view.levelChanges).length, 4);
    for (const change of Object.values(view.levelChanges)) {
      assert.equal(typeof change.delta, "number");
      assert.equal(typeof change.displayName, "string");
      assert.ok(["team1", "team2"].includes(change.team));
    }
    const winners = Object.values(view.levelChanges).filter((c) => c.won);
    assert.equal(winners.length, 2);
    assert.ok(winners.every((c) => c.delta > 0));

    // TASK-30: histórico de nível agora traz a fiabilidade em cada entrada
    const levelHistory = (
      await (
        await api("/api/v1/player/level-history", { cookie: organizer.cookie })
      ).json()
    ).data.history;
    assert.equal(levelHistory.length, 2);
    assert.equal(levelHistory[0].levelConfidence, 35);
    assert.ok(levelHistory[1].levelConfidence > 35);
  });
});
