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
    path.join(os.tmpdir(), "padelfy-tasks20-test-"),
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
      email: `jogador-tasks20-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      phone: "11912345678",
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
      arenaName: `Arena Tasks20 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-tasks20-${suffix}@example.com`,
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
      name: "Quadra Tasks20",
      type: "covered",
      price: 160,
      opensAt: "06:00",
      closesAt: "23:00",
      slotDurationMinutes: 60,
    },
  });
  return { cookie, club, court: (await court.json()).data.court };
}

test("TASK-90: club edits name, startTime and grows size freely with players already registered", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "editar-basico");
    const player = await registerPlayer(api, "basico");
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Original",
        size: 8,
        mode: "rotacao",
        players: [{ id: player.user.id, name: "Ana" }],
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;

    const updated = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { name: "Super 8 Renomeado", startTime: "19:30", size: 12 },
    });
    assert.equal(updated.status, 200);
    const after = (await updated.json()).data.tournament;
    assert.equal(after.name, "Super 8 Renomeado");
    assert.equal(after.startTime, "19:30");
    assert.equal(after.size, 12);
    assert.equal(after.players.length, 1);
  });
});

test("TASK-90: reducing size below the current roster is blocked with a clear message", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "reduzir");
    const players = [];
    for (let index = 0; index < 9; index += 1) {
      players.push(await registerPlayer(api, `reduzir-${index}`));
    }
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Cheio",
        size: 16,
        mode: "rotacao",
        players: players.map((player, index) => ({
          id: player.user.id,
          name: `Jogador ${index}`,
        })),
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;

    const tooSmall = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { size: 8 },
    });
    assert.equal(tooSmall.status, 409);
    const error = await tooSmall.json();
    assert.equal(error.error.code, "super8_size_below_roster");
    assert.equal(error.error.details.currentPlayers, 9);

    // reducing to a size that still fits the roster is allowed
    const shrunkButFits = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { size: 12 },
    });
    assert.equal(shrunkButFits.status, 200);
    assert.equal((await shrunkButFits.json()).data.tournament.size, 12);
  });
});

test("TASK-90: changing level categories that disqualify registered players requires explicit confirmation", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "categorias-edicao");
    const lowPlayer = await registerPlayer(api, "baixa-edicao"); // Iniciante Intermediário
    const highPlayer = await registerPlayer(api, "alta-edicao", {
      answers: HIGH_ANSWERS,
    }); // Avançado

    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Misto",
        size: 8,
        mode: "rotacao",
        players: [
          { id: lowPlayer.user.id, name: "Baixa" },
          { id: highPlayer.user.id, name: "Alta" },
        ],
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;

    // restricting to "Avançado" would disqualify lowPlayer — needs confirmation
    const needsConfirmation = await api(
      `/api/v1/club/super8/${tournament.id}`,
      {
        method: "PATCH",
        cookie: clubAccount.cookie,
        body: { levelCategories: ["Avançado"] },
      },
    );
    assert.equal(needsConfirmation.status, 409);
    const confirmationError = await needsConfirmation.json();
    assert.equal(
      confirmationError.error.code,
      "super8_category_change_needs_confirmation",
    );
    assert.equal(confirmationError.error.details.affectedPlayers.length, 1);
    assert.equal(
      confirmationError.error.details.affectedPlayers[0].id,
      lowPlayer.user.id,
    );

    // explicit "keep": change applies, disqualified player stays
    const kept = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { levelCategories: ["Avançado"], onIneligiblePlayers: "keep" },
    });
    assert.equal(kept.status, 200);
    const keptTournament = (await kept.json()).data.tournament;
    assert.deepEqual(keptTournament.levelCategories, ["Avançado"]);
    assert.equal(keptTournament.players.length, 2);

    // now ask to remove instead, from a fresh restriction to the same set
    const removed = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: {
        levelCategories: ["Avançado", "Avançado Elevado"],
        onIneligiblePlayers: "remove",
      },
    });
    assert.equal(removed.status, 200);
    const removedTournament = (await removed.json()).data.tournament;
    assert.equal(removedTournament.players.length, 1);
    assert.equal(removedTournament.players[0].id, highPlayer.user.id);
  });
});

test("TASK-90: after games are generated only name and startTime remain editable", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "bloqueio-pos-geracao");
    const players = [];
    for (let index = 0; index < 8; index += 1) {
      players.push(await registerPlayer(api, `bloqueio-${index}`));
    }
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Completo",
        size: 8,
        mode: "rotacao",
        players: players.map((player, index) => ({
          id: player.user.id,
          name: `Jogador ${index}`,
        })),
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
    assert.equal(generated.status, 200);
    assert.equal((await generated.json()).data.tournament.status, "gerado");

    const blockedSize = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { size: 12 },
    });
    assert.equal(blockedSize.status, 409);
    assert.equal(
      (await blockedSize.json()).error.code,
      "super8_locked_after_generation",
    );

    const blockedCategories = await api(
      `/api/v1/club/super8/${tournament.id}`,
      {
        method: "PATCH",
        cookie: clubAccount.cookie,
        body: { levelCategories: ["Avançado"] },
      },
    );
    assert.equal(blockedCategories.status, 409);
    assert.equal(
      (await blockedCategories.json()).error.code,
      "super8_locked_after_generation",
    );

    const allowedSafeEdit = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { name: "Super 8 Renomeado Depois", startTime: "20:00" },
    });
    assert.equal(allowedSafeEdit.status, 200);
    const safeTournament = (await allowedSafeEdit.json()).data.tournament;
    assert.equal(safeTournament.name, "Super 8 Renomeado Depois");
    assert.equal(safeTournament.startTime, "20:00");
  });
});
