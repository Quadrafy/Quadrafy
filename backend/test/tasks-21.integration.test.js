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
    path.join(os.tmpdir(), "quadrafy-tasks21-test-"),
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
      email: `jogador-tasks21-${suffix}@example.com`,
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
      arenaName: `Arena Tasks21 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-tasks21-${suffix}@example.com`,
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
      name: "Quadra Tasks21",
      type: "covered",
      price: 160,
      opensAt: "06:00",
      closesAt: "23:00",
      slotDurationMinutes: 60,
    },
  });
  return { cookie, club, court: (await court.json()).data.court };
}

test("TASK-93: club adds a registered player and a guest to an existing Super 8", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "adicionar-basico");
    const player = await registerPlayer(api, "existente");
    const newPlayer = await registerPlayer(api, "novo");
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Adicionar",
        size: 8,
        mode: "rotacao",
        players: [{ id: player.user.id, name: "Ana" }],
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;

    const added = await api(
      `/api/v1/club/super8/${tournament.id}/players`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: {
          players: [{ id: newPlayer.user.id, name: "Nova Jogadora" }],
        },
      },
    );
    assert.equal(added.status, 201);
    const afterLinked = (await added.json()).data.tournament;
    assert.equal(afterLinked.players.length, 2);
    assert.ok(
      afterLinked.players.some((item) => item.id === newPlayer.user.id),
    );

    const addedGuest = await api(
      `/api/v1/club/super8/${tournament.id}/players`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { players: [{ id: null, name: "Convidado Sem Conta" }] },
      },
    );
    assert.equal(addedGuest.status, 201);
    const afterGuest = (await addedGuest.json()).data.tournament;
    assert.equal(afterGuest.players.length, 3);
    assert.ok(
      afterGuest.players.some(
        (item) => item.id === null && item.name === "Convidado Sem Conta",
      ),
    );
  });
});

test("TASK-93: adding players beyond the tournament size is rejected", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "estourar-tamanho");
    const players = [];
    for (let index = 0; index < 8; index += 1) {
      players.push(await registerPlayer(api, `estourar-${index}`));
    }
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Cheio",
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

    const extra = await registerPlayer(api, "extra-estourar");
    const rejected = await api(
      `/api/v1/club/super8/${tournament.id}/players`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { players: [{ id: extra.user.id, name: "Extra" }] },
      },
    );
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, "super8_full");
  });
});

test("TASK-93: adding a player outside the tournament's level categories is rejected", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "categoria-restrita");
    const highPlayer = await registerPlayer(api, "alta-restrita", {
      answers: HIGH_ANSWERS,
    });
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

    const lowPlayer = await registerPlayer(api, "baixa-restrita");
    const rejected = await api(
      `/api/v1/club/super8/${tournament.id}/players`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { players: [{ id: lowPlayer.user.id, name: "Baixa" }] },
      },
    );
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "validation_failed");
  });
});

test("TASK-93: adding players after games are generated is blocked", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "bloqueio-add");
    const players = [];
    for (let index = 0; index < 8; index += 1) {
      players.push(await registerPlayer(api, `bloqueio-add-${index}`));
    }
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Gerado",
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

    const extra = await registerPlayer(api, "extra-bloqueio-add");
    const rejected = await api(
      `/api/v1/club/super8/${tournament.id}/players`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { players: [{ id: extra.user.id, name: "Extra" }] },
      },
    );
    assert.equal(rejected.status, 409);
    assert.equal(
      (await rejected.json()).error.code,
      "super8_locked_after_generation",
    );
  });
});

test("TASK-93: adding a player already registered in the tournament is rejected", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "duplicado");
    const player = await registerPlayer(api, "duplicado-jogador");
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Duplicado",
        size: 8,
        mode: "rotacao",
        players: [{ id: player.user.id, name: "Ana" }],
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;

    const rejected = await api(
      `/api/v1/club/super8/${tournament.id}/players`,
      {
        method: "POST",
        cookie: clubAccount.cookie,
        body: { players: [{ id: player.user.id, name: "Ana" }] },
      },
    );
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "validation_failed");
  });
});

test("TASK-96: a court with hours crossing midnight (06:00-01:00) is accepted", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "meia-noite-cadastro");
    const created = await api("/api/v1/club/courts", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Quadra Noturna",
        type: "outdoor",
        price: 120,
        opensAt: "06:00",
        closesAt: "01:00",
        slotDurationMinutes: 60,
      },
    });
    assert.equal(created.status, 201);
    const court = (await created.json()).data.court;
    assert.equal(court.openTime ?? court.opensAt, "06:00");
    assert.equal(court.closeTime ?? court.closesAt, "01:00");
  });
});

test("TASK-96: a court with equal open/close hours (zero-length window) is rejected", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "meia-noite-igual");
    const rejected = await api("/api/v1/club/courts", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Quadra Inválida",
        type: "outdoor",
        price: 120,
        opensAt: "10:00",
        closesAt: "10:00",
        slotDurationMinutes: 60,
      },
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "validation_failed");
  });
});

test("TASK-96: the availability grid includes slots that cross midnight, and a wrapped slot can be booked", async () => {
  await withTestServer(async ({ api }) => {
    const clubResponse = await api("/api/v1/auth/register", {
      method: "POST",
      body: {
        role: "club",
        responsibleName: "Marina Costa",
        arenaName: "Arena Meia-Noite",
        cnpj: "12.345.678/0001-90",
        email: "clube-meia-noite@example.com",
        password: "SenhaSeguraClube123",
        phone: "11987654321",
      },
    });
    assert.equal(clubResponse.status, 201);
    const clubCookie = cookieFrom(clubResponse);
    const dashboard = await api("/api/v1/club/dashboard", { cookie: clubCookie });
    const club = (await dashboard.json()).data.club;
    const courtResponse = await api("/api/v1/club/courts", {
      method: "POST",
      cookie: clubCookie,
      body: {
        name: "Quadra Noturna",
        type: "outdoor",
        price: 120,
        opensAt: "06:00",
        closesAt: "01:00",
        slotDurationMinutes: 60,
      },
    });
    const court = (await courtResponse.json()).data.court;

    const player = await registerPlayer(api, "meia-noite-jogador");

    // Pick "today" in the club's own timezone so the wrapped late-night
    // slot (23:00) is still in the future relative to the test run.
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const clubDetail = await api(
      `/api/v1/clubs/${club.id}?date=${today}`,
      { cookie: player.cookie },
    );
    assert.equal(clubDetail.status, 200);
    const { availability } = (await clubDetail.json()).data;
    const courtAvailability = availability.find(
      (item) => item.courtId === court.id,
    );
    assert.ok(courtAvailability);
    const times = courtAvailability.slots.map((slot) => slot.time);
    // até pouco antes do fechamento (01:00), cruzando a meia-noite
    assert.ok(times.includes("23:00"));
    assert.ok(times.includes("00:00"));
    // não deve criar um horário completo às 00:30 → 01:30 (passaria do
    // fechamento); o último slot antes de 01:00 é 00:00.
    assert.ok(!times.includes("00:30"));

    const wrappedSlot = courtAvailability.slots.find(
      (slot) => slot.time === "00:00",
    );
    assert.ok(wrappedSlot);

    const bookingResponse = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: player.cookie,
      body: {
        clubId: club.id,
        courtId: court.id,
        startAt: wrappedSlot.startAt,
      },
    });
    assert.equal(bookingResponse.status, 201);
  });
});

test("TASK-95: club sets the tournament date on creation and edits it later", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "data-torneio");
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Com Data",
        size: 8,
        mode: "rotacao",
        players: [],
        date: "2026-08-15",
        startTime: "19:00",
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    assert.equal(tournament.date, "2026-08-15");
    assert.equal(tournament.startTime, "19:00");

    const updated = await api(`/api/v1/club/super8/${tournament.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { date: "2026-08-22" },
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.tournament.date, "2026-08-22");
  });
});

test("TASK-95: an invalid date is rejected on creation", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "data-invalida");
    const rejected = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Data Ruim",
        size: 8,
        mode: "rotacao",
        players: [],
        date: "15/08/2026",
      },
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "validation_failed");
  });
});

// TASK-97 — auditoria: um jogo recém-criado pelo fluxo "Criar Jogo"
// (TASK-79/88/92) precisa aparecer imediatamente em GET /api/v1/matches
// para outros jogadores compatíveis, e em GET /api/v1/player/bookings para
// quem criou. Não foi possível reproduzir o bug relatado no código atual —
// este teste trava o comportamento correto como regressão.
test("TASK-97: a freshly created open game appears in matches for other players and in the creator's bookings", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "jogo-aberto-97");
    const creator = await registerPlayer(api, "criador-97");
    const other = await registerPlayer(api, "outro-97");

    const slotStart = new Date();
    slotStart.setDate(slotStart.getDate() + 1);
    slotStart.setHours(10, 0, 0, 0);
    const startAt = slotStart.toISOString();

    const created = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: creator.cookie,
      body: {
        clubId: clubAccount.club.id,
        courtId: clubAccount.court.id,
        startAt,
        levelCategories: null,
        genderCategory: "all",
      },
    });
    assert.equal(created.status, 201);
    const booking = (await created.json()).data.booking;
    assert.equal(booking.status, "confirmed");

    const matchesForOther = await api("/api/v1/matches", {
      cookie: other.cookie,
    });
    assert.equal(matchesForOther.status, 200);
    const otherMatches = (await matchesForOther.json()).data.matches;
    const found = otherMatches.find((match) => match.id === booking.id);
    assert.ok(found, "newly created game must appear in /matches for other players");
    assert.equal(found.availableSpots, 3);

    const creatorBookings = await api("/api/v1/player/bookings", {
      cookie: creator.cookie,
    });
    assert.equal(creatorBookings.status, 200);
    const creatorBookingIds = (await creatorBookings.json()).data.bookings.map(
      (item) => item.id,
    );
    assert.ok(creatorBookingIds.includes(booking.id));
  });
});
