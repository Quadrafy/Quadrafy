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
    path.join(os.tmpdir(), "quadrafy-tasks18-test-"),
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
  assert.ok(header);
  return header.split(";", 1)[0];
}

// score 12 (todas respostas = 2) -> nível ~1.85 -> "Iniciante Intermediário"
const MID_LOW_ANSWERS = {
  tempo_pratica: 2,
  frequencia_semanal: 2,
  experiencia_esportes_raquete: 2,
  autoavaliacao_golpes: 2,
  experiencia_competicoes: 2,
  tatica_posicionamento: 2,
};

// score 24 (todas respostas = 4) -> nível 5.6 -> "Avançado"
const HIGH_ANSWERS = {
  tempo_pratica: 4,
  frequencia_semanal: 4,
  experiencia_esportes_raquete: 4,
  autoavaliacao_golpes: 4,
  experiencia_competicoes: 4,
  tatica_posicionamento: 4,
};

async function registerPlayer(api, suffix, { answers = MID_LOW_ANSWERS } = {}) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Ana",
      lastName: `Silva ${suffix}`,
      email: `jogador-tasks18-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      phone: "(11) 91234-5678",
      city: "Sao Paulo",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const levelTest = await api("/api/v1/player/level-test", {
    method: "POST",
    cookie,
    body: answers,
  });
  assert.equal(levelTest.status, 200);
  const payload = await levelTest.json();
  return { cookie, user: payload.data.user };
}

async function registerClubWithCourt(api, suffix = "principal") {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: `Arena Tasks18 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-tasks18-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
      phone: "11987654321",
    },
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const dashboard = await api("/api/v1/club/dashboard", { cookie });
  const club = (await dashboard.json()).data.club;
  const court = await api("/api/v1/club/courts", {
    method: "POST",
    cookie,
    body: {
      name: "Quadra Tasks18",
      type: "covered",
      price: 160,
      opensAt: "06:00",
      closesAt: "23:00",
      slotDurationMinutes: 60,
    },
  });
  return { cookie, club, court: (await court.json()).data.court };
}

test("TASK-74: duplas fixas pode publicar com vagas abertas; duplas são definidas depois que o quadro completa", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "duplas-abertas");
    // cria com 4/8 jogadores (manual), duplas fixas, sem pares ainda
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Duplas Parcial",
        size: 8,
        mode: "duplas_fixas",
        players: Array.from({ length: 4 }, (_, index) => ({
          id: null,
          name: `Manual ${index + 1}`,
        })),
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    assert.equal(tournament.pairs, null);

    await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [clubAccount.court.id] },
    });

    // abre inscrições mesmo em duplas fixas (antes só "rotacao" podia)
    const opened = await api(
      `/api/v1/club/super8/${tournament.id}/open-registrations`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(opened.status, 200);

    const joiners = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        registerPlayer(api, `duplas-join-${index}`),
      ),
    );
    let lastJoin;
    for (const joiner of joiners) {
      lastJoin = await api(`/api/v1/players/super8/${tournament.id}/join`, {
        method: "POST",
        cookie: joiner.cookie,
      });
      assert.equal(lastJoin.status, 200);
    }
    const afterJoins = (await lastJoin.json()).data.tournament;
    assert.equal(afterJoins.status, "em_configuracao");
    assert.equal(afterJoins.players, 8);

    // gerar sem duplas definidas -> 409
    const blocked = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, "super8_pairs_required");

    // define as duplas agora que o quadro completou
    const pairs = await api(`/api/v1/club/super8/${tournament.id}/pairs`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { pairs: [[0, 1], [2, 3], [4, 5], [6, 7]] },
    });
    assert.equal(pairs.status, 200);

    const generated = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(generated.status, 200);
    const withGames = (await generated.json()).data.tournament;
    assert.equal(withGames.status, "gerado");
    assert.ok(withGames.games.length > 0);
  });
});

test("TASK-74: quadro 100% em aberto na criação (rotação), sem nenhum jogador informado", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "zero-jogadores");
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Zero Jogadores",
        size: 8,
        mode: "rotacao",
        players: [],
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    assert.equal(tournament.players.length, 0);
  });
});

test("TASK-77: categorias de nível permitidas bloqueiam adição manual, inscrição espontânea e escondem da listagem", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "categorias");
    const lowPlayer = await registerPlayer(api, "baixa"); // Iniciante Intermediário
    const highPlayer = await registerPlayer(api, "alta", {
      answers: HIGH_ANSWERS,
    }); // Avançado

    // adição manual de jogador fora da categoria permitida -> 422
    const rejectedManual = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Restrito",
        size: 8,
        mode: "rotacao",
        players: [{ id: lowPlayer.user.id, name: "Baixa" }],
        levelCategories: ["Avançado"],
      },
    });
    assert.equal(rejectedManual.status, 422);

    // cria restrito a "Avançado" só com o jogador compatível
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Restrito",
        size: 8,
        mode: "rotacao",
        players: [{ id: highPlayer.user.id, name: "Alta" }],
        levelCategories: ["Avançado"],
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    assert.deepEqual(tournament.levelCategories, ["Avançado"]);

    await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [clubAccount.court.id] },
    });
    await api(`/api/v1/club/super8/${tournament.id}/open-registrations`, {
      method: "POST",
      cookie: clubAccount.cookie,
    });

    // inscrição espontânea de jogador fora da categoria -> 403
    const rejectedJoin = await api(
      `/api/v1/players/super8/${tournament.id}/join`,
      { method: "POST", cookie: lowPlayer.cookie },
    );
    assert.equal(rejectedJoin.status, 403);
    assert.equal(
      (await rejectedJoin.json()).error.code,
      "super8_category_restricted",
    );

    // listagem de abertos: some para quem está fora da categoria...
    const openForLow = await api("/api/v1/players/super8/open", {
      cookie: lowPlayer.cookie,
    });
    assert.ok(
      !(await openForLow.json()).data.tournaments.some(
        (item) => item.id === tournament.id,
      ),
    );
    // ...e aparece para quem está dentro, com as categorias visíveis
    const openForHigh = await api("/api/v1/players/super8/open", {
      cookie: highPlayer.cookie,
    });
    const visible = (await openForHigh.json()).data.tournaments.find(
      (item) => item.id === tournament.id,
    );
    assert.ok(visible);
    assert.deepEqual(visible.levelCategories, ["Avançado"]);

    // inscrição espontânea do jogador compatível funciona normalmente
    const okJoin = await api(`/api/v1/players/super8/${tournament.id}/join`, {
      method: "POST",
      cookie: highPlayer.cookie,
    });
    assert.equal(okJoin.status, 409); // já estava no quadro (adicionado manualmente)
  });
});

test("TASK-73: catálogo de conquistas do dono do perfil traz progresso atual/meta", async () => {
  await withTestServer(async ({ api }) => {
    const player = await registerPlayer(api, "conquistas");
    const mine = await api(
      `/api/v1/players/${player.user.id}/achievements`,
      { cookie: player.cookie },
    );
    assert.equal(mine.status, 200);
    const payload = (await mine.json()).data;
    assert.ok(payload.catalog.length > 0);
    const winsAchievement = payload.catalog.find((item) => item.id === "wins-1");
    assert.ok(winsAchievement);
    assert.equal(winsAchievement.progress.target, 1);
    assert.equal(winsAchievement.progress.current, 0);

    // outro jogador não vê o catálogo (nem o progresso) de terceiros
    const other = await registerPlayer(api, "curioso-conquistas");
    const theirsFromOutsider = await api(
      `/api/v1/players/${player.user.id}/achievements`,
      { cookie: other.cookie },
    );
    assert.equal((await theirsFromOutsider.json()).data.catalog.length, 0);
  });
});
