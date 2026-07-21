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
    path.join(os.tmpdir(), "quadrafy-domain-test-"),
  );
  let server;

  try {
    const app = await createApp({
      environment: "test",
      dataDirectory,
      frontendDirectory,
      sessionTtlHours: 1,
    });
    server = createServer(app.handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function api(pathname, { method = "GET", body, cookie } = {}) {
      return fetch(`${baseUrl}${pathname}`, {
        method,
        redirect: "manual",
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== "GET" ? { Origin: baseUrl } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
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

async function registerClub(api, suffix = "principal") {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Marina Costa",
      arenaName: `Arena Quadrafy ${suffix}`,
      cnpj: "12.345.678/0001-90",
      email: `clube-${suffix}@example.com`,
      password: "SenhaSeguraClube123",
      phone: "11912345678",
    },
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  return {
    cookie: cookieFrom(response),
    user: body.data.user,
  };
}

async function registerPlayer(api, suffix, { omitLevel = false } = {}) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: suffix === "dois" ? "Bruno" : "Ana",
      lastName: "Silva",
      email: `jogador-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      phone: "11912345678",
      city: "Sao Paulo",
      ...(!omitLevel ? { level: "Iniciante" } : {}),
    },
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  return {
    cookie: cookieFrom(response),
    user: body.data.user,
  };
}

function brazilDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function nextMonthDateKey(dateKey, day = 15) {
  const [year, month] = dateKey.split("-").map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDayOfMonthDateKey(dateKey) {
  const [year, month] = dateKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function shiftDateKey(dateKey, days) {
  const shifted = new Date(`${dateKey}T12:00:00-03:00`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return brazilDateKey(shifted);
}

function bookingStartAt(dateKey, time) {
  return new Date(`${dateKey}T${time}:00-03:00`).toISOString();
}

test("player registration does not require a self-declared level", async () => {
  await withTestServer(async ({ api }) => {
    const player = await registerPlayer(api, "sem-nivel", { omitLevel: true });

    assert.equal(player.user.role, "player");
    assert.equal(player.user.profile.firstName, "Ana");
    assert.equal(player.user.profile.lastName, "Silva");
  });
});

test("club, court, booking, open match and finance form one persisted flow", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api);

    const firstDashboard = await api("/api/v1/club/dashboard", {
      cookie: clubAccount.cookie,
    });
    assert.equal(firstDashboard.status, 200);
    const firstDashboardBody = await firstDashboard.json();
    const club = firstDashboardBody.data.club;
    assert.ok(club, "the first dashboard access must create the club arena");
    assert.equal(club.name, "Arena Quadrafy principal");

    const repeatedDashboard = await api("/api/v1/club/dashboard", {
      cookie: clubAccount.cookie,
    });
    assert.equal(repeatedDashboard.status, 200);
    assert.equal((await repeatedDashboard.json()).data.club.id, club.id);

    const clubsBeforeCourt = await api("/api/v1/clubs");
    assert.equal(clubsBeforeCourt.status, 200);
    assert.deepEqual((await clubsBeforeCourt.json()).data.clubs, []);

    const courtCreation = await api("/api/v1/club/courts", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Quadra Central",
        type: "covered",
        price: 180,
        opensAt: "07:00",
        closesAt: "23:00",
        slotDurationMinutes: 60,
      },
    });
    assert.equal(courtCreation.status, 201);
    const court = (await courtCreation.json()).data.court;
    assert.equal(court.clubId, club.id);
    assert.equal(court.name, "Quadra Central");
    assert.equal(court.type, "covered");
    assert.equal(court.price, 180);

    const ownerCourts = await api("/api/v1/club/courts", {
      cookie: clubAccount.cookie,
    });
    assert.equal(ownerCourts.status, 200);
    const ownerCourtList = (await ownerCourts.json()).data.courts;
    assert.equal(ownerCourtList.length, 1);
    assert.equal(ownerCourtList[0].id, court.id);

    const clubsAfterCourt = await api("/api/v1/clubs");
    assert.equal(clubsAfterCourt.status, 200);
    const publishedClubs = (await clubsAfterCourt.json()).data.clubs;
    assert.equal(publishedClubs.length, 1);
    assert.equal(publishedClubs[0].id, club.id);

    const player = await registerPlayer(api, "um", { omitLevel: true });
    const playerLevelTest = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: player.cookie,
      body: {
        tempo_pratica: 2,
        frequencia_semanal: 2,
        experiencia_esportes_raquete: 2,
        autoavaliacao_golpes: 2,
        experiencia_competicoes: 2,
        tatica_posicionamento: 2,
      },
    });
    assert.equal(playerLevelTest.status, 200);
    const privateBookingStart = bookingStartAt(
      shiftDateKey(brazilDateKey(), 30),
      "15:00",
    );
    const openBookingStart = bookingStartAt(
      shiftDateKey(brazilDateKey(), 31),
      "16:00",
    );

    const clubDetail = await api(`/api/v1/clubs/${club.id}`);
    assert.equal(clubDetail.status, 200);
    const detailedClub = (await clubDetail.json()).data.club;
    assert.equal(detailedClub.id, club.id);
    assert.equal(detailedClub.courts.length, 1);
    assert.equal(detailedClub.courts[0].id, court.id);

    const deactivation = await api(`/api/v1/club/courts/${court.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { active: false },
    });
    assert.equal(deactivation.status, 200);
    assert.equal((await deactivation.json()).data.court.active, false);
    assert.deepEqual(
      (await (await api("/api/v1/clubs")).json()).data.clubs,
      [],
    );

    const reactivation = await api(`/api/v1/club/courts/${court.id}`, {
      method: "PATCH",
      cookie: clubAccount.cookie,
      body: { active: true },
    });
    assert.equal(reactivation.status, 200);
    assert.equal((await reactivation.json()).data.court.active, true);

    const pixBookingCreation = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: player.cookie,
      body: {
        clubId: club.id,
        courtId: court.id,
        startAt: privateBookingStart,
        visibility: "private",
      },
    });
    assert.equal(pixBookingCreation.status, 201);
    const pixBooking = (await pixBookingCreation.json()).data.booking;
    assert.equal(pixBooking.playerId, player.user.id);
    assert.equal(pixBooking.courtId, court.id);
    assert.equal(pixBooking.referencePrice, 180);
    assert.equal(pixBooking.status, "confirmed");
    assert.equal(pixBooking.visibility, "private");

    const playerBookings = await api("/api/v1/player/bookings", {
      cookie: player.cookie,
    });
    assert.equal(playerBookings.status, 200);
    const initialBookingList = (await playerBookings.json()).data.bookings;
    assert.equal(initialBookingList.length, 1);
    assert.equal(initialBookingList[0].id, pixBooking.id);

    const occupancyBeforeOpenBooking = await api("/api/v1/club/finance", {
      cookie: clubAccount.cookie,
    });
    assert.equal(occupancyBeforeOpenBooking.status, 200);
    assert.equal(
      (await occupancyBeforeOpenBooking.json()).data.summary.totalGames,
      1,
    );

    const matchesBeforeOpenBooking = await api("/api/v1/matches", {
      cookie: player.cookie,
    });
    assert.equal(matchesBeforeOpenBooking.status, 200);
    assert.deepEqual((await matchesBeforeOpenBooking.json()).data.matches, []);

    const openBookingCreation = await api("/api/v1/player/bookings", {
      method: "POST",
      cookie: player.cookie,
      body: {
        clubId: club.id,
        courtId: court.id,
        startAt: openBookingStart,
        visibility: "open",
        levelMin: 0.5,
        levelMax: 7,
        availableSpots: 2,
      },
    });
    assert.equal(openBookingCreation.status, 201);
    const openBooking = (await openBookingCreation.json()).data.booking;
    assert.equal(openBooking.visibility, "open");

    const openMatches = await api("/api/v1/matches", {
      cookie: player.cookie,
    });
    assert.equal(openMatches.status, 200);
    const matches = (await openMatches.json()).data.matches;
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, openBooking.id);
    assert.equal(matches[0].availableSpots, 3);

    const matchDetail = await api(`/api/v1/matches/${openBooking.id}`, {
      cookie: player.cookie,
    });
    assert.equal(matchDetail.status, 200);
    const initialMatch = (await matchDetail.json()).data.match;
    assert.equal(initialMatch.id, openBooking.id);
    assert.equal(initialMatch.availableSpots, 3);
    assert.equal(initialMatch.teams.team1[0].id, player.user.id);
    assert.equal(initialMatch.teams.team1[1], null);
    assert.ok(
      initialMatch.players.some(
        (confirmedPlayer) => confirmedPlayer.id === player.user.id,
      ),
      "the booking creator must be a confirmed player",
    );

    const secondPlayer = await registerPlayer(api, "dois", {
      omitLevel: true,
    });
    const secondPlayerLevelTest = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: secondPlayer.cookie,
      body: {
        tempo_pratica: 2,
        frequencia_semanal: 2,
        experiencia_esportes_raquete: 2,
        autoavaliacao_golpes: 2,
        experiencia_competicoes: 2,
        tatica_posicionamento: 2,
      },
    });
    assert.equal(secondPlayerLevelTest.status, 200);
    const join = await api(`/api/v1/matches/${openBooking.id}/join`, {
      method: "POST",
      cookie: secondPlayer.cookie,
      body: { team: "team2", slot: 1 },
    });
    assert.equal(join.status, 200);
    const joinedMatch = (await join.json()).data.match;
    assert.equal(joinedMatch.availableSpots, 2);
    assert.equal(joinedMatch.teams.team2[1].id, secondPlayer.user.id);
    assert.ok(
      joinedMatch.players.some(
        (confirmedPlayer) => confirmedPlayer.id === secondPlayer.user.id,
      ),
    );

    const persistedMatchDetail = await api(
      `/api/v1/matches/${openBooking.id}`,
      { cookie: secondPlayer.cookie },
    );
    assert.equal(persistedMatchDetail.status, 200);
    const persistedMatch = (await persistedMatchDetail.json()).data.match;
    assert.equal(persistedMatch.availableSpots, 2);
    assert.equal(persistedMatch.players.length, 2);

    const forbiddenReorganization = await api(
      `/api/v1/matches/${openBooking.id}/teams`,
      {
        method: "PATCH",
        cookie: secondPlayer.cookie,
        body: {
          team1: [player.user.id, secondPlayer.user.id],
          team2: [null, null],
        },
      },
    );
    assert.equal(forbiddenReorganization.status, 403);

    const reorganization = await api(
      `/api/v1/matches/${openBooking.id}/teams`,
      {
        method: "PATCH",
        cookie: player.cookie,
        body: {
          team1: [player.user.id, secondPlayer.user.id],
          team2: [null, null],
        },
      },
    );
    assert.equal(reorganization.status, 200);
    const reorganizedMatch = (await reorganization.json()).data.match;
    assert.equal(reorganizedMatch.teams.team1[1].id, secondPlayer.user.id);

    const duplicateJoin = await api(`/api/v1/matches/${openBooking.id}/join`, {
      method: "POST",
      cookie: secondPlayer.cookie,
    });
    assert.equal(duplicateJoin.status, 409);
    assert.equal((await duplicateJoin.json()).error.code, "already_joined");

    const finance = await api("/api/v1/club/finance", {
      cookie: clubAccount.cookie,
    });
    assert.equal(finance.status, 200);
    const financeData = (await finance.json()).data;
    assert.equal(financeData.summary.totalGames, 2);
    assert.equal(financeData.byCourt.length, 1);
    assert.equal(financeData.byCourt[0].courtId, court.id);
    assert.equal(financeData.byCourt[0].games, 2);
    assert.equal(
      financeData.gamesByDay.reduce((total, day) => total + day.games, 0),
      2,
    );
    assert.equal(financeData.occupancyByCourt.length, 1);
    assert.equal(
      financeData.byVisibility.find((item) => item.visibility === "private")
        .games,
      1,
    );
    assert.equal(
      financeData.byVisibility.find((item) => item.visibility === "open")
        .games,
      1,
    );
    assert.equal(typeof financeData.previousPeriod.games, "number");
    assert.equal(financeData.bookings.length, 2);
    assert.ok(
      financeData.bookings.every((booking) => booking.courtId === court.id),
    );
  });
});

test("monthly occupancy includes future and late month-end games but excludes the next month", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "financeiro-mensal");
    const dashboard = await api("/api/v1/club/dashboard", {
      cookie: clubAccount.cookie,
    });
    assert.equal(dashboard.status, 200);
    const club = (await dashboard.json()).data.club;

    const courtCreation = await api("/api/v1/club/courts", {
      method: "POST",
      cookie: clubAccount.cookie,
      body: {
        name: "Quadra Financeiro",
        type: "covered",
        price: 180,
        opensAt: "07:00",
        closesAt: "23:00",
        slotDurationMinutes: 60,
      },
    });
    assert.equal(courtCreation.status, 201);
    const court = (await courtCreation.json()).data.court;
    const player = await registerPlayer(api, "financeiro-mensal", {
      omitLevel: true,
    });

    const today = brazilDateKey();
    const tomorrow = brazilDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const currentMonthDate =
      tomorrow.slice(0, 7) === today.slice(0, 7) ? tomorrow : today;
    const nextMonthDate = nextMonthDateKey(today);

    async function createGame(date, time) {
      const creation = await api("/api/v1/player/bookings", {
        method: "POST",
        cookie: player.cookie,
        body: {
          clubId: club.id,
          courtId: court.id,
          startAt: bookingStartAt(date, time),
          visibility: "private",
        },
      });
      assert.equal(creation.status, 201);
      return (await creation.json()).data.booking;
    }

    const currentMonthBooking = await createGame(currentMonthDate, "18:00");
    const monthEndBooking = await createGame(
      lastDayOfMonthDateKey(today),
      "22:00",
    );
    await createGame(nextMonthDate, "19:00");

    const monthlyFinance = await api("/api/v1/club/finance?period=month", {
      cookie: clubAccount.cookie,
    });
    assert.equal(monthlyFinance.status, 200);
    const financeData = (await monthlyFinance.json()).data;
    assert.equal(financeData.summary.totalGames, 2);
    assert.deepEqual(
      financeData.bookings.map((booking) => booking.id),
      [currentMonthBooking.id, monthEndBooking.id],
    );
  });
});

test("domain routes return 403 when the authenticated role is wrong", async () => {
  await withTestServer(async ({ api }) => {
    const clubAccount = await registerClub(api, "permissoes");
    const player = await registerPlayer(api, "permissoes");

    const clubReadingPlayerBookings = await api("/api/v1/player/bookings", {
      cookie: clubAccount.cookie,
    });
    assert.equal(clubReadingPlayerBookings.status, 403);

    const playerReadingClubCourts = await api("/api/v1/club/courts", {
      cookie: player.cookie,
    });
    assert.equal(playerReadingClubCourts.status, 403);

    const playerReadingClubFinance = await api("/api/v1/club/finance", {
      cookie: player.cookie,
    });
    assert.equal(playerReadingClubFinance.status, 403);

    const clubJoiningMatch = await api("/api/v1/matches/not-a-match/join", {
      method: "POST",
      cookie: clubAccount.cookie,
    });
    assert.equal(clubJoiningMatch.status, 403);
  });
});
