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
    path.join(os.tmpdir(), "quadrafy-tasks12-test-"),
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
  assert.ok(header);
  return header.split(";", 1)[0];
}

async function registerPlayer(api, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Ana",
      lastName: `Silva ${suffix}`,
      email: `jogador-tasks12-${suffix}@example.com`,
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

async function registerClubWithCourt(api, suffix = "principal") {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: `Arena Tasks12 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-tasks12-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const court = await api("/api/v1/club/courts", {
    method: "POST",
    cookie,
    body: {
      name: "Quadra Central",
      type: "covered",
      price: 160,
      opensAt: "06:00",
      closesAt: "23:00",
      slotDurationMinutes: 60,
    },
  });
  return { cookie, court: (await court.json()).data.court };
}

const guests = (count, prefix = "Convidado") =>
  Array.from({ length: count }, (_, index) => ({
    id: null,
    name: `${prefix} ${index + 1}`,
  }));

test("TASK-43/44/48: games without time, club reports/edits results in any order, final standings", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api);
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Relâmpago",
        size: 8,
        mode: "rotacao",
        players: guests(8),
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [clubAccount.court.id] },
    });
    const generated = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    let current = (await generated.json()).data.tournament;
    assert.equal(current.games.length, 14);
    assert.ok(current.games.every((game) => !("startAt" in game)));
    assert.equal(current.gamesFinished, 0);

    await api(`/api/v1/club/super8/${tournament.id}/publish`, {
      method: "POST",
      cookie: clubAccount.cookie,
    });

    // finalizar antes de todos os resultados → bloqueado com contagem
    const earlyFinalize = await api(
      `/api/v1/club/super8/${tournament.id}/finalize`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(earlyFinalize.status, 409);
    assert.match((await earlyFinalize.json()).error.message, /faltam 14/);

    // TASK-44: resultados em QUALQUER ordem (do último para o primeiro),
    // sem confirmação de jogador; placar de games corridos
    const gamesDesc = [...current.games].reverse();
    for (const game of gamesDesc) {
      const result = await api(
        `/api/v1/club/super8/${tournament.id}/games/${game.id}/result`,
        {
          method: "POST",
          cookie: clubAccount.cookie,
          body: { team1Games: 7, team2Games: 4 },
        },
      );
      assert.equal(result.status, 200);
    }

    // empate → 422; jogo inexistente → 404
    const tie = await api(
      `/api/v1/club/super8/${tournament.id}/games/${current.games[0].id}/result`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { team1Games: 6, team2Games: 6 },
      },
    );
    assert.equal(tie.status, 422);
    const ghost = await api(
      `/api/v1/club/super8/${tournament.id}/games/nao-existe/result`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { team1Games: 7, team2Games: 4 },
      },
    );
    assert.equal(ghost.status, 404);

    // correção de placar (editar resultado já lançado)
    const firstGame = current.games[0];
    const edit = await api(
      `/api/v1/club/super8/${tournament.id}/games/${firstGame.id}/result`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { team1Games: 3, team2Games: 7 },
      },
    );
    assert.equal(edit.status, 200);
    current = (await edit.json()).data.tournament;
    assert.equal(current.gamesFinished, 14);
    const edited = current.games.find((game) => game.id === firstGame.id);
    assert.deepEqual(edited.score, { team1Games: 3, team2Games: 7 });
    assert.equal(edited.status, "finalizado");

    // TASK-48: tabela final (por jogador na rotação), ordenada por
    // vitórias e desempate por saldo de games
    const finalize = await api(
      `/api/v1/club/super8/${tournament.id}/finalize`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(finalize.status, 200);
    const finished = (await finalize.json()).data.tournament;
    assert.equal(finished.status, "finalizado");
    assert.equal(finished.standings.length, 8);
    assert.deepEqual(
      finished.standings.map((row) => row.position),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.ok(finished.standings.every((row) => row.played === 7));
    for (let index = 1; index < finished.standings.length; index += 1) {
      const previous = finished.standings[index - 1];
      const row = finished.standings[index];
      assert.ok(
        previous.wins > row.wins ||
          (previous.wins === row.wins && previous.balance >= row.balance),
        "standings must be ordered by wins, then games balance",
      );
    }

    // resultados travados após finalizar
    const late = await api(
      `/api/v1/club/super8/${tournament.id}/games/${firstGame.id}/result`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { team1Games: 7, team2Games: 2 },
      },
    );
    assert.equal(late.status, 409);
    const refinalize = await api(
      `/api/v1/club/super8/${tournament.id}/finalize`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(refinalize.status, 409);
  });
});

test("TASK-47: open registrations — player self-joins until roster is full; standings visible to player", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "inscricoes");
    // criado com 6 jogadores (rotação permite quadro parcial)
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Comunitário",
        size: 8,
        mode: "rotacao",
        players: guests(6),
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;

    // gerar sem quadro completo → bloqueado
    await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [clubAccount.court.id] },
    });
    const earlyGenerate = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(earlyGenerate.status, 409);
    assert.equal(
      (await earlyGenerate.json()).error.code,
      "super8_roster_incomplete",
    );

    const opened = await api(
      `/api/v1/club/super8/${tournament.id}/open-registrations`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(opened.status, 200);
    assert.equal(
      (await opened.json()).data.tournament.status,
      "inscricoes_abertas",
    );

    const playerA = await registerPlayer(api, "a");
    const playerB = await registerPlayer(api, "b");
    const playerC = await registerPlayer(api, "c");

    // listagem de abertos com vagas
    const openList = await api("/api/v1/players/super8/open", {
      cookie: playerA.cookie,
    });
    const listed = (await openList.json()).data.tournaments;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].spotsLeft, 2);
    assert.equal(listed[0].alreadyJoined, false);

    const joinA = await api(`/api/v1/players/super8/${tournament.id}/join`, {
      method: "POST",
      cookie: playerA.cookie,
    });
    assert.equal(joinA.status, 200);
    const duplicate = await api(
      `/api/v1/players/super8/${tournament.id}/join`,
      { method: "POST", cookie: playerA.cookie },
    );
    assert.equal(duplicate.status, 409);

    const joinB = await api(`/api/v1/players/super8/${tournament.id}/join`, {
      method: "POST",
      cookie: playerB.cookie,
    });
    assert.equal(joinB.status, 200);
    // quadro completo → status volta para configuração e sai da lista
    assert.equal(
      (await joinB.json()).data.tournament.status,
      "em_configuracao",
    );
    const lateJoin = await api(`/api/v1/players/super8/${tournament.id}/join`, {
      method: "POST",
      cookie: playerC.cookie,
    });
    assert.equal(lateJoin.status, 404);
    const emptyList = await api("/api/v1/players/super8/open", {
      cookie: playerC.cookie,
    });
    assert.equal((await emptyList.json()).data.tournaments.length, 0);

    // clube gera, publica, lança tudo e finaliza — jogador vê standings
    const generated = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    const games = (await generated.json()).data.tournament.games;
    await api(`/api/v1/club/super8/${tournament.id}/publish`, {
      method: "POST",
      cookie: clubAccount.cookie,
    });
    for (const game of games) {
      await api(
        `/api/v1/club/super8/${tournament.id}/games/${game.id}/result`,
        {
          method: "POST",
          cookie: clubAccount.cookie,
          body: { team1Games: 7, team2Games: 5 },
        },
      );
    }
    await api(`/api/v1/club/super8/${tournament.id}/finalize`, {
      method: "POST",
      cookie: clubAccount.cookie,
    });

    const mine = await api("/api/v1/players/super8/mine", {
      cookie: playerA.cookie,
    });
    const myTournaments = (await mine.json()).data.tournaments;
    assert.equal(myTournaments.length, 1);
    assert.equal(myTournaments[0].status, "finalizado");
    assert.equal(myTournaments[0].standings.length, 8);
    assert.ok(
      myTournaments[0].standings.some((row) => row.key === playerA.user.id),
    );

    // inscrições abertas indisponíveis em duplas fixas
    const fixed = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Duplas Fechadas",
        size: 8,
        mode: "duplas_fixas",
        players: guests(8, "Fixo"),
        pairs: [
          [0, 1],
          [2, 3],
          [4, 5],
          [6, 7],
        ],
      },
    });
    const fixedTournament = (await fixed.json()).data.tournament;
    const fixedOpen = await api(
      `/api/v1/club/super8/${fixedTournament.id}/open-registrations`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(fixedOpen.status, 409);
  });
});
