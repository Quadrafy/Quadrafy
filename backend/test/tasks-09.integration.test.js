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
    path.join(os.tmpdir(), "quadrafy-tasks09-test-"),
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

async function registerPlayer(api, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Ana",
      lastName: `Silva ${suffix}`,
      email: `jogador-tasks09-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      city: "Sao Paulo",
    },
  });
  assert.equal(response.status, 201);
  return {
    cookie: cookieFrom(response),
    user: (await response.json()).data.user,
  };
}

async function registerClub(api, suffix = "principal") {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: `Arena Tasks09 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-tasks09-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const dashboard = await api("/api/v1/club/dashboard", { cookie });
  const payload = await dashboard.json();
  return { cookie, club: payload.data.club };
}

async function createCourt(api, cookie, name) {
  const response = await api("/api/v1/club/courts", {
    method: "POST",
    cookie,
    body: {
      name,
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

test("TASKS-09: full club flow — create, courts, generate, publish; player sees own tournament", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api);
    const courtA = await createCourt(api, clubAccount.cookie, "Quadra 1");
    const courtB = await createCourt(api, clubAccount.cookie, "Quadra 2");
    const linkedPlayer = await registerPlayer(api, "inscrito");
    const outsider = await registerPlayer(api, "de-fora");

    // TASK-38: busca de jogadores cadastrados (autocomplete)
    const search = await api("/api/v1/players/search?q=silva%20inscrito", {
      cookie: clubAccount.cookie,
    });
    assert.equal(search.status, 200);
    const found = (await search.json()).data.players;
    assert.ok(found.some((player) => player.id === linkedPlayer.user.id));
    assert.ok(found.every((player) => !("email" in player)));

    // criação: 1 jogador vinculado + 7 convidados, rotação individual
    const players = [
      { id: linkedPlayer.user.id, name: "ignorado (vem da conta)" },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: null,
        name: `Convidado ${index + 1}`,
      })),
    ];
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: { name: "Super 8 de Sexta", size: 8, mode: "rotacao", players },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    assert.equal(tournament.status, "em_configuracao");
    assert.equal(tournament.players.length, 8);

    // listagem do clube (TASK-37)
    const list = await api("/api/v1/club/super8", {
      cookie: clubAccount.cookie,
    });
    assert.equal(
      (await list.json()).data.tournaments[0].id,
      tournament.id,
    );

    // gerar antes das quadras → bloqueado
    const earlyGenerate = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(earlyGenerate.status, 409);

    // TASK-39: quadras (ao menos 1; apenas do próprio clube)
    const noCourts = await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [] },
    });
    assert.equal(noCourts.status, 422);
    const foreignCourt = await api(
      `/api/v1/club/super8/${tournament.id}/courts`,
      {
        method: "PATCH",
        cookie: clubAccount.cookie,
        body: { courtIds: ["quadra-de-outro-clube"] },
      },
    );
    assert.equal(foreignCourt.status, 422);
    const courtsOk = await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [courtA.id, courtB.id] },
    });
    assert.equal(courtsOk.status, 200);

    // TASK-40/TASK-43: geração — 8 em rotação: 14 confrontos, SEM horário
    const generated = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(generated.status, 200);
    const withGames = (await generated.json()).data.tournament;
    assert.equal(withGames.status, "gerado");
    assert.equal(withGames.games.length, 14);
    assert.ok(
      withGames.games.every(
        (game) =>
          game.status === "aguardando" &&
          game.court?.id &&
          !("startAt" in game),
      ),
    );

    // antes de publicar, o jogador inscrito não vê nada (TASK-42)
    let playerView = await api("/api/v1/players/super8", {
      cookie: linkedPlayer.cookie,
    });
    assert.equal((await playerView.json()).data.tournaments.length, 0);

    // TASK-41: publicar
    const published = await api(
      `/api/v1/club/super8/${tournament.id}/publish`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(published.status, 200);
    assert.equal(
      (await published.json()).data.tournament.status,
      "em_andamento",
    );
    // regeneração após publicar → bloqueada
    const regenerate = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(regenerate.status, 409);

    // TASK-42: jogador inscrito vê o torneio; quem não participa, não
    playerView = await api("/api/v1/players/super8", {
      cookie: linkedPlayer.cookie,
    });
    const mine = (await playerView.json()).data.tournaments;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, tournament.id);
    assert.ok(mine[0].clubName.includes("Arena Tasks09"));
    // o jogador vinculado aparece em 7 jogos (parceria única com cada um)
    const myGames = mine[0].games.filter((game) =>
      [...game.team1, ...game.team2].some(
        (player) => player.id === linkedPlayer.user.id,
      ),
    );
    assert.equal(myGames.length, 7);

    const outsiderView = await api("/api/v1/players/super8", {
      cookie: outsider.cookie,
    });
    assert.equal((await outsiderView.json()).data.tournaments.length, 0);
  });
});

test("TASKS-09: fixed pairs validation and ownership guards", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "duplas");
    const court = await createCourt(api, clubAccount.cookie, "Central");
    const players = Array.from({ length: 8 }, (_, index) => ({
      id: null,
      name: `Jogador ${index + 1}`,
    }));

    // duplas incompletas → 422
    const badPairs = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Duplas de Sábado",
        size: 8,
        mode: "duplas_fixas",
        players,
        pairs: [
          [0, 1],
          [2, 3],
          [4, 5],
          [6, 6],
        ],
      },
    });
    assert.equal(badPairs.status, 422);

    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Duplas de Sábado",
        size: 8,
        mode: "duplas_fixas",
        players,
        pairs: [
          [0, 1],
          [2, 3],
          [4, 5],
          [6, 7],
        ],
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [court.id] },
    });
    const generated = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    const withGames = (await generated.json()).data.tournament;
    // 4 duplas → 6 confrontos, todos na única quadra
    assert.equal(withGames.games.length, 6);
    assert.ok(withGames.games.every((game) => game.court.id === court.id));

    // outro clube não acessa o torneio
    const otherClub = await registerClub(api, "intruso");
    const foreign = await api(`/api/v1/club/super8/${tournament.id}/publish`, {
      method: "POST",
      cookie: otherClub.cookie,
    });
    assert.equal(foreign.status, 404);

    // jogador não acessa rotas do clube
    const player = await registerPlayer(api, "sem-acesso");
    const forbidden = await api("/api/v1/club/super8", {
      cookie: player.cookie,
    });
    assert.equal(forbidden.status, 403);
  });
});
