import assert from "node:assert/strict";
import test from "node:test";

import { computeFinanceAnalytics } from "../src/services/finance-analytics.js";

test("revenueByDay includes every date and groups paid confirmed revenue by the Brazil booking date", () => {
  const result = computeFinanceAnalytics({
    bookings: [
      {
        courtId: "court-1",
        startAt: "2026-07-02T01:30:00.000Z",
        price: 180,
        status: "confirmed",
        paymentStatus: "paid",
        paymentMethod: "pix",
      },
      {
        courtId: "court-1",
        startAt: "2026-07-03T15:00:00.000Z",
        price: 220,
        status: "cancelled",
        paymentStatus: "paid",
        paymentMethod: "card",
      },
    ],
    courts: [],
    from: "2026-07-01",
    to: "2026-07-03",
    previousFrom: "2026-06-28",
    previousTo: "2026-06-30",
  });

  assert.deepEqual(result.revenueByDay, [
    { date: "2026-07-01", paidRevenue: 180, paidBookings: 1 },
    { date: "2026-07-02", paidRevenue: 0, paidBookings: 0 },
    { date: "2026-07-03", paidRevenue: 0, paidBookings: 0 },
  ]);
});

test("computes occupancy, payment breakdown and previous-period totals", () => {
  const result = computeFinanceAnalytics({
    bookings: [
      {
        courtId: "court-1",
        startAt: "2026-07-01T12:00:00.000Z",
        price: 180,
        status: "confirmed",
        paymentStatus: "paid",
        paymentMethod: "pix",
      },
      {
        courtId: "court-1",
        startAt: "2026-07-02T12:00:00.000Z",
        price: 200,
        status: "confirmed",
        paymentStatus: "pending",
        paymentMethod: "card",
      },
      {
        courtId: "court-1",
        startAt: "2026-06-30T12:00:00.000Z",
        price: 150,
        status: "confirmed",
        paymentStatus: "paid",
        paymentMethod: "card",
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
      occupiedSlots: 2,
      totalSlots: 4,
      occupancyRate: 50,
    },
  ]);
  assert.deepEqual(
    result.byPaymentMethod.map((entry) => [
      entry.paymentMethod,
      entry.paidRevenue,
    ]),
    [
      ["pix", 180],
      ["card", 0],
      ["venue", 0],
    ],
  );
  assert.deepEqual(result.previousPeriod, {
    paidRevenue: 150,
    paidBookings: 1,
  });
});
