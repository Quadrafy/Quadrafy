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
    path.join(os.tmpdir(), "padelfy-tasks14-test-"),
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

async function registerPlayer(api, suffix, extra = {}) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      gender: "male",
      firstName: "Ana",
      lastName: `Silva ${suffix}`,
      email: `jogador-tasks14-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      phone: "(11) 91234-5678",
      city: "Sao Paulo",
      ...extra,
    },
  });
  if (response.status !== 201) return { response };
  const cookie = cookieFrom(response);
  const payload = await response.json();
  const levelTest = await api("/api/v1/player/level-test", {
    method: "POST",
    cookie,
    body: {
      q1: 2,
      q2: 2,
      q3: 2,
      q4: 2,
      q5: 2,
      q6: 2,
      q7: 2,
    },
  });
  assert.equal(levelTest.status, 200);
  return { response, cookie, user: payload.data.user };
}

async function registerClubWithCourt(api, suffix = "principal") {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: `Arena Tasks14 ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-tasks14-${suffix}@example.com`,
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
      name: "Quadra Tasks14",
      type: "covered",
      price: 160,
      opensAt: "06:00",
      closesAt: "23:00",
      slotDurationMinutes: 60,
    },
  });
  return { cookie, club, court: (await court.json()).data.court };
}

function bookingStartAt(daysAhead) {
  const value = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
  return new Date(`${key}T10:00:00-03:00`).toISOString();
}

test("TASK-58: phone required on registration, normalized, editable later; legacy accounts unaffected", async () => {
  await withTestServer(async ({ api, app }) => {
    // sem telefone → 422
    const noPhone = await api("/api/v1/auth/register", {
      method: "POST",
      body: {
        role: "player",
        gender: "male",
        firstName: "Ana",
        lastName: "Sem Telefone",
        email: "sem-telefone@example.com",
        password: "SenhaSeguraJogador123",
        city: "Sao Paulo",
      },
    });
    assert.equal(noPhone.status, 422);
    const badPhone = await registerPlayer(api, "fone-curto", {
      phone: "12345",
      email: "fone-curto@example.com",
    });
    assert.equal(badPhone.response.status, 422);

    // com máscara → normalizado para dígitos e persistido no perfil
    const ok = await registerPlayer(api, "fone-ok");
    assert.equal(ok.response.status, 201);
    const me = await api("/api/v1/auth/me", { cookie: ok.cookie });
    assert.equal((await me.json()).data.user.profile.phone, "11912345678");

    // editável depois
    const update = await api("/api/v1/player/profile", {
      method: "PATCH",
      cookie: ok.cookie,
      body: { phone: "(21) 3222-1111" },
    });
    assert.equal(update.status, 200);
    const after = await api("/api/v1/auth/me", { cookie: ok.cookie });
    assert.equal((await after.json()).data.user.profile.phone, "2132221111");

    // conta "legada" (sem phone no perfil) continua logando e usando tudo
    const legacy = app.users.findByEmail("jogador-tasks14-fone-ok@example.com");
    delete legacy.profile.phone;
    await app.users.persist();
    const login = await api("/api/v1/auth/login", {
      method: "POST",
      body: {
        email: "jogador-tasks14-fone-ok@example.com",
        password: "SenhaSeguraJogador123",
      },
    });
    assert.equal(login.status, 200);
  });
});

test("TASK-59: Super 8 event start time in 30-minute steps, shown in views", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "super8");
    const guests = Array.from({ length: 8 }, (_, index) => ({
      id: null,
      name: `Convidado ${index + 1}`,
    }));
    const badTime = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Quebrado",
        size: 8,
        mode: "rotacao",
        players: guests,
        startTime: "19:15",
      },
    });
    assert.equal(badTime.status, 422);

    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 das 19h",
        size: 8,
        mode: "rotacao",
        players: guests,
        startTime: "19:00",
      },
    });
    assert.equal(created.status, 201);
    const tournament = (await created.json()).data.tournament;
    assert.equal(tournament.startTime, "19:00");

    // TASK-43 preservada: gerar não cria horário por jogo
    await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [clubAccount.court.id] },
    });
    const generated = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    const withGames = (await generated.json()).data.tournament;
    assert.equal(withGames.startTime, "19:00");
    assert.ok(withGames.games.every((game) => !("startAt" in game)));
  });
});

test("TASK-60: creator adds players at open-match creation (confirmed, positioned, validated)", async () => {
  await withTestServer(async ({ api }) => {
    const infra = await registerClubWithCourt(api, "convites");
    const creator = await registerPlayer(api, "criadora");
    const friendA = await registerPlayer(api, "amiga-a");
    const friendB = await registerPlayer(api, "amigo-b");
    const stranger = await registerPlayer(api, "de-fora");

    // mais de 3 convidados → 422; convidar a si mesmo → 422
    const tooMany = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: creator.cookie,
      body: {
        clubId: infra.club.id,
        courtId: infra.court.id,
        startAt: bookingStartAt(30),
        paymentMethod: "pix",
        levelCategories: null,
        availableSpots: 3,
        invitedPlayerIds: [
          friendA.user.id,
          friendB.user.id,
          stranger.user.id,
          creator.user.id,
        ],
      },
    });
    assert.equal(tooMany.status, 422);

    const created = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: creator.cookie,
      body: {
        clubId: infra.club.id,
        courtId: infra.court.id,
        startAt: bookingStartAt(30),
        paymentMethod: "pix",
        levelCategories: null,
        availableSpots: 3,
        invitedPlayerIds: [friendA.user.id, friendB.user.id],
      },
    });
    assert.equal(created.status, 201);
    const booking = (await created.json()).data.booking;
    // criadora + 2 convidadas confirmadas → 1 vaga restante
    assert.equal(booking.openSpots, 1);
    assert.deepEqual(booking.teams.team1, [creator.user.id, friendA.user.id]);
    assert.equal(booking.teams.team2[0], friendB.user.id);

    // a vaga restante segue aberta para o join normal
    const join = await api(`/api/v1/matches/${booking.id}/join`, {
      method: "POST",
      cookie: stranger.cookie,
      body: { team: "team2", slot: 1 },
    });
    assert.equal(join.status, 200);
  });
});

test("TASK-60 + TASKS-11: invited players respect the mixed-gender pairing rule", async () => {
  await withTestServer(async ({ api }) => {
    const infra = await registerClubWithCourt(api, "misto");
    const creator = await registerPlayer(api, "criadora-mista");
    await api("/api/v1/player/profile", {
      method: "PATCH",
      cookie: creator.cookie,
      body: { gender: "female" },
    });
    const woman = await registerPlayer(api, "mulher");
    await api("/api/v1/player/profile", {
      method: "PATCH",
      cookie: woman.cookie,
      body: { gender: "female" },
    });
    // convidar outra mulher para a mesma dupla da criadora quebra o misto
    const invalid = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: creator.cookie,
      body: {
        clubId: infra.club.id,
        courtId: infra.court.id,
        startAt: bookingStartAt(31),
        paymentMethod: "pix",
        levelCategories: null,
        availableSpots: 3,
        genderCategory: "mixed",
        invitedPlayerIds: [woman.user.id],
      },
    });
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json()).error.code, "gender_mix_required");
  });
});

test("TASK-61/62: full matches vanish from the public list but stay visible to participants", async () => {
  await withTestServer(async ({ api }) => {
    const infra = await registerClubWithCourt(api, "cheias");
    const creator = await registerPlayer(api, "dona");
    const a = await registerPlayer(api, "p-a");
    const b = await registerPlayer(api, "p-b");
    const c = await registerPlayer(api, "p-c");
    const outsider = await registerPlayer(api, "curioso");

    const created = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: creator.cookie,
      body: {
        clubId: infra.club.id,
        courtId: infra.court.id,
        startAt: bookingStartAt(32),
        paymentMethod: "pix",
        levelCategories: null,
        availableSpots: 3,
        invitedPlayerIds: [a.user.id, b.user.id],
      },
    });
    const booking = (await created.json()).data.booking;

    // com 1 vaga: aparece para todos
    let list = (
      await (await api("/api/v1/matches", { cookie: outsider.cookie })).json()
    ).data.matches;
    assert.ok(list.some((match) => match.id === booking.id));

    // completa a 4ª vaga → some para quem não participa
    await api(`/api/v1/matches/${booking.id}/join`, {
      method: "POST",
      cookie: c.cookie,
      body: { team: "team2", slot: 1 },
    });
    list = (
      await (await api("/api/v1/matches", { cookie: outsider.cookie })).json()
    ).data.matches;
    assert.ok(!list.some((match) => match.id === booking.id));

    // participantes seguem vendo (base do "Meus jogos" da TASK-62)
    for (const participant of [creator, a, c]) {
      const mine = (
        await (
          await api("/api/v1/matches", { cookie: participant.cookie })
        ).json()
      ).data.matches;
      assert.ok(mine.some((match) => match.id === booking.id));
    }
    // e o chat/detalhe continua acessível para participante
    const detail = await api(`/api/v1/matches/${booking.id}/messages`, {
      cookie: a.cookie,
    });
    assert.equal(detail.status, 200);
  });
});

test("TASK-63: club closes Super 8 registrations at will; generation still requires exact size", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClubWithCourt(api, "inscricoes");
    const created = await api("/api/v1/club/super8", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Super 8 Aberto",
        size: 8,
        mode: "rotacao",
        players: Array.from({ length: 5 }, (_, index) => ({
          id: null,
          name: `Manual ${index + 1}`,
        })),
        startTime: "18:30",
      },
    });
    const tournament = (await created.json()).data.tournament;
    await api(`/api/v1/club/super8/${tournament.id}/courts`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { courtIds: [clubAccount.court.id] },
    });
    await api(`/api/v1/club/super8/${tournament.id}/open-registrations`, {
      method: "POST",
      cookie: clubAccount.cookie,
    });

    const player = await registerPlayer(api, "espontanea");
    const join = await api(`/api/v1/players/super8/${tournament.id}/join`, {
      method: "POST",
      cookie: player.cookie,
    });
    assert.equal(join.status, 200);

    // clube fecha as inscrições com vagas sobrando (6/8)
    const closed = await api(
      `/api/v1/club/super8/${tournament.id}/close-registrations`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(closed.status, 200);
    const afterClose = (await closed.json()).data.tournament;
    assert.equal(afterClose.status, "em_configuracao");
    assert.equal(afterClose.players.length, 6);
    // inscrição manual + espontânea aparecem juntas
    assert.ok(afterClose.players.some((p) => p.id === player.user.id));
    assert.ok(afterClose.players.some((p) => p.name === "Manual 1"));

    // gerar com 6/8 → bloqueado (regra do número exato mantida)
    const generate = await api(
      `/api/v1/club/super8/${tournament.id}/generate`,
      { method: "POST", cookie: clubAccount.cookie },
    );
    assert.equal(generate.status, 409);
    assert.equal(
      (await generate.json()).error.code,
      "super8_roster_incomplete",
    );
  });
});
