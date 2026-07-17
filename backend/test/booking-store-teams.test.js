import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BookingStore } from "../src/stores/booking-store.js";

async function withStore(run, seed = null) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-booking-teams-test-"),
  );

  try {
    if (seed) {
      await writeFile(
        path.join(dataDirectory, "bookings.json"),
        `${JSON.stringify(seed, null, 2)}\n`,
        "utf8",
      );
    }

    const store = new BookingStore(dataDirectory);
    await store.initialize();
    await run({ dataDirectory, store });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function persistedBooking(dataDirectory, bookingId) {
  const contents = await readFile(
    path.join(dataDirectory, "bookings.json"),
    "utf8",
  );
  return JSON.parse(contents).find((booking) => booking.id === bookingId);
}

async function createOpenBooking(store) {
  return store.create({
    playerId: "player-owner",
    clubId: "club-1",
    courtId: "court-1",
    startAt: "2099-08-10T22:00:00.000Z",
    price: 120,
    paymentMethod: "pix",
    visibility: "open",
    levelMin: 2,
    levelMax: 4,
    maxPlayers: 4,
  });
}

test("creates an open booking with four explicit team positions", async () => {
  await withStore(async ({ dataDirectory, store }) => {
    const booking = await createOpenBooking(store);
    const persisted = await persistedBooking(dataDirectory, booking.id);
    const expectedTeams = {
      team1: ["player-owner", null],
      team2: [null, null],
    };

    assert.deepEqual(booking.teams, expectedTeams);
    assert.deepEqual(booking.participantIds, ["player-owner"]);
    assert.equal(booking.openSpots, 3);
    assert.deepEqual(persisted.teams, expectedTeams);
  });
});

test("joins an open booking in the requested empty team position", async () => {
  await withStore(async ({ dataDirectory, store }) => {
    const booking = await createOpenBooking(store);

    const joined = await store.join(booking.id, "player-guest", {
      team: "team2",
      slot: 1,
    });
    const persisted = await persistedBooking(dataDirectory, booking.id);

    assert.deepEqual(joined.teams, {
      team1: ["player-owner", null],
      team2: [null, "player-guest"],
    });
    assert.deepEqual(joined.participantIds, ["player-owner", "player-guest"]);
    assert.equal(joined.openSpots, 2);
    assert.deepEqual(persisted.teams, joined.teams);
  });
});

test("rejects joining an occupied position", async () => {
  await withStore(async ({ store }) => {
    const booking = await createOpenBooking(store);
    await assert.rejects(
      store.join(booking.id, "player-guest", { team: "team1", slot: 0 }),
      (error) => error.code === "match_position_taken" && error.status === 409,
    );
  });
});

test("only the organizer can rearrange the same four participants", async () => {
  await withStore(async ({ dataDirectory, store }) => {
    const booking = await createOpenBooking(store);
    await store.join(booking.id, "player-b", { team: "team1", slot: 1 });
    await store.join(booking.id, "player-c", { team: "team2", slot: 0 });
    await store.join(booking.id, "player-d", { team: "team2", slot: 1 });
    const teams = {
      team1: ["player-owner", "player-d"],
      team2: ["player-b", "player-c"],
    };

    await assert.rejects(
      store.reorganizeTeams(booking.id, "player-b", teams),
      (error) => error.code === "match_organizer_required" && error.status === 403,
    );
    const updated = await store.reorganizeTeams(
      booking.id,
      "player-owner",
      teams,
    );
    assert.deepEqual(updated.teams, teams);
    assert.deepEqual((await persistedBooking(dataDirectory, booking.id)).teams, teams);
    await assert.rejects(
      store.reorganizeTeams(booking.id, "player-owner", {
        team1: ["player-owner", "player-b"],
        team2: ["player-c", null],
      }),
      (error) => error.code === "invalid_match_teams" && error.status === 422,
    );
  });
});

test("migrates a legacy participant list into explicit positions", async () => {
  const legacy = {
    id: "legacy-match",
    playerId: "player-owner",
    clubId: "club-1",
    courtId: "court-1",
    startAt: "2099-08-10T22:00:00.000Z",
    price: 120,
    paymentMethod: "pix",
    paymentStatus: "pending",
    visibility: "open",
    maxPlayers: 4,
    participantIds: ["player-owner", "player-b", "player-c"],
    status: "confirmed",
  };
  await withStore(
    async ({ dataDirectory, store }) => {
      const migrated = store.findById(legacy.id);
      assert.deepEqual(migrated.teams, {
        team1: ["player-owner", "player-b"],
        team2: ["player-c", null],
      });
      assert.deepEqual(
        (await persistedBooking(dataDirectory, legacy.id)).teams,
        migrated.teams,
      );
    },
    [legacy],
  );
});
