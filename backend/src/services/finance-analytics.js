// TASK-78/81 — o Quadrafy deixou de processar pagamento da quadra, então o
// antigo painel de receita ("Financeiro") vira um painel de OCUPAÇÃO: em vez
// de dinheiro, medimos quantos jogos foram criados por dia/quadra e a taxa
// de ocupação da grade, sem nenhum valor monetário.
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

function confirmed(booking) {
  return booking.status === "confirmed";
}

function minutesFromTime(value) {
  const [hours, minutes] = String(value || "00:00")
    .split(":")
    .map(Number);
  return hours * 60 + minutes;
}

function gamesSummary(bookings) {
  return { games: bookings.filter(confirmed).length };
}

export function computeOccupancyAnalytics({
  bookings = [],
  courts = [],
  from,
  to,
  previousFrom,
  previousTo,
}) {
  const current = bookings.filter((booking) => inRange(booking, from, to));
  const played = current.filter(confirmed);
  const gamesByDay = dateKeys(from, to).map((date) => {
    const dayGames = played.filter(
      (booking) => dateKey(booking.startAt) === date,
    );
    return { date, games: dayGames.length };
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
      played
        .filter((booking) => booking.courtId === court.id)
        .map((booking) => `${dateKey(booking.startAt)}:${booking.startAt}`),
    ).size;
    const totalSlots = slotsPerDay * daysInPeriod;
    return {
      courtId: court.id,
      courtName: court.name,
      games: occupiedSlots,
      totalSlots,
      occupancyRate: totalSlots
        ? Math.min(100, Math.round((occupiedSlots / totalSlots) * 1000) / 10)
        : 0,
    };
  });

  const visibilityLabels = { open: "Jogos abertos", private: "Jogos privados" };
  const byVisibility = Object.entries(visibilityLabels).map(
    ([visibility, label]) => ({
      visibility,
      label,
      games: played.filter((booking) => booking.visibility === visibility)
        .length,
    }),
  );

  const previous = bookings.filter((booking) =>
    inRange(booking, previousFrom, previousTo),
  );
  return {
    gamesByDay,
    occupancyByCourt,
    byVisibility,
    previousPeriod: gamesSummary(previous),
  };
}
