import assert from "node:assert/strict";
import test from "node:test";

import { computeOccupancyAnalytics } from "../src/services/finance-analytics.js";

test("gamesByDay includes every date and groups confirmed games by the Brazil booking date", () => {
  const result = computeOccupancyAnalytics({
    bookings: [
      {
        courtId: "court-1",
        startAt: "2026-07-02T01:30:00.000Z",
        status: "confirmed",
        visibility: "private",
      },
      {
        courtId: "court-1",
        startAt: "2026-07-03T15:00:00.000Z",
        status: "cancelled",
        visibility: "private",
      },
    ],
    courts: [],
    from: "2026-07-01",
    to: "2026-07-03",
    previousFrom: "2026-06-28",
    previousTo: "2026-06-30",
  });

  assert.deepEqual(result.gamesByDay, [
    { date: "2026-07-01", games: 1 },
    { date: "2026-07-02", games: 0 },
    { date: "2026-07-03", games: 0 },
  ]);
});

test("computes occupancy, visibility breakdown and previous-period totals", () => {
  const result = computeOccupancyAnalytics({
    bookings: [
      {
        courtId: "court-1",
        startAt: "2026-07-01T12:00:00.000Z",
        status: "confirmed",
        visibility: "open",
      },
      {
        courtId: "court-1",
        startAt: "2026-07-02T12:00:00.000Z",
        status: "confirmed",
        visibility: "private",
      },
      {
        courtId: "court-1",
        startAt: "2026-06-30T12:00:00.000Z",
        status: "confirmed",
        visibility: "private",
      },
    ],
    courts: [
      {
        id: "court-1",
        name: "Quadra Central",
        openTime: "06:00",
        closeTime: "08:00",
        slotDuration: 60,
      },
    ],
    from: "2026-07-01",
    to: "2026-07-02",
    previousFrom: "2026-06-29",
    previousTo: "2026-06-30",
  });

  assert.deepEqual(result.occupancyByCourt, [
    {
      courtId: "court-1",
      courtName: "Quadra Central",
      games: 2,
      totalSlots: 4,
      occupancyRate: 50,
    },
  ]);
  assert.deepEqual(
    result.byVisibility.map((entry) => [entry.visibility, entry.games]),
    [
      ["open", 1],
      ["private", 1],
    ],
  );
  assert.deepEqual(result.previousPeriod, { games: 1 });
});
