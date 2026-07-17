const BRAZIL_TIME_ZONE = "America/Sao_Paulo";

function dateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRAZIL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function shiftDateKey(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

function dateKeys(from, to) {
  if (!from || !to || from > to) return [];
  const keys = [];
  for (let key = from; key <= to; key = shiftDateKey(key, 1)) {
    keys.push(key);
  }
  return keys;
}

function inRange(booking, from, to) {
  const key = dateKey(booking.startAt);
  return (!from || key >= from) && (!to || key <= to);
}

function paidConfirmed(booking) {
  return booking.status === "confirmed" && booking.paymentStatus === "paid";
}

function minutesFromTime(value) {
  const [hours, minutes] = String(value || "00:00")
    .split(":")
    .map(Number);
  return hours * 60 + minutes;
}

function paidSummary(bookings) {
  const paid = bookings.filter(paidConfirmed);
  const paidRevenue = paid.reduce(
    (total, booking) => total + Number(booking.price || 0),
    0,
  );
  return { paidRevenue, paidBookings: paid.length };
}

export function computeFinanceAnalytics({
  bookings = [],
  courts = [],
  from,
  to,
  previousFrom,
  previousTo,
}) {
  const current = bookings.filter((booking) => inRange(booking, from, to));
  const paid = current.filter(paidConfirmed);
  const revenueByDay = dateKeys(from, to).map((date) => {
    const dayBookings = paid.filter(
      (booking) => dateKey(booking.startAt) === date,
    );
    return {
      date,
      paidRevenue: dayBookings.reduce(
        (total, booking) => total + Number(booking.price || 0),
        0,
      ),
      paidBookings: dayBookings.length,
    };
  });

  const daysInPeriod = Math.max(1, dateKeys(from, to).length);
  const occupancyByCourt = courts.map((court) => {
    const openTime = court.openTime ?? court.opensAt ?? "06:00";
    const closeTime = court.closeTime ?? court.closesAt ?? "23:00";
    const slotDuration = Number(
      court.slotDuration ?? court.slotDurationMinutes ?? 90,
    );
    const slotsPerDay = Math.max(
      0,
      Math.floor(
        (minutesFromTime(closeTime) - minutesFromTime(openTime)) / slotDuration,
      ),
    );
    const occupiedSlots = new Set(
      current
        .filter(
          (booking) =>
            booking.courtId === court.id && booking.status === "confirmed",
        )
        .map((booking) => `${dateKey(booking.startAt)}:${booking.startAt}`),
    ).size;
    const totalSlots = slotsPerDay * daysInPeriod;
    return {
      courtId: court.id,
      courtName: court.name,
      occupiedSlots,
      totalSlots,
      occupancyRate: totalSlots
        ? Math.min(100, Math.round((occupiedSlots / totalSlots) * 1000) / 10)
        : 0,
    };
  });

  const paymentLabels = {
    pix: "Pix",
    card: "Cartão",
    venue: "Na arena",
  };
  const byPaymentMethod = Object.entries(paymentLabels).map(
    ([paymentMethod, label]) => {
      const methodBookings = paid.filter(
        (booking) => booking.paymentMethod === paymentMethod,
      );
      return {
        paymentMethod,
        label,
        paidRevenue: methodBookings.reduce(
          (total, booking) => total + Number(booking.price || 0),
          0,
        ),
        paidBookings: methodBookings.length,
      };
    },
  );

  const previous = bookings.filter((booking) =>
    inRange(booking, previousFrom, previousTo),
  );
  return {
    revenueByDay,
    occupancyByCourt,
    byPaymentMethod,
    previousPeriod: paidSummary(previous),
  };
}
