import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BookingStore } from "../src/stores/booking-store.js";

async function withStore(run) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "quadrafy-booking-store-test-"),
  );

  try {
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

test("persists three open spots when an open four-player booking is created", async () => {
  await withStore(async ({ dataDirectory, store }) => {
    const booking = await createOpenBooking(store);
    const persisted = await persistedBooking(dataDirectory, booking.id);

    assert.equal(booking.openSpots, 3);
    assert.equal(persisted.openSpots, 3);
  });
});

test("recalculates and persists open spots when a player joins", async () => {
  await withStore(async ({ dataDirectory, store }) => {
    const booking = await createOpenBooking(store);

    const joined = await store.join(booking.id, "player-guest");
    const persisted = await persistedBooking(dataDirectory, booking.id);

    assert.deepEqual(joined.participantIds, ["player-owner", "player-guest"]);
    assert.equal(joined.openSpots, 2);
    assert.equal(persisted.openSpots, 2);
  });
});

test("recalculates and persists open spots when a participant leaves", async () => {
  await withStore(async ({ dataDirectory, store }) => {
    const booking = await createOpenBooking(store);
    await store.join(booking.id, "player-guest");

    const left = await store.leave(booking.id, "player-guest");
    const persisted = await persistedBooking(dataDirectory, booking.id);

    assert.deepEqual(left.participantIds, ["player-owner"]);
    assert.equal(left.openSpots, 3);
    assert.equal(persisted.openSpots, 3);
  });
});

test("sets zero spots for private bookings and restores capacity when reopened", async () => {
  await withStore(async ({ dataDirectory, store }) => {
    const booking = await createOpenBooking(store);

    const privateBooking = await store.updateByOwner(
      booking.id,
      "player-owner",
      {
        visibility: "private",
        levelRange: null,
        levelMin: null,
        levelMax: null,
        maxPlayers: 1,
      },
    );
    const persistedPrivate = await persistedBooking(dataDirectory, booking.id);

    assert.equal(privateBooking.openSpots, 0);
    assert.equal(persistedPrivate.openSpots, 0);

    const reopened = await store.updateByOwner(booking.id, "player-owner", {
      visibility: "open",
      levelRange: "2.0 a 4.0",
      levelMin: 2,
      levelMax: 4,
      maxPlayers: 4,
    });
    const persistedReopened = await persistedBooking(dataDirectory, booking.id);

    assert.equal(reopened.openSpots, 3);
    assert.equal(persistedReopened.openSpots, 3);
  });
});
