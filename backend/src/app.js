import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "./config.js";
import {
  ApiError,
  assertSameOrigin as assertRequestOrigin,
  clearSessionCookie,
  getRequestId,
  parseCookies,
  readJson,
  sendData,
  sendError,
  sessionCookie,
} from "./lib/http.js";
import { RateLimiter } from "./lib/rate-limiter.js";
import {
  createId,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from "./lib/security.js";
import {
  validateBookingUpdate,
  validateBooking,
  validateClubProfile,
  validateCourt,
  validateLevelTest,
  validateMatchResult,
  validateLogin,
  validateMatchMessage,
  validatePlayerProfile,
  validateRecurringBooking,
  validateRecurringBookingUpdate,
  validateArena,
  validateRegistration,
  validateSuper8,
  validateSuper8Courts,
  validateSuper8GameResult,
  validateSuper8Pairs,
} from "./lib/validation.js";
import { computeOccupancyAnalytics } from "./services/finance-analytics.js";
import { AuditLogStore } from "./stores/audit-log-store.js";
import { BookingStore } from "./stores/booking-store.js";
import { ClubStore } from "./stores/club-store.js";
import { CourtStore } from "./stores/court-store.js";
import { LevelTestStore } from "./stores/level-test-store.js";
import { MatchResultStore } from "./stores/match-result-store.js";
import { LevelHistoryStore } from "./stores/level-history-store.js";
import { Super8Store } from "./stores/super8-store.js";
import { AchievementStore } from "./stores/achievement-store.js";
import { publicAchievementCatalog } from "./config/achievements.js";
import {
  createAchievementsEngine,
  toAchievementView,
} from "./lib/achievements-engine.js";
import {
  computeSuper8Standings,
  generateSuper8Games,
} from "./lib/super8-engine.js";
import {
  LEVEL_BANDS,
  assessQuestionnaire,
  classificationFor,
  computeMatchOutcome,
  normalizeReliability,
} from "./lib/level-engine.js";
import { MatchMessageStore } from "./stores/match-message-store.js";
import { RecurringBookingStore } from "./stores/recurring-booking-store.js";
import { SessionStore } from "./stores/session-store.js";
import { toPublicUser, UserStore } from "./stores/user-store.js";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

const PROTECTED_PAGES = new Map([
  ["/dashboard-player.html", "player"],
  ["/dashboard-club.html", "club"],
]);
const IMAGE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const IMAGE_UPLOAD_BODY_LIMIT = 7 * 1024 * 1024;
const IMAGE_UPLOAD_TYPES = new Map([
  ["image/jpeg", { extension: "jpg", directory: "players" }],
  ["image/png", { extension: "png", directory: "players" }],
  ["image/webp", { extension: "webp", directory: "players" }],
]);
const UPLOAD_RESOURCE_DIRECTORIES = {
  player: "players",
  club: "clubs",
  court: "courts",
};

function decodeImageUpload(body) {
  const mimeType = String(body.mimeType ?? "").toLowerCase();
  const imageType = IMAGE_UPLOAD_TYPES.get(mimeType);
  if (!imageType) {
    throw new ApiError(
      422,
      "unsupported_image_type",
      "Envie uma imagem JPEG, PNG ou WebP.",
      { field: "mimeType" },
    );
  }
  const encoded = String(body.data ?? "");
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[a-z0-9+/]+={0,2}$/i.test(encoded)
  ) {
    throw new ApiError(
      422,
      "invalid_image",
      "O arquivo de imagem é inválido.",
      { field: "data" },
    );
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > IMAGE_UPLOAD_LIMIT) {
    throw new ApiError(
      413,
      "image_too_large",
      "A imagem deve ter no máximo 5 MB.",
      { maxBytes: IMAGE_UPLOAD_LIMIT },
    );
  }
  const validSignature =
    (mimeType === "image/png" &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )) ||
    (mimeType === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (mimeType === "image/webp" &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP");
  if (!validSignature) {
    throw new ApiError(
      422,
      "invalid_image",
      "O conteúdo do arquivo não corresponde ao tipo de imagem informado.",
      { field: "data" },
    );
  }
  return { bytes, extension: imageType.extension, mimeType };
}

function displayName(user) {
  return user.role === "player"
    ? `${user.profile.firstName} ${user.profile.lastName}`
    : user.profile.responsibleName;
}

function initials(user) {
  return displayName(user)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function dashboardPath(role) {
  return role === "club" ? "/dashboard-club.html" : "/dashboard-player.html";
}

function clientAddress(request) {
  return request.socket.remoteAddress ?? "unknown";
}

function brazilDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function brazilTimeKey(value = new Date()) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 2020 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function financePeriodRange(period) {
  const today = brazilDateKey();
  if (period === "day") return { from: today, to: today };
  if (period === "week") {
    return { from: shiftDateKey(today, -6), to: today };
  }
  if (period === "month") {
    const [year, month] = today.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    return {
      from: `${monthKey}-01`,
      to: `${monthKey}-${String(lastDay).padStart(2, "0")}`,
    };
  }
  return null;
}

function minutesFromTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function timeFromMinutes(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function securityHeaders(config) {
  const headers = {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (config.isProduction) {
    headers["Strict-Transport-Security"] =
      "max-age=31536000; includeSubDomains";
  }
  return headers;
}

export async function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const assertSameOrigin = (request) =>
    assertRequestOrigin(request, config.allowedOrigins);
  const users = new UserStore(config.dataDirectory);
  const sessions = new SessionStore(config.sessionTtlMs);
  const clubs = new ClubStore(config.dataDirectory);
  const courts = new CourtStore(config.dataDirectory);
  const bookings = new BookingStore(config.dataDirectory);
  const levelTests = new LevelTestStore(config.dataDirectory);
  const matchMessages = new MatchMessageStore(config.dataDirectory);
  const recurringBookings = new RecurringBookingStore(config.dataDirectory);
  const auditLog = new AuditLogStore(config.dataDirectory);
  const matchResults = new MatchResultStore(config.dataDirectory);
  const levelHistory = new LevelHistoryStore(config.dataDirectory);
  const super8 = new Super8Store(config.dataDirectory);
  const achievements = new AchievementStore(config.dataDirectory);
  const supabaseEnabled = Boolean(config.supabaseUrl && config.supabaseSecretKey);
  const loginIpLimiter = new RateLimiter({
    limit: 30,
    windowMs: 15 * 60 * 1000,
    maxEntries: 10_000,
  });
  const loginAccountLimiter = new RateLimiter({
    limit: 8,
    windowMs: 15 * 60 * 1000,
    maxEntries: 50_000,
  });
  const registerLimiter = new RateLimiter({
    limit: 12,
    windowMs: 60 * 60 * 1000,
    maxEntries: 10_000,
  });
  const levelTestLimiter = new RateLimiter({
    limit: 6,
    windowMs: 60 * 60 * 1000,
    maxEntries: 50_000,
  });
  const chatLimiter = new RateLimiter({
    limit: 60,
    windowMs: 60 * 1000,
    maxEntries: 50_000,
  });
  const chatReadLimiter = new RateLimiter({
    limit: 240,
    windowMs: 60 * 1000,
    maxEntries: 50_000,
  });
  const bookingLimiter = new RateLimiter({
    limit: 20,
    windowMs: 60 * 60 * 1000,
    maxEntries: 50_000,
  });
  const recurringLimiter = new RateLimiter({
    limit: 120,
    windowMs: 60 * 60 * 1000,
    maxEntries: 20_000,
  });
  const uploadLimiter = new RateLimiter({
    limit: 30,
    windowMs: 60 * 60 * 1000,
    maxEntries: 50_000,
  });
  await Promise.all([
    users.initialize(),
    clubs.initialize(),
    courts.initialize(),
    bookings.initialize(),
    levelTests.initialize(),
    matchMessages.initialize(),
    recurringBookings.initialize(),
    auditLog.initialize(),
    matchResults.initialize(),
    levelHistory.initialize(),
    super8.initialize(),
    achievements.initialize(),
  ]);
  const achievementsEngine = createAchievementsEngine({
    users,
    matchResults,
    super8,
    clubs,
    achievementStore: achievements,
  });
  const dummyPasswordHash = await hashPassword("quadrafy-dummy-password");
  let agendaWriteQueue = Promise.resolve();

  function withAgendaLock(operation) {
    const next = agendaWriteQueue.then(operation, operation);
    agendaWriteQueue = next.catch(() => {});
    return next;
  }

  function currentUser(request) {
    const token = parseCookies(request).quadrafy_session;
    const session = sessions.get(token);
    return session ? users.findById(session.userId) : null;
  }

  function requireUser(request, role) {
    const user = currentUser(request);
    if (!user) {
      throw new ApiError(
        401,
        "authentication_required",
        "Faça login para continuar.",
      );
    }
    if (role && user.role !== role) {
      throw new ApiError(
        403,
        "role_forbidden",
        "Sua conta não possui acesso a este painel.",
      );
    }
    return user;
  }

  // TASKS-11 / TASK-49 — regras de categoria de gênero da partida.
  // position: { team, slot } quando o jogador escolhe uma vaga específica.
  function assertGenderAllowed(booking, user, position = null) {
    const category = booking.genderCategory ?? "all";
    if (category === "all") return;
    const gender = user.profile?.gender;
    const defined = gender === "female" || gender === "male";
    if (!defined) {
      throw new ApiError(
        409,
        "gender_required",
        "Esta partida tem restrição de gênero. Defina seu gênero no seu perfil para participar.",
      );
    }
    if (category === "women_only" && gender !== "female") {
      throw new ApiError(
        403,
        "gender_not_allowed",
        "Esta partida é exclusiva para mulheres.",
      );
    }
    if (category === "men_only" && gender !== "male") {
      throw new ApiError(
        403,
        "gender_not_allowed",
        "Esta partida é exclusiva para homens.",
      );
    }
    if (category === "mixed" && position?.team) {
      // Misto: cada dupla precisa de 1 homem + 1 mulher. Se a outra vaga da
      // dupla já está ocupada, ela define o gênero que falta.
      const teamSlots = booking.teams?.[position.team] ?? [];
      const teammateId = teamSlots.find(
        (playerId, index) => playerId && index !== Number(position.slot),
      );
      if (teammateId && teammateId !== user.id) {
        const teammateGender = users.findById(teammateId)?.profile?.gender;
        if (teammateGender === gender) {
          const needed =
            gender === "female"
              ? "Esta dupla já tem uma mulher; esta vaga precisa ser de um homem."
              : "Esta dupla já tem um homem; esta vaga precisa ser de uma mulher.";
          throw new ApiError(409, "gender_mix_required", needed);
        }
      }
    }
  }

  function assertPlayerEligibleForRange(user, { levelMin, levelMax }) {
    if (!Number.isFinite(levelMin) || !Number.isFinite(levelMax)) return;
    const playerLevel = Number(user.profile.level);
    if (
      user.profile.levelAssessmentCompleted !== true ||
      !Number.isFinite(playerLevel)
    ) {
      throw new ApiError(
        409,
        "level_assessment_required",
        "Conclua o teste de nível para usar uma faixa de matchmaking.",
      );
    }
    if (playerLevel < levelMin || playerLevel > levelMax) {
      throw new ApiError(
        409,
        "level_not_eligible",
        "Seu nível está fora da faixa selecionada.",
        { playerLevel, levelMin, levelMax },
      );
    }
  }

  function bookingAuditSnapshot(booking) {
    return {
      status: booking.status,
      visibility: booking.visibility,
      levelMin: booking.levelMin ?? null,
      levelMax: booking.levelMax ?? null,
    };
  }

  function publicPlayer(user) {
    if (!user) return null;
    return {
      id: user.id,
      displayName: displayName(user),
      initials: initials(user),
      level: user.profile.level ?? null,
      levelCategory: user.profile.levelCategory ?? null,
      photoUrl: user.profile.photoUrl ?? "",
    };
  }

  function courtView(court) {
    return {
      id: court.id,
      clubId: court.clubId,
      name: court.name,
      price: court.price,
      type: court.type,
      active: court.active,
      openTime: court.openTime ?? court.opensAt,
      closeTime: court.closeTime ?? court.closesAt,
      arenaId: court.arenaId ?? null,
      slotDuration: court.slotDuration ?? court.slotDurationMinutes,
      opensAt: court.openTime ?? court.opensAt,
      closesAt: court.closeTime ?? court.closesAt,
      slotDurationMinutes: court.slotDuration ?? court.slotDurationMinutes,
      photoUrl: court.photoUrl ?? "",
    };
  }

  function clubView(club, { includeCourts = false } = {}) {
    const activeCourts = courts.listActiveByClub(club.id);
    const prices = activeCourts.map((court) => court.price);
    const view = {
      id: club.id,
      name: club.name,
      description: club.description ?? "",
      phone: club.phone ?? "",
      address: club.address ?? "",
      photoUrl: club.photoUrl ?? "",
      status: club.status,
      courtCount: activeCourts.length,
      courtTypes: [...new Set(activeCourts.map((court) => court.type))],
      minimumPrice: prices.length ? Math.min(...prices) : null,
    };
    if (includeCourts) view.courts = activeCourts.map(courtView);
    return view;
  }

  function bookingView(booking) {
    const club = clubs.findById(booking.clubId);
    const court = courts.findById(booking.courtId);
    const participantIds = booking.participantIds ?? [booking.playerId];
    return {
      id: booking.id,
      playerId: booking.playerId,
      player: publicPlayer(users.findById(booking.playerId)),
      clubId: booking.clubId,
      clubName: club?.name ?? "Clube indisponível",
      courtId: booking.courtId,
      courtName: court?.name ?? "Quadra indisponível",
      startAt: booking.startAt,
      // TASK-78 — preço da quadra fica só como referência (o Quadrafy não
      // cobra nem processa pagamento da reserva feita por fora).
      referencePrice: court?.price ?? null,
      visibility: booking.visibility,
      levelRange: booking.levelRange,
      levelMin: booking.levelMin ?? null,
      levelMax: booking.levelMax ?? null,
      maxPlayers: booking.maxPlayers,
      genderCategory: booking.genderCategory ?? "all",
      openSpots:
        booking.visibility === "open"
          ? Math.max(0, booking.maxPlayers - participantIds.length)
          : 0,
      participantIds,
      teams: booking.teams ?? null,
      slotDuration: court?.slotDuration ?? court?.slotDurationMinutes ?? null,
      status: booking.status,
      // TASK-79 — cancelar um jogo é uma ação simples, sem prazo/reembolso.
      canCancel: booking.status === "confirmed",
      createdAt: booking.createdAt,
    };
  }

  function matchView(booking, viewer = null) {
    const base = bookingView(booking);
    const participantIds = booking.participantIds ?? [booking.playerId];
    const players = participantIds
      .map((id) => publicPlayer(users.findById(id)))
      .filter(Boolean);
    const isParticipant = viewer ? participantIds.includes(viewer.id) : false;
    const teamIds = booking.teams ?? {
      team1: [participantIds[0] ?? null, participantIds[1] ?? null],
      team2: [participantIds[2] ?? null, participantIds[3] ?? null],
    };
    const teams = Object.fromEntries(
      Object.entries(teamIds).map(([team, positions]) => [
        team,
        positions.map((playerId) =>
          playerId ? publicPlayer(users.findById(playerId)) : null,
        ),
      ]),
    );
    return {
      id: base.id,
      creatorId: base.playerId,
      clubId: base.clubId,
      clubName: base.clubName,
      courtId: base.courtId,
      courtName: base.courtName,
      startAt: base.startAt,
      referencePrice: base.referencePrice,
      visibility: base.visibility,
      levelRange: base.levelRange,
      levelMin: base.levelMin,
      levelMax: base.levelMax,
      maxPlayers: base.maxPlayers,
      genderCategory: base.genderCategory,
      participantIds,
      teams,
      teamIds,
      slotDuration: base.slotDuration,
      status: base.status,
      createdAt: base.createdAt,
      players,
      availableSpots: Math.max(0, booking.maxPlayers - players.length),
      isFull: players.length >= booking.maxPlayers,
      isParticipant,
      isOrganizer: Boolean(viewer) && booking.playerId === viewer.id,
      canJoin:
        Boolean(viewer) &&
        !isParticipant &&
        booking.status === "confirmed" &&
        players.length < booking.maxPlayers,
      address: clubs.findById(booking.clubId)?.address ?? null,
      distanceKm: null,
    };
  }

  function messageView(message) {
    return {
      id: message.id,
      matchId: message.matchId,
      playerId: message.playerId,
      player: publicPlayer(users.findById(message.playerId)),
      content: message.content,
      createdAt: message.createdAt,
    };
  }

  function recurringView(recurring) {
    const court = courts.findById(recurring.courtId);
    return {
      id: recurring.id,
      clubId: recurring.clubId,
      courtId: recurring.courtId,
      courtName: court?.name ?? "Quadra indisponível",
      clientName: recurring.clientName,
      startTime: recurring.startTime,
      recurrence: recurring.recurrence,
      createdAt: recurring.createdAt,
      updatedAt: recurring.updatedAt,
    };
  }

  function recurringOccursOn(recurring, date) {
    const [year, month, day] = date.split("-").map(Number);
    if (recurring.recurrence.frequency === "monthly") {
      return recurring.recurrence.dayOfMonth === day;
    }
    const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return recurring.recurrence.dayOfWeek === dayOfWeek;
  }

  function assertNoConfirmedBookingForRecurrence({
    clubId,
    courtId,
    startTime,
    recurrence,
  }) {
    const candidate = { recurrence };
    const conflicts = bookings
      .listByClub(clubId)
      .some(
        (booking) =>
          booking.status === "confirmed" &&
          booking.courtId === courtId &&
          brazilTimeKey(booking.startAt) === startTime &&
          recurringOccursOn(candidate, brazilDateKey(booking.startAt)),
      );
    if (conflicts) {
      throw new ApiError(
        409,
        "recurring_booking_conflict",
        "Já existe uma reserva avulsa em uma ocorrência desta agenda.",
      );
    }
  }

  function slotTimesFor(court) {
    const slots = [];
    const openTime = court.openTime ?? court.opensAt;
    const closeTime = court.closeTime ?? court.closesAt;
    const slotDuration = court.slotDuration ?? court.slotDurationMinutes;
    const opensAt = minutesFromTime(openTime);
    const closesAt = minutesFromTime(closeTime);
    for (
      let minute = opensAt;
      minute + slotDuration <= closesAt;
      minute += slotDuration
    ) {
      slots.push(timeFromMinutes(minute));
    }
    return slots;
  }

  function availabilityFor(club, date) {
    const activeCourts = courts.listActiveByClub(club.id);
    const reservedStarts = new Set(
      bookings
        .listByClub(club.id)
        .filter(
          (booking) =>
            booking.status === "confirmed" &&
            brazilDateKey(booking.startAt) === date,
        )
        .map((booking) => `${booking.courtId}:${booking.startAt}`),
    );
    const recurringStarts = new Set(
      recurringBookings
        .listByClub(club.id)
        .filter((recurring) => recurringOccursOn(recurring, date))
        .map((recurring) => `${recurring.courtId}:${recurring.startTime}`),
    );

    return activeCourts.map((court) => {
      const slots = slotTimesFor(court).map((time) => {
        const startAt = new Date(`${date}T${time}:00-03:00`).toISOString();
        return {
          startAt,
          time,
          available:
            !reservedStarts.has(`${court.id}:${startAt}`) &&
            !recurringStarts.has(`${court.id}:${time}`),
        };
      });
      return {
        courtId: court.id,
        courtName: court.name,
        slotDurationMinutes: court.slotDuration ?? court.slotDurationMinutes,
        slots,
      };
    });
  }

  function scheduleFor(club, date) {
    const dateBookings = bookings
      .listByClub(club.id)
      .filter(
        (booking) =>
          booking.status === "confirmed" &&
          brazilDateKey(booking.startAt) === date,
      );
    const dateRecurring = recurringBookings
      .listByClub(club.id)
      .filter((recurring) => recurringOccursOn(recurring, date));

    return {
      date,
      courts: courts.listByClub(club.id).map((court) => {
        const active = court.active === true;
        const slots = slotTimesFor(court).map((time) => {
          const startAt = new Date(`${date}T${time}:00-03:00`).toISOString();
          const booking = dateBookings.find(
            (entry) => entry.courtId === court.id && entry.startAt === startAt,
          );
          const recurring = dateRecurring.find(
            (entry) => entry.courtId === court.id && entry.startTime === time,
          );
          let status = active ? "available" : "blocked";
          if (recurring) status = "recurring";
          if (booking) status = "booked";
          return {
            startAt,
            time,
            status,
            ...(booking ? { booking: bookingView(booking) } : {}),
            ...(recurring
              ? { recurringBooking: recurringView(recurring) }
              : {}),
          };
        });
        return {
          courtId: court.id,
          courtName: court.name,
          active,
          slotDurationMinutes: court.slotDuration ?? court.slotDurationMinutes,
          slots,
        };
      }),
      recurringBookings: dateRecurring.map(recurringView),
    };
  }

  // TASK-78/81 — "Financeiro" virou "Ocupação": sem pagamento processado
  // pelo Quadrafy, o painel do clube passa a mostrar jogos criados e taxa
  // de ocupação da grade, não mais receita.
  function occupancyFor(club, { courtId, from, to } = {}) {
    const clubCourts = courts.listByClub(club.id);
    const allowedCourtIds = new Set(clubCourts.map((court) => court.id));
    let baseBookings = bookings
      .listByClub(club.id)
      .filter((booking) => allowedCourtIds.has(booking.courtId));

    if (courtId)
      baseBookings = baseBookings.filter(
        (booking) => booking.courtId === courtId,
      );
    let filtered = baseBookings;
    if (from)
      filtered = filtered.filter(
        (booking) => brazilDateKey(booking.startAt) >= from,
      );
    if (to)
      filtered = filtered.filter(
        (booking) => brazilDateKey(booking.startAt) <= to,
      );

    const played = filtered.filter((booking) => booking.status === "confirmed");
    const selectedCourts = courtId
      ? clubCourts.filter((court) => court.id === courtId)
      : clubCourts;
    const byCourt = selectedCourts.map((court) => {
      const courtGames = played.filter(
        (booking) => booking.courtId === court.id,
      );
      return {
        courtId: court.id,
        courtName: court.name,
        games: courtGames.length,
      };
    });

    const bookingDates = baseBookings
      .map((booking) => brazilDateKey(booking.startAt))
      .sort();
    const effectiveFrom = from || bookingDates[0] || brazilDateKey();
    const effectiveTo = to || bookingDates.at(-1) || effectiveFrom;
    const [fromYear, fromMonth, fromDay] = effectiveFrom
      .split("-")
      .map(Number);
    const [toYear, toMonth, toDay] = effectiveTo.split("-").map(Number);
    const periodDays =
      Math.round(
        (Date.UTC(toYear, toMonth - 1, toDay) -
          Date.UTC(fromYear, fromMonth - 1, fromDay)) /
          (24 * 60 * 60 * 1_000),
      ) + 1;
    const previousTo = shiftDateKey(effectiveFrom, -1);
    const previousFrom = shiftDateKey(previousTo, -(periodDays - 1));
    const analytics = computeOccupancyAnalytics({
      bookings: baseBookings,
      courts: selectedCourts,
      from: effectiveFrom,
      to: effectiveTo,
      previousFrom,
      previousTo,
    });

    return {
      summary: {
        totalGames: played.length,
        totalBookings: filtered.length,
        averageGamesPerDay: periodDays ? played.length / periodDays : 0,
      },
      byCourt,
      bookings: filtered.map(bookingView),
      ...analytics,
      period: {
        from: effectiveFrom,
        to: effectiveTo,
        previousFrom,
        previousTo,
      },
    };
  }

  async function handleApi(request, response, url) {
    const { pathname } = url;
    if (request.method === "GET" && pathname === "/api/v1/health") {
      sendData(response, 200, { status: "ok", service: "quadrafy-api" });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/v1/auth/register") {
      assertSameOrigin(request);
      const rateKey = clientAddress(request);
      registerLimiter.consume(rateKey);
      const input = validateRegistration(await readJson(request));
      const user = await users.create({
        role: input.role,
        email: input.email,
        passwordHash: await hashPassword(input.password),
        profile: input.profile,
      });
      await auditLog.record({
        actorId: user.id,
        action: "auth.registered",
        resourceType: "auth",
        resourceId: user.id,
        after: { role: user.role },
        requestId: request.requestId,
      });
      sessions.revoke(parseCookies(request).quadrafy_session);
      const token = sessions.create(user.id);
      sendData(
        response,
        201,
        {
          user: toPublicUser(user),
          redirectTo: dashboardPath(user.role),
        },
        {
          "Set-Cookie": sessionCookie(
            token,
            Math.floor(config.sessionTtlMs / 1000),
            config.isProduction,
          ),
          Location: "/api/v1/auth/me",
        },
      );
      return true;
    }

    if (request.method === "POST" && pathname === "/api/v1/auth/login") {
      assertSameOrigin(request);
      const input = validateLogin(await readJson(request));
      const ipKey = clientAddress(request);
      const accountKey = normalizeEmail(input.email);
      loginIpLimiter.consume(ipKey);
      loginAccountLimiter.consume(accountKey);
      const user = users.findByEmail(input.email);
      const valid = await verifyPassword(
        input.password,
        user?.passwordHash ?? dummyPasswordHash,
      );
      if (!user || !valid) {
        await auditLog.record({
          actorId: user?.id ?? null,
          action: "auth.login_failed",
          resourceType: "auth",
          resourceId: user?.id ?? null,
          after: { reason: "invalid_credentials" },
          requestId: request.requestId,
        });
        throw new ApiError(
          401,
          "invalid_credentials",
          "E-mail ou senha incorretos.",
        );
      }
      loginAccountLimiter.clear(accountKey);
      sessions.revoke(parseCookies(request).quadrafy_session);
      const token = sessions.create(user.id);
      await auditLog.record({
        actorId: user.id,
        action: "auth.logged_in",
        resourceType: "auth",
        resourceId: user.id,
        after: { role: user.role },
        requestId: request.requestId,
      });
      sendData(
        response,
        200,
        {
          user: toPublicUser(user),
          redirectTo: dashboardPath(user.role),
        },
        {
          "Set-Cookie": sessionCookie(
            token,
            Math.floor(config.sessionTtlMs / 1000),
            config.isProduction,
          ),
        },
      );
      return true;
    }

    if (request.method === "POST" && pathname === "/api/v1/auth/logout") {
      assertSameOrigin(request);
      const token = parseCookies(request).quadrafy_session;
      const session = sessions.get(token);
      sessions.revoke(token);
      if (session) {
        await auditLog.record({
          actorId: session.userId,
          action: "auth.logged_out",
          resourceType: "auth",
          resourceId: session.userId,
          requestId: request.requestId,
        });
      }
      response.writeHead(204, {
        "Set-Cookie": clearSessionCookie(config.isProduction),
        "Cache-Control": "no-store",
      });
      response.end();
      return true;
    }

    if (request.method === "POST" && pathname === "/api/v1/uploads/image") {
      assertSameOrigin(request);
      const user = requireUser(request);
      uploadLimiter.consume(user.id);
      const body = await readJson(request, {
        maxBytes: IMAGE_UPLOAD_BODY_LIMIT,
      });
      const resourceType = String(body.type ?? "");
      const directory = UPLOAD_RESOURCE_DIRECTORIES[resourceType];
      if (!directory) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe se a imagem pertence ao jogador, clube ou quadra.",
          { field: "type" },
        );
      }

      let resourceId;
      if (resourceType === "player") {
        if (
          user.role !== "player" ||
          (body.resourceId && body.resourceId !== user.id)
        ) {
          throw new ApiError(
            403,
            "upload_forbidden",
            "Você não pode alterar a imagem deste jogador.",
          );
        }
        resourceId = user.id;
      } else {
        if (user.role !== "club") {
          throw new ApiError(
            403,
            "upload_forbidden",
            "Apenas gestores podem enviar imagens de clubes e quadras.",
          );
        }
        const club = await clubs.ensureForUser(user);
        if (resourceType === "club") {
          if (body.resourceId && body.resourceId !== club.id) {
            throw new ApiError(
              403,
              "upload_forbidden",
              "Você não pode alterar a imagem deste clube.",
            );
          }
          resourceId = club.id;
        } else {
          const court = courts.findById(String(body.resourceId ?? ""));
          if (!court || court.clubId !== club.id) {
            throw new ApiError(
              404,
              "court_not_found",
              "Quadra não encontrada.",
            );
          }
          resourceId = court.id;
        }
      }

      const image = decodeImageUpload(body);
      const uploadDirectory = path.join(
        config.dataDirectory,
        "uploads",
        directory,
      );
      await mkdir(uploadDirectory, { recursive: true });
      const fileName = `${resourceId}.${image.extension}`;
      const filePath = path.join(uploadDirectory, fileName);
      const temporaryPath = `${filePath}.${process.pid}.${createId()}.tmp`;
      try {
        await writeFile(temporaryPath, image.bytes, { mode: 0o600 });
        await rename(temporaryPath, filePath);
        await Promise.all(
          ["jpg", "png", "webp"]
            .filter((extension) => extension !== image.extension)
            .map((extension) =>
              rm(path.join(uploadDirectory, `${resourceId}.${extension}`), {
                force: true,
              }),
            ),
        );
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
      const url = `/uploads/${directory}/${fileName}`;
      await auditLog.record({
        actorId: user.id,
        action: "image.uploaded",
        resourceType,
        resourceId,
        after: { url, mimeType: image.mimeType, bytes: image.bytes.length },
        requestId: request.requestId,
      });
      sendData(response, 201, { url }, { Location: url });
      return true;
    }

    if (request.method === "GET" && pathname === "/api/v1/auth/me") {
      const user = requireUser(request);
      sendData(response, 200, {
        user: toPublicUser(user),
        redirectTo: dashboardPath(user.role),
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/api/v1/player/dashboard") {
      const user = requireUser(request, "player");
      sendData(response, 200, {
        user: toPublicUser(user),
        identity: {
          displayName: displayName(user),
          initials: initials(user),
          subtitle: user.profile.level ?? "Nível em formação",
        },
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/api/v1/player/profile") {
      const user = requireUser(request, "player");
      const publicUser = toPublicUser(user);
      sendData(response, 200, {
        profile: publicUser.profile,
        user: publicUser,
      });
      return true;
    }

    if (request.method === "PATCH" && pathname === "/api/v1/player/profile") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const update = validatePlayerProfile(await readJson(request));
      const updated = await users.updateProfile(user.id, update);
      sendData(response, 200, { user: toPublicUser(updated) });
      return true;
    }

    const publicPlayerProfileRoute = pathname.match(
      /^\/api\/v1\/players\/([^/]+)\/profile$/,
    );
    if (publicPlayerProfileRoute && request.method === "GET") {
      requireUser(request, "player");
      const playerId = decodeURIComponent(publicPlayerProfileRoute[1]);
      const player = users.findById(playerId);
      if (!player || player.role !== "player") {
        throw new ApiError(
          404,
          "player_not_found",
          "Jogador não encontrado.",
        );
      }
      const profile = player.profile ?? {};
      const completedMatches = bookings
        .listByPlayer(player.id)
        .filter(
          (booking) =>
            booking.status === "confirmed" &&
            new Date(booking.startAt).getTime() <= Date.now(),
        );
      sendData(response, 200, {
        player: {
          id: player.id,
          displayName: displayName(player),
          photoUrl: profile.photoUrl ?? "",
          level: Number.isFinite(Number(profile.level))
            ? Number(profile.level)
            : null,
          city: profile.city ?? "",
          stats: {
            matchesPlayed: Number.isFinite(Number(profile.matchesPlayed))
              ? Number(profile.matchesPlayed)
              : completedMatches.length,
            wins: Number.isFinite(Number(profile.wins))
              ? Number(profile.wins)
              : null,
            winRate: Number.isFinite(Number(profile.winRate))
              ? Number(profile.winRate)
              : null,
          },
        },
      });
      return true;
    }

    // TASKS-16 / 68 — os pins são públicos; o catálogo completo (incluindo
    // bloqueados) aparece apenas para o dono do perfil.
    const playerAchievementsRoute = pathname.match(
      /^\/api\/v1\/players\/([^/]+)\/achievements$/,
    );
    if (playerAchievementsRoute && request.method === "GET") {
      const playerId = decodeURIComponent(playerAchievementsRoute[1]);
      const player = users.findById(playerId);
      if (!player || player.role !== "player") {
        throw new ApiError(404, "player_not_found", "Jogador não encontrado.");
      }
      const viewer = currentUser(request);
      let catalog = [];
      if (viewer?.id === playerId) {
        // TASK-73: progresso "atual/meta" calculado com as mesmas métricas
        // usadas pelo motor de verificação, mesmo para conquistas bloqueadas.
        const metrics = (await achievementsEngine.metricsFor(playerId)) ?? {};
        catalog = publicAchievementCatalog().map((achievement) => ({
          ...achievement,
          progress: {
            current: Number(metrics[achievement.criterion.metric]) || 0,
            target: achievement.criterion.threshold,
          },
        }));
      }
      sendData(response, 200, {
        achievements: achievements
          .listByPlayer(playerId)
          .map(toAchievementView)
          .filter(Boolean),
        catalog,
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/v1/player/level-test") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      levelTestLimiter.consume(user.id);
      const answers = validateLevelTest(await readJson(request));
      // TASKS-07 / TASK-26: avaliação 100% determinística — nenhuma chamada
      // de IA externa. Pontuação 6–24 → nível interpolado (teto 5.6),
      // fiabilidade inicial sempre 35%.
      const result = assessQuestionnaire(answers);
      const updated = await users.updateProfile(user.id, {
        level: result.nivel_inicial,
        levelConfidence: result.confiabilidade_inicial,
        levelCategory: result.categoria_sugerida,
        levelAnalysis: result.analise_tecnica,
        levelAssessmentCompleted: true,
        levelAssessedAt: new Date().toISOString(),
      });
      await levelTests.create({
        playerId: user.id,
        answers,
        result,
        provider: "deterministic",
        rawResponse: null,
        error: null,
      });
      // TASK-19: toda definição de nível gera um ponto na série histórica.
      await levelHistory.record({
        playerId: user.id,
        level: result.nivel_inicial,
        levelCategory: result.categoria_sugerida,
        levelConfidence: result.confiabilidade_inicial,
        source: "level_test",
      });
      sendData(response, 200, {
        result,
        user: toPublicUser(updated),
        engine: { provider: "deterministic" },
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/api/v1/club/dashboard") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const clubCourts = courts.listByClub(club.id);
      const clubBookings = bookings.listByClub(club.id);
      const today = brazilDateKey();
      const todayBookings = clubBookings.filter(
        (booking) => brazilDateKey(booking.startAt) === today,
      );
      const currentMonth = today.slice(0, 7);
      // TASK-78/81 — sem pagamento processado pelo Quadrafy, o indicador do
      // mês passa a ser a quantidade de jogos criados, não receita.
      const monthlyGames = clubBookings.filter(
        (booking) =>
          brazilDateKey(booking.startAt).startsWith(currentMonth) &&
          booking.status === "confirmed",
      ).length;
      sendData(response, 200, {
        user: toPublicUser(user),
        identity: {
          displayName: displayName(user),
          initials: initials(user),
          subtitle: "Administrador",
          arenaName: club.name,
        },
        club: clubView(club, { includeCourts: true }),
        courts: clubCourts.map(courtView),
        summary: {
          activeCourts: clubCourts.filter((court) => court.active).length,
          todayBookings: todayBookings.length,
          occupancyRate: clubCourts.length
            ? Math.min(
                100,
                Math.round(
                  (todayBookings.length / (clubCourts.length * 10)) * 100,
                ),
              )
            : 0,
          monthlyGames,
        },
      });
      return true;
    }

    // TASKS-13 / TASK-51 — múltiplas arenas por clube (ver comentário no
    // club-store: arena principal = registro do clube; extras em club.arenas).
    if (pathname === "/api/v1/club/arenas" && request.method === "GET") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      sendData(response, 200, { arenas: club.arenas ?? [] });
      return true;
    }
    if (pathname === "/api/v1/club/arenas" && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      await clubs.ensureForUser(user);
      const input = validateArena(await readJson(request));
      const arena = await clubs.addArena(user.id, input);
      await auditLog.record({
        actorId: user.id,
        action: "club.arena_created",
        resourceType: "club",
        resourceId: arena.id,
        before: null,
        after: input,
        requestId: request.requestId,
      });
      sendData(response, 201, { arena });
      return true;
    }

    if (request.method === "PATCH" && pathname === "/api/v1/club/profile") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const input = validateClubProfile(await readJson(request));
      const before = clubView(club);
      const updated = await clubs.updateProfile(user.id, input);
      await users.updateProfile(user.id, { arenaName: input.name });
      const after = clubView(updated);
      await auditLog.record({
        actorId: user.id,
        action: "club.profile_updated",
        resourceType: "club",
        resourceId: club.id,
        before,
        after,
        requestId: request.requestId,
      });
      sendData(response, 200, { club: after });
      return true;
    }

    if (pathname === "/api/v1/club/schedule" && request.method === "GET") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const date = url.searchParams.get("date") || brazilDateKey();
      const period = url.searchParams.get("period") || "day";
      if (!validDateKey(date)) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe uma data válida.",
          { field: "date" },
        );
      }
      if (!["day", "week"].includes(period)) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe uma visualização de grade válida.",
          { field: "period" },
        );
      }
      if (period === "week") {
        const days = Array.from({ length: 7 }, (_, index) =>
          scheduleFor(club, shiftDateKey(date, index)),
        );
        sendData(response, 200, {
          period,
          from: date,
          to: shiftDateKey(date, 6),
          days,
        });
        return true;
      }
      sendData(response, 200, { period, ...scheduleFor(club, date) });
      return true;
    }

    const recurringCreationRoute = pathname.match(
      /^\/api\/v1\/club\/courts\/([^/]+)\/recurring-bookings$/,
    );
    if (recurringCreationRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const courtId = decodeURIComponent(recurringCreationRoute[1]);
      const court = courts.findById(courtId);
      if (!court || court.clubId !== club.id || !court.active) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      recurringLimiter.consume(user.id);
      const input = validateRecurringBooking(await readJson(request));
      if (!slotTimesFor(court).includes(input.startTime)) {
        throw new ApiError(
          422,
          "invalid_slot",
          "O horário não pertence à grade desta quadra.",
          { field: "startTime" },
        );
      }
      const recurringBooking = await withAgendaLock(async () => {
        assertNoConfirmedBookingForRecurrence({
          clubId: club.id,
          courtId,
          ...input,
        });
        return recurringBookings.create({
          clubId: club.id,
          courtId,
          ...input,
        });
      });
      await auditLog.record({
        actorId: user.id,
        action: "recurring_booking.created",
        resourceType: "recurring_booking",
        resourceId: recurringBooking.id,
        after: recurringView(recurringBooking),
        requestId: request.requestId,
      });
      sendData(
        response,
        201,
        { recurringBooking: recurringView(recurringBooking) },
        {
          Location: `/api/v1/club/recurring-bookings/${recurringBooking.id}`,
        },
      );
      return true;
    }

    const recurringUpdateRoute = pathname.match(
      /^\/api\/v1\/club\/recurring-bookings\/([^/]+)$/,
    );
    if (recurringUpdateRoute && request.method === "PATCH") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const recurringId = decodeURIComponent(recurringUpdateRoute[1]);
      const recurring = recurringBookings.findById(recurringId);
      if (!recurring || recurring.clubId !== club.id) {
        throw new ApiError(
          404,
          "recurring_booking_not_found",
          "Reserva fixa não encontrada.",
        );
      }
      recurringLimiter.consume(user.id);
      const input = validateRecurringBookingUpdate(await readJson(request));
      const court = courts.findById(input.courtId);
      if (!court || court.clubId !== club.id || !court.active) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      if (!slotTimesFor(court).includes(input.startTime)) {
        throw new ApiError(
          422,
          "invalid_slot",
          "O horário não pertence à grade desta quadra.",
          { field: "startTime" },
        );
      }
      const before = recurringView(recurring);
      const updated = await withAgendaLock(() => {
        assertNoConfirmedBookingForRecurrence({
          clubId: club.id,
          ...input,
        });
        return recurringBookings.update(recurringId, input);
      });
      const after = recurringView(updated);
      await auditLog.record({
        actorId: user.id,
        action: "recurring_booking.updated",
        resourceType: "recurring_booking",
        resourceId: recurringId,
        before,
        after,
        requestId: request.requestId,
      });
      sendData(response, 200, { recurringBooking: after });
      return true;
    }

    const recurringDeleteRoute = pathname.match(
      /^\/api\/v1\/club\/recurring-bookings\/([^/]+)$/,
    );
    if (recurringDeleteRoute && request.method === "DELETE") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const recurringId = decodeURIComponent(recurringDeleteRoute[1]);
      const recurring = recurringBookings.findById(recurringId);
      if (!recurring || recurring.clubId !== club.id) {
        throw new ApiError(
          404,
          "recurring_booking_not_found",
          "Reserva fixa não encontrada.",
        );
      }
      const before = recurringView(recurring);
      const deleted = await withAgendaLock(() =>
        recurringBookings.delete(recurringId, user.id),
      );
      await auditLog.record({
        actorId: user.id,
        action: "recurring_booking.deleted",
        resourceType: "recurring_booking",
        resourceId: recurringId,
        before,
        after: { deletedAt: deleted.deletedAt },
        requestId: request.requestId,
      });
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return true;
    }

    if (pathname === "/api/v1/club/courts" && request.method === "GET") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      sendData(response, 200, {
        club: clubView(club),
        courts: courts.listByClub(club.id).map(courtView),
      });
      return true;
    }

    if (pathname === "/api/v1/club/courts" && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const input = validateCourt(await readJson(request));
      // TASK-51: arenaId (se enviado) precisa ser uma arena do próprio clube
      if (
        input.arenaId &&
        !(club.arenas ?? []).some((arena) => arena.id === input.arenaId)
      ) {
        throw new ApiError(
          422,
          "validation_failed",
          "Selecione uma arena válida do seu clube.",
          { field: "arenaId" },
        );
      }
      const court = await courts.create({ clubId: club.id, ...input });
      sendData(
        response,
        201,
        { court: courtView(court) },
        {
          Location: `/api/v1/clubs/${club.id}`,
        },
      );
      return true;
    }

    const courtDeletionImpactRoute = pathname.match(
      /^\/api\/v1\/club\/courts\/([^/]+)\/deletion-impact$/,
    );
    if (courtDeletionImpactRoute && request.method === "GET") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const courtId = decodeURIComponent(courtDeletionImpactRoute[1]);
      const court = courts.findById(courtId);
      if (!court || court.clubId !== club.id) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      sendData(response, 200, {
        futureBookings: bookings.listFutureConfirmedByCourt(courtId).length,
      });
      return true;
    }

    const ownerCourtRoute = pathname.match(
      /^\/api\/v1\/club\/courts\/([^/]+)$/,
    );
    if (ownerCourtRoute && request.method === "PATCH") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const courtId = decodeURIComponent(ownerCourtRoute[1]);
      const court = courts.findById(courtId);
      if (!court || court.clubId !== club.id) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      const body = await readJson(request);
      const before = courtView(court);
      const updated =
        typeof body.active === "boolean" && Object.keys(body).length === 1
          ? await courts.setActive(courtId, body.active)
          : await courts.update(courtId, validateCourt(body));
      await auditLog.record({
        actorId: user.id,
        action: "court.updated",
        resourceType: "court",
        resourceId: courtId,
        before,
        after: courtView(updated),
        requestId: request.requestId,
      });
      sendData(response, 200, { court: courtView(updated) });
      return true;
    }

    if (ownerCourtRoute && request.method === "DELETE") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const courtId = decodeURIComponent(ownerCourtRoute[1]);
      const court = courts.findById(courtId);
      if (!court || court.clubId !== club.id) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      const futureBookings = bookings.listFutureConfirmedByCourt(courtId);
      if (url.searchParams.get("confirm") !== "true") {
        throw new ApiError(
          409,
          "court_deletion_confirmation_required",
          "Confirme a exclusão da quadra.",
          { futureBookings: futureBookings.length },
        );
      }
      const before = courtView(court);
      const cancelled = await withAgendaLock(async () => {
        const affected = await bookings.cancelFutureByCourt(courtId, user.id);
        await courts.delete(courtId);
        return affected;
      });
      await auditLog.record({
        actorId: user.id,
        action: "court.deleted",
        resourceType: "court",
        resourceId: courtId,
        before,
        after: { deleted: true, cancelledBookings: cancelled.length },
        requestId: request.requestId,
      });
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return true;
    }

    if (pathname === "/api/v1/club/bookings" && request.method === "GET") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      sendData(response, 200, {
        bookings: bookings.listByClub(club.id).map(bookingView),
      });
      return true;
    }

    if (pathname === "/api/v1/club/finance" && request.method === "GET") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const period = url.searchParams.get("period") || undefined;
      const periodRange = period ? financePeriodRange(period) : null;
      if (period && !periodRange) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe um período válido.",
          { field: "period" },
        );
      }
      const filters = {
        courtId: url.searchParams.get("courtId") || undefined,
        from: periodRange?.from || url.searchParams.get("from") || undefined,
        to: periodRange?.to || url.searchParams.get("to") || undefined,
      };
      if (
        (filters.from && !validDateKey(filters.from)) ||
        (filters.to && !validDateKey(filters.to)) ||
        Boolean(filters.from) !== Boolean(filters.to) ||
        (filters.from && filters.to && filters.from > filters.to)
      ) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe um período válido.",
          { field: "period" },
        );
      }
      if (
        filters.courtId &&
        !courts
          .listByClub(club.id)
          .some((court) => court.id === filters.courtId)
      ) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      sendData(response, 200, occupancyFor(club, filters));
      return true;
    }

    if (pathname === "/api/v1/clubs" && request.method === "GET") {
      const visibleClubs = clubs
        .list()
        .filter(
          (club) =>
            club.status === "active" &&
            courts.listActiveByClub(club.id).length > 0,
        )
        .map((club) => clubView(club));
      sendData(response, 200, { clubs: visibleClubs });
      return true;
    }

    const clubDetailRoute = pathname.match(/^\/api\/v1\/clubs\/([^/]+)$/);
    if (clubDetailRoute && request.method === "GET") {
      const club = clubs.findById(decodeURIComponent(clubDetailRoute[1]));
      if (!club || club.status !== "active") {
        throw new ApiError(404, "club_not_found", "Clube não encontrado.");
      }
      const date = url.searchParams.get("date") || brazilDateKey();
      if (!validDateKey(date)) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe uma data válida.",
          {
            field: "date",
          },
        );
      }
      sendData(response, 200, {
        club: clubView(club, { includeCourts: true }),
        date,
        availability: availabilityFor(club, date),
      });
      return true;
    }

    if (pathname === "/api/v1/player/bookings" && request.method === "GET") {
      const user = requireUser(request, "player");
      sendData(response, 200, {
        bookings: bookings.listByPlayer(user.id).map(bookingView),
      });
      return true;
    }

    const playerBookingRoute = pathname.match(
      /^\/api\/v1\/player\/bookings\/([^/]+)$/,
    );
    if (playerBookingRoute && request.method === "GET") {
      const user = requireUser(request, "player");
      const booking = bookings.findById(
        decodeURIComponent(playerBookingRoute[1]),
      );
      if (
        !booking ||
        !bookings
          .listByPlayer(user.id)
          .some((candidate) => candidate.id === booking.id)
      ) {
        throw new ApiError(404, "booking_not_found", "Reserva não encontrada.");
      }
      sendData(response, 200, { booking: bookingView(booking) });
      return true;
    }

    if (playerBookingRoute && request.method === "PATCH") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const bookingId = decodeURIComponent(playerBookingRoute[1]);
      const booking = bookings.findById(bookingId);
      if (!booking || booking.playerId !== user.id) {
        throw new ApiError(404, "booking_not_found", "Reserva não encontrada.");
      }
      const update = validateBookingUpdate(await readJson(request));
      if (update.visibility === "open") {
        assertPlayerEligibleForRange(user, update);
      }
      // TASK-79 — cancelar é simples e sem prazo/reembolso: não há mais
      // janela de cancelamento gratuito.
      const before = bookingAuditSnapshot(booking);
      const updated = await bookings.updateByOwner(bookingId, user.id, update);
      await auditLog.record({
        actorId: user.id,
        action:
          update.status === "cancelled"
            ? "booking.cancelled"
            : "booking.visibility_changed",
        resourceType: "booking",
        resourceId: updated.id,
        before,
        after: bookingAuditSnapshot(updated),
        requestId: request.requestId,
      });
      sendData(response, 200, { booking: bookingView(updated) });
      return true;
    }

    if (pathname === "/api/v1/player/bookings" && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      bookingLimiter.consume(user.id);
      const rawBody = await readJson(request);
      const input = validateBooking(rawBody);
      assertPlayerEligibleForRange(user, input);
      // TASK-49: o criador ocupa a primeira vaga, então também precisa ser
      // compatível com a categoria escolhida.
      if (input.visibility === "open") {
        assertGenderAllowed(
          { genderCategory: input.genderCategory, teams: null },
          user,
        );
      }
      // TASKS-14 / TASK-60 — o criador pode adicionar até 3 jogadores já na
      // criação; eles entram confirmados nas próximas vagas (team1 slot 1,
      // team2 slots 0 e 1), respeitando nível e categoria de gênero.
      let invitedPlayers = [];
      if (input.visibility === "open" && rawBody?.invitedPlayerIds) {
        const rawIds = rawBody.invitedPlayerIds;
        if (!Array.isArray(rawIds) || rawIds.length > 3) {
          throw new ApiError(
            422,
            "validation_failed",
            "Adicione no máximo 3 jogadores (as 3 vagas restantes).",
            { field: "invitedPlayerIds" },
          );
        }
        const ids = [...new Set(rawIds.map((id) => String(id ?? "").trim()))];
        if (ids.length !== rawIds.length || ids.includes(user.id)) {
          throw new ApiError(
            422,
            "validation_failed",
            "A lista de jogadores adicionados é inválida (repetidos ou você mesmo).",
            { field: "invitedPlayerIds" },
          );
        }
        invitedPlayers = ids.map((id) => {
          const invited = users.findById(id);
          if (!invited || invited.role !== "player") {
            throw new ApiError(
              422,
              "validation_failed",
              "Um dos jogadores adicionados não foi encontrado.",
              { field: "invitedPlayerIds" },
            );
          }
          assertPlayerEligibleForRange(invited, input);
          return invited;
        });
      }
      const futureOwnedBookings = bookings
        .listByPlayer(user.id)
        .filter(
          (booking) =>
            booking.playerId === user.id &&
            booking.status === "confirmed" &&
            new Date(booking.startAt).getTime() > Date.now(),
        ).length;
      if (futureOwnedBookings >= 8) {
        throw new ApiError(
          429,
          "active_booking_limit_reached",
          "Você pode manter no máximo oito jogos futuros ativos.",
          { maximumActiveBookings: 8 },
        );
      }
      const club = clubs.findById(input.clubId);
      const court = courts.findById(input.courtId);
      if (!club || club.status !== "active") {
        throw new ApiError(404, "club_not_found", "Clube não encontrado.");
      }
      if (!court || court.clubId !== club.id || !court.active) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      const booking = await withAgendaLock(async () => {
        const selectedAvailability = availabilityFor(
          club,
          brazilDateKey(input.startAt),
        ).find((item) => item.courtId === court.id);
        const selectedSlot = selectedAvailability?.slots.find(
          (slot) => slot.startAt === input.startAt,
        );
        if (!selectedSlot) {
          throw new ApiError(
            422,
            "invalid_slot",
            "O horário selecionado não pertence à grade desta quadra.",
            { field: "startAt" },
          );
        }
        // TASK-79 — o Quadrafy não é mais o sistema oficial de reserva:
        // isso não bloqueia mais a criação, só avisa (a menos que o
        // jogador já tenha confirmado o aviso com `allowConflict`).
        if (!selectedSlot.available && !input.allowConflict) {
          throw new ApiError(
            409,
            "booking_conflict",
            "Já existe um jogo criado ou um compromisso fixo neste horário nesta quadra. Você tem certeza que também reservou este horário por fora?",
            { courtId: court.id, startAt: input.startAt },
          );
        }
        return bookings.create({
          ...input,
          playerId: user.id,
          status: "confirmed",
          // já verificamos acima (inclui reservas fixas do clube, que o
          // hasConflict interno do store não enxerga).
          allowConflict: true,
        });
      });
      // TASK-60: posiciona os convidados nas vagas seguintes, validando a
      // regra de gênero vaga a vaga (mesma lógica do join normal).
      const INVITE_POSITIONS = [
        { team: "team1", slot: 1 },
        { team: "team2", slot: 0 },
        { team: "team2", slot: 1 },
      ];
      let finalBooking = booking;
      for (const [index, invited] of invitedPlayers.entries()) {
        const position = INVITE_POSITIONS[index];
        assertGenderAllowed(bookings.findById(booking.id), invited, position);
        finalBooking = await bookings.join(booking.id, invited.id, position);
      }
      await auditLog.record({
        actorId: user.id,
        action: "booking.created",
        resourceType: "booking",
        resourceId: booking.id,
        after: bookingAuditSnapshot(booking),
        requestId: request.requestId,
      });
      sendData(
        response,
        201,
        { booking: bookingView(finalBooking) },
        {
          Location: `/api/v1/player/bookings/${booking.id}`,
        },
      );
      return true;
    }

    if (pathname === "/api/v1/matches" && request.method === "GET") {
      const user = requireUser(request, "player");
      const now = Date.now();
      const scope = url.searchParams.get("scope") ?? "open";
      const openBookings = bookings.listOpen();
      // TASK-33: o corte é o horário de início — antes dele o jogo fica em
      // "Jogos abertos"; a partir dele passa para o "Histórico" do jogador.
      const started = (booking) =>
        new Date(booking.startAt).getTime() <= now;
      // TASK-35: partidas do histórico do jogador ainda sem resultado
      // confirmado (sem lançamento OU aguardando confirmação — nos dois
      // casos falta ação de algum jogador).
      const historyBookings = openBookings.filter(
        (booking) =>
          started(booking) &&
          (booking.participantIds ?? []).includes(user.id),
      );
      const pendingResults = historyBookings.filter(
        (booking) =>
          matchResults.findByMatch(booking.id)?.status !== "confirmed",
      ).length;
      // TASK-50 — filtro opcional por categoria de gênero.
      const genderFilter = url.searchParams.get("genderCategory");
      const matchesGenderFilter = (booking) =>
        !genderFilter ||
        (booking.genderCategory ?? "all") === genderFilter;
      // TASKS-14 / TASK-61: partidas cheias somem da listagem pública —
      // só participantes continuam vendo (alimenta o "Meus jogos", TASK-62).
      const visibleToUser = (booking) =>
        (booking.openSpots ?? 0) > 0 ||
        (booking.participantIds ?? []).includes(user.id);
      const selected =
        scope === "history"
          ? historyBookings
          : openBookings.filter(
              (booking) =>
                !started(booking) &&
                matchesGenderFilter(booking) &&
                visibleToUser(booking),
            );
      const matches = selected
        .sort(
          (a, b) =>
            scope === "history"
              ? new Date(b.startAt).getTime() - new Date(a.startAt).getTime()
              : new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
        )
        .map((booking) => matchView(booking, user));
      sendData(response, 200, { matches, pendingResults });
      return true;
    }

    const matchTeamsRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/teams$/,
    );
    if (matchTeamsRoute && request.method === "PATCH") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchTeamsRoute[1]);
      const input = await readJson(request);
      const current = bookings.findById(matchId);
      const before = current?.teams
        ? {
            team1: [...current.teams.team1],
            team2: [...current.teams.team2],
          }
        : null;
      const booking = await bookings.reorganizeTeams(
        matchId,
        user.id,
        input.teams ?? input,
      );
      await auditLog.record({
        actorId: user.id,
        action: "match.teams_reorganized",
        resourceType: "booking",
        resourceId: matchId,
        before: { teams: before },
        after: { teams: booking.teams },
        requestId: request.requestId,
      });
      sendData(response, 200, { match: matchView(booking, user) });
      return true;
    }

    const matchMessagesRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/messages$/,
    );
    if (
      matchMessagesRoute &&
      (request.method === "GET" || request.method === "POST")
    ) {
      if (request.method === "POST") assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchMessagesRoute[1]);
      const booking = bookings.findById(matchId);
      if (
        !booking ||
        booking.visibility !== "open" ||
        booking.status !== "confirmed"
      ) {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      if (!(booking.participantIds ?? []).includes(user.id)) {
        throw new ApiError(
          403,
          "match_chat_forbidden",
          "Entre no jogo para acessar o chat da partida.",
        );
      }

      if (request.method === "GET") {
        chatReadLimiter.consume(user.id);
        const parsedLimit = Number(url.searchParams.get("limit") ?? 50);
        if (
          !Number.isInteger(parsedLimit) ||
          parsedLimit < 1 ||
          parsedLimit > 100
        ) {
          throw new ApiError(
            422,
            "validation_failed",
            "Informe um limite entre 1 e 100.",
            { field: "limit" },
          );
        }
        const after = url.searchParams.get("after") || undefined;
        if (after && after.length > 100) {
          throw new ApiError(
            422,
            "validation_failed",
            "Informe um cursor de mensagens válido.",
            { field: "after" },
          );
        }
        const messagePage = matchMessages.listByMatch(matchId, {
          after,
          limit: parsedLimit + 1,
        });
        const hasMore = messagePage.length > parsedLimit;
        const messages = messagePage.slice(0, parsedLimit);
        sendData(response, 200, {
          messages: messages.map(messageView),
          nextCursor: hasMore ? (messages.at(-1)?.id ?? null) : null,
        });
        return true;
      }

      chatLimiter.consume(user.id);
      const input = validateMatchMessage(await readJson(request));
      const message = await matchMessages.create({
        matchId,
        playerId: user.id,
        content: input.content,
      });
      sendData(
        response,
        201,
        { message: messageView(message) },
        { Location: `/api/v1/matches/${matchId}/messages#${message.id}` },
      );
      return true;
    }

    const matchDetailRoute = pathname.match(/^\/api\/v1\/matches\/([^/]+)$/);
    if (matchDetailRoute && request.method === "GET") {
      const user = requireUser(request, "player");
      const booking = bookings.findById(
        decodeURIComponent(matchDetailRoute[1]),
      );
      if (
        !booking ||
        booking.visibility !== "open" ||
        booking.status !== "confirmed"
      ) {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      sendData(response, 200, { match: matchView(booking, user) });
      return true;
    }

    const matchJoinRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/join$/,
    );
    if (matchJoinRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchJoinRoute[1]);
      const currentMatch = bookings.findById(matchId);
      if (currentMatch) assertPlayerEligibleForRange(user, currentMatch);
      const hasJsonBody = String(request.headers["content-type"] || "")
        .toLowerCase()
        .includes("application/json");
      const position = hasJsonBody ? await readJson(request) : null;
      if (currentMatch) assertGenderAllowed(currentMatch, user, position);
      const booking = await bookings.join(matchId, user.id, position);
      sendData(response, 200, { match: matchView(booking, user) });
      return true;
    }

    // TASK-13: sair do jogo. Regra escolhida (mais simples): o organizador
    // não pode sair enquanto houver outros participantes — ele deve cancelar
    // a reserva inteira pela tela de reservas.
    const matchLeaveRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/leave$/,
    );
    if (matchLeaveRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchLeaveRoute[1]);
      const current = bookings.findById(matchId);
      if (
        current &&
        current.playerId === user.id &&
        (current.participantIds ?? []).length > 1
      ) {
        throw new ApiError(
          409,
          "organizer_cannot_leave",
          "O organizador não pode sair enquanto houver outros jogadores. Cancele a reserva pela tela de reservas.",
        );
      }
      const booking = await bookings.leave(matchId, user.id);
      await auditLog.record({
        actorId: user.id,
        action: "match.left",
        resourceType: "booking",
        resourceId: matchId,
        before: null,
        after: { teams: booking.teams },
        requestId: request.requestId,
      });
      sendData(response, 200, { match: matchView(booking, user) });
      return true;
    }

    // TASK-32 — organizador remove outro jogador da partida.
    const matchRemovePlayerRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/remove-player$/,
    );
    if (matchRemovePlayerRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchRemovePlayerRoute[1]);
      const input = await readJson(request);
      const removedPlayerId = String(input?.playerId ?? "").trim();
      if (!removedPlayerId) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe o jogador a ser removido.",
          { field: "playerId" },
        );
      }
      const booking = await bookings.removePlayer(
        matchId,
        user.id,
        removedPlayerId,
      );
      await auditLog.record({
        actorId: user.id,
        action: "match.player_removed",
        resourceType: "booking",
        resourceId: matchId,
        before: null,
        after: { removedPlayerId, teams: booking.teams },
        requestId: request.requestId,
      });
      sendData(response, 200, { match: matchView(booking, user) });
      return true;
    }

    // TASK-12: participante move a própria posição para uma vaga vazia.
    const matchMoveRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/position$/,
    );
    if (matchMoveRoute && request.method === "PATCH") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchMoveRoute[1]);
      const input = await readJson(request);
      const currentForMove = bookings.findById(matchId);
      if (currentForMove) {
        assertGenderAllowed(currentForMove, user, {
          team: input.team,
          slot: input.slot,
        });
      }
      const booking = await bookings.moveSelf(
        matchId,
        user.id,
        input.team,
        input.slot,
      );
      await auditLog.record({
        actorId: user.id,
        action: "match.position_changed",
        resourceType: "booking",
        resourceId: matchId,
        before: null,
        after: { teams: booking.teams },
        requestId: request.requestId,
      });
      sendData(response, 200, { match: matchView(booking, user) });
      return true;
    }

    // TASK-17/17B — lançamento e confirmação cruzada de resultado.
    function matchResultView(entry, viewer) {
      const reporterTeam = matchResults.playerTeam(entry, entry.reportedBy);
      const viewerTeam = viewer
        ? matchResults.playerTeam(entry, viewer.id)
        : null;
      return {
        id: entry.id,
        matchId: entry.matchId,
        sets: entry.sets,
        winningTeam: entry.winningTeam,
        reportedBy: entry.reportedBy,
        reporterName: displayName(users.findById(entry.reportedBy)),
        reporterTeam,
        status: entry.status,
        confirmedBy: entry.confirmedBy,
        createdAt: entry.createdAt,
        confirmedAt: entry.confirmedAt,
        viewerTeam,
        canConfirm:
          entry.status === "pending" &&
          Boolean(viewerTeam) &&
          viewerTeam !== reporterTeam,
        // TASK-36: variação de nível dos 4 jogadores (disponível após a
        // confirmação, persistida junto ao resultado).
        levelChanges:
          entry.status === "confirmed" && entry.levelChanges
            ? Object.fromEntries(
                Object.entries(entry.levelChanges).map(
                  ([playerId, change]) => {
                    const player = users.findById(playerId);
                    const profile = player?.profile ?? {};
                    return [
                      playerId,
                      {
                        ...change,
                        displayName: displayName(player),
                        photoUrl: profile.photoUrl ?? "",
                        team: matchResults.playerTeam(entry, playerId),
                      },
                    ];
                  },
                ),
              )
            : null,
      };
    }

    function requireResultEligibleMatch(matchId, user) {
      const booking = bookings.findById(matchId);
      if (
        !booking ||
        booking.visibility !== "open" ||
        booking.status !== "confirmed"
      ) {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      const participantIds = booking.participantIds ?? [];
      if (!participantIds.includes(user.id)) {
        throw new ApiError(
          403,
          "match_result_forbidden",
          "Apenas participantes da partida podem lançar ou confirmar o resultado.",
        );
      }
      const teams = booking.teams ?? null;
      const isFull =
        teams &&
        ["team1", "team2"].every(
          (team) =>
            Array.isArray(teams[team]) &&
            teams[team].filter(Boolean).length === 2,
        );
      if (!isFull) {
        throw new ApiError(
          409,
          "match_not_full",
          "A partida precisa estar com as duas duplas completas (4 jogadores) para lançar o resultado.",
        );
      }
      // TASK-34 (revoga o "modo teste" da TASK-17B): o resultado só pode ser
      // lançado depois do horário de início da reserva — ou seja, quando a
      // partida já está no Histórico.
      if (new Date(booking.startAt).getTime() > Date.now()) {
        throw new ApiError(
          409,
          "match_not_started",
          "O resultado só pode ser lançado após o horário de início da partida.",
        );
      }
      return booking;
    }

    const matchResultRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/result$/,
    );
    if (matchResultRoute && request.method === "GET") {
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchResultRoute[1]);
      const booking = bookings.findById(matchId);
      if (!booking || !(booking.participantIds ?? []).includes(user.id)) {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      const entry = matchResults.findByMatch(matchId);
      sendData(response, 200, {
        result: entry ? matchResultView(entry, user) : null,
      });
      return true;
    }
    if (matchResultRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchResultRoute[1]);
      const booking = requireResultEligibleMatch(matchId, user);
      const { sets, winningTeam } = validateMatchResult(
        await readJson(request),
      );
      const teams = {
        team1: booking.teams.team1.filter(Boolean),
        team2: booking.teams.team2.filter(Boolean),
      };
      const allPlayerIds = [...teams.team1, ...teams.team2];
      const playerLevels = Object.fromEntries(
        allPlayerIds.map((playerId) => {
          const level = Number(users.findById(playerId)?.profile?.level);
          return [playerId, Number.isFinite(level) ? level : 3.5];
        }),
      );
      const playerReliabilities = Object.fromEntries(
        allPlayerIds.map((playerId) => [
          playerId,
          normalizeReliability(
            users.findById(playerId)?.profile?.levelConfidence,
          ),
        ]),
      );
      const entry = await matchResults.create({
        matchId,
        teams,
        playerLevels,
        playerReliabilities,
        sets,
        winningTeam,
        reportedBy: user.id,
      });
      await auditLog.record({
        actorId: user.id,
        action: "match.result_reported",
        resourceType: "booking",
        resourceId: matchId,
        before: null,
        after: { sets, winningTeam },
        requestId: request.requestId,
      });
      sendData(response, 201, { result: matchResultView(entry, user) });
      return true;
    }

    const matchResultConfirmRoute = pathname.match(
      /^\/api\/v1\/matches\/([^/]+)\/result\/confirm$/,
    );
    if (matchResultConfirmRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const matchId = decodeURIComponent(matchResultConfirmRoute[1]);
      requireResultEligibleMatch(matchId, user);
      const entry = await matchResults.confirm(matchId, user.id);

      // TASKS-07 / TASK-28 — dispara o motor "Playtomic Engine" (pote de
      // pontos + distribuição inversa) para os 4 jogadores, usando níveis e
      // fiabilidades capturados no momento do lançamento (determinístico).
      const players = ["team1", "team2"].flatMap((team) =>
        entry.teams[team].map((playerId) => {
          const profile = users.findById(playerId)?.profile ?? {};
          return {
            id: playerId,
            team,
            level: entry.playerLevels[playerId],
            reliability: normalizeReliability(
              entry.playerReliabilities?.[playerId] ??
                profile.levelConfidence,
            ),
            matchesPlayed: Number(profile.matchesPlayed) || 0,
          };
        }),
      );
      const { updates, breakdown } = computeMatchOutcome({
        players,
        winningTeam: entry.winningTeam,
      });

      const levelChanges = {};
      for (const player of players) {
        const update = updates[player.id];
        const profile = users.findById(player.id)?.profile ?? {};
        const wins = (Number(profile.wins) || 0) + (update.won ? 1 : 0);
        const winRate =
          Math.round((wins / update.matchesPlayed) * 1000) / 10;
        await users.updateProfile(player.id, {
          level: update.level,
          levelConfidence: update.reliability,
          levelCategory: update.classification.technical,
          matchesPlayed: update.matchesPlayed,
          wins,
          winRate,
        });
        levelChanges[player.id] = {
          previousLevel: update.previousLevel,
          level: update.level,
          delta: update.delta,
          won: update.won,
        };
      }
      // TASK-36: persiste o ΔNível junto ao resultado para consulta futura
      // por qualquer um dos 4 jogadores.
      await matchResults.attachOutcome(matchId, { breakdown, levelChanges });
      await levelHistory.recordMany(
        players.map((player) => ({
          playerId: player.id,
          level: updates[player.id].level,
          levelCategory: updates[player.id].classification.technical,
          // TASK-30: histórico também guarda a fiabilidade de cada mudança.
          levelConfidence: updates[player.id].reliability,
          source: "match_result",
          matchId,
        })),
      );
      await auditLog.record({
        actorId: user.id,
        action: "match.result_confirmed",
        resourceType: "booking",
        resourceId: matchId,
        before: null,
        after: { winningTeam: entry.winningTeam, levelChanges },
        requestId: request.requestId,
      });
      const achievementsByPlayer = await achievementsEngine.verifyPlayers(
        players.map((player) => player.id),
      );
      sendData(response, 200, {
        result: matchResultView(entry, user),
        levelChanges,
        achievementsUnlocked: achievementsByPlayer[user.id] ?? [],
      });
      return true;
    }

    // TASK-29 — explicador determinístico do último resultado confirmado.
    // Recalcula localmente (mesma função do motor), sem nenhuma chamada de IA.
    if (
      pathname === "/api/v1/player/level-explanation" &&
      request.method === "GET"
    ) {
      const user = requireUser(request, "player");
      const confirmed = matchResults.listConfirmedByPlayer(user.id);
      const entry = confirmed.at(-1) ?? null;
      if (!entry) {
        sendData(response, 200, { explanation: null });
        return true;
      }
      const players = ["team1", "team2"].flatMap((team) =>
        entry.teams[team].map((playerId) => ({
          id: playerId,
          team,
          level: entry.playerLevels[playerId] ?? 3.5,
          reliability: normalizeReliability(
            entry.playerReliabilities?.[playerId] ??
              users.findById(playerId)?.profile?.levelConfidence,
          ),
          matchesPlayed: 0,
        })),
      );
      const { updates, breakdown } = computeMatchOutcome({
        players,
        winningTeam: entry.winningTeam,
      });
      const me = updates[user.id];
      const profile = user.profile ?? {};
      const currentLevel = Number(profile.level);
      const classification = classificationFor(
        Number.isFinite(currentLevel) ? currentLevel : me.level,
      );
      const reliability = normalizeReliability(profile.levelConfidence);
      const myTeam = matchResults.playerTeam(entry, user.id);
      sendData(response, 200, {
        explanation: {
          matchId: entry.matchId,
          confirmedAt: entry.confirmedAt,
          myTeam,
          won: me.won,
          averages: breakdown.averages,
          reliabilities: breakdown.reliabilities,
          difference: breakdown.difference,
          favorite: breakdown.favorite,
          upset: breakdown.upset,
          potBase: breakdown.potBase,
          multiplier: breakdown.multipliers[myTeam],
          pot: breakdown.pots[myTeam],
          weight: me.weight,
          delta: me.delta,
          previousLevel: me.previousLevel,
          newLevel: me.level,
          // Formato final exigido: "Nível: X.XX (Categoria) | Fiabilidade: XX%"
          summary: `Nível: ${(Number.isFinite(currentLevel) ? currentLevel : me.level).toFixed(2)} (${classification.category}) | Fiabilidade: ${Math.round(reliability)}%`,
        },
      });
      return true;
    }

    // TASK-19 — série histórica de nível do jogador autenticado.
    if (
      pathname === "/api/v1/player/level-history" &&
      request.method === "GET"
    ) {
      const user = requireUser(request, "player");
      sendData(response, 200, {
        history: levelHistory.listByPlayer(user.id).map((entry) => ({
          level: entry.level,
          levelCategory: entry.levelCategory,
          levelConfidence: entry.levelConfidence ?? null,
          source: entry.source,
          matchId: entry.matchId,
          createdAt: entry.createdAt,
        })),
      });
      return true;
    }

    // TASK-23 — estatísticas segmentadas por força do adversário + sequência.
    if (pathname === "/api/v1/player/stats" && request.method === "GET") {
      const user = requireUser(request, "player");
      const SIMILAR_LEVEL_MARGIN = 0.3;
      const confirmed = matchResults.listConfirmedByPlayer(user.id);
      const segments = {
        higher: { played: 0, wins: 0 },
        similar: { played: 0, wins: 0 },
        lower: { played: 0, wins: 0 },
      };
      let currentWinStreak = 0;
      let streakOpen = true;
      for (const entry of [...confirmed].reverse()) {
        const myTeam = matchResults.playerTeam(entry, user.id);
        const won = entry.winningTeam === myTeam;
        if (streakOpen) {
          if (won) currentWinStreak += 1;
          else streakOpen = false;
        }
      }
      for (const entry of confirmed) {
        const myTeam = matchResults.playerTeam(entry, user.id);
        const opponentTeam = myTeam === "team1" ? "team2" : "team1";
        const myLevel = entry.playerLevels[user.id];
        const opponentLevels = entry.teams[opponentTeam].map(
          (playerId) => entry.playerLevels[playerId] ?? 3.5,
        );
        const opponentAverage =
          opponentLevels.reduce((sum, level) => sum + level, 0) /
          Math.max(1, opponentLevels.length);
        const difference = opponentAverage - myLevel;
        const bucket =
          difference > SIMILAR_LEVEL_MARGIN
            ? segments.higher
            : difference < -SIMILAR_LEVEL_MARGIN
              ? segments.lower
              : segments.similar;
        bucket.played += 1;
        if (entry.winningTeam === myTeam) bucket.wins += 1;
      }
      const rate = (bucket) =>
        bucket.played
          ? Math.round((bucket.wins / bucket.played) * 1000) / 10
          : null;
      const profile = user.profile ?? {};
      sendData(response, 200, {
        stats: {
          matchesPlayed: Number(profile.matchesPlayed) || confirmed.length,
          wins: Number(profile.wins) || 0,
          winRate: Number.isFinite(Number(profile.winRate))
            ? Number(profile.winRate)
            : null,
          winRateVsHigherLevel: rate(segments.higher),
          winRateVsSimilarLevel: rate(segments.similar),
          winRateVsLowerLevel: rate(segments.lower),
          playedVsHigherLevel: segments.higher.played,
          playedVsSimilarLevel: segments.similar.played,
          playedVsLowerLevel: segments.lower.played,
          currentWinStreak,
        },
      });
      return true;
    }

    // TASK-20 — parceiros frequentes e rivais recorrentes.
    if (
      pathname === "/api/v1/player/connections" &&
      request.method === "GET"
    ) {
      const user = requireUser(request, "player");
      // As conexões são agregadas sob demanda; esse é o gatilho natural para
      // as conquistas sociais, sem criar um segundo fluxo de manutenção.
      const achievementsUnlocked = await achievementsEngine.verifyPlayer(user.id);
      const confirmed = matchResults.listConfirmedByPlayer(user.id);
      const partners = new Map();
      const rivals = new Map();
      for (const entry of confirmed) {
        const myTeam = matchResults.playerTeam(entry, user.id);
        const opponentTeam = myTeam === "team1" ? "team2" : "team1";
        for (const playerId of entry.teams[myTeam]) {
          if (playerId === user.id) continue;
          partners.set(playerId, (partners.get(playerId) || 0) + 1);
        }
        for (const playerId of entry.teams[opponentTeam]) {
          rivals.set(playerId, (rivals.get(playerId) || 0) + 1);
        }
      }
      const publicConnection = ([playerId, matches]) => {
        const player = users.findById(playerId);
        if (!player) return null;
        const profile = player.profile ?? {};
        return {
          id: playerId,
          displayName: displayName(player),
          photoUrl: profile.photoUrl ?? "",
          level: Number.isFinite(Number(profile.level))
            ? Number(profile.level)
            : null,
          matches,
        };
      };
      const toSortedList = (map) =>
        [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(publicConnection)
          .filter(Boolean);
      sendData(response, 200, {
        frequentPartners: toSortedList(partners),
        recurringRivals: toSortedList(rivals),
        achievementsUnlocked,
      });
      return true;
    }

    // ================= TASKS-09 — Super 8 =================
    // Decisão de produto (TASK-42): os jogos de Super 8 NÃO passam pelo
    // fluxo de resultado/nível oficial (TASKS-06/07/08) nesta fase — o
    // torneio é uma competição interna do clube; uma pontuação própria
    // (ex.: saldo de games) pode ser adicionada depois. Validar com produto
    // antes de mudar essa regra.

    // TASK-77 — categoria técnica (das 7 oficiais) do nível atual do jogador.
    function playerLevelCategory(user) {
      return classificationFor(user?.profile?.level)?.technical ?? null;
    }

    function levelCategoriesLabel(levelCategories) {
      return levelCategories?.length
        ? levelCategories.join(" e ")
        : "todas as categorias";
    }

    // TASK-76 — enriquece o jogador do quadro com foto/nível atuais (quando
    // vinculado a uma conta), para a tela de detalhe completo.
    function playerWithProfile(player) {
      const linked = player.id ? users.findById(player.id) : null;
      const level = Number.isFinite(Number(linked?.profile?.level))
        ? Number(linked.profile.level)
        : null;
      return {
        ...player,
        photoUrl: linked?.profile?.photoUrl ?? null,
        level,
        levelCategory: classificationFor(level)?.technical ?? null,
      };
    }

    function super8View(tournament) {
      return {
        id: tournament.id,
        name: tournament.name,
        size: tournament.size,
        mode: tournament.mode,
        players: tournament.players.map(playerWithProfile),
        pairs: tournament.pairs,
        startTime: tournament.startTime ?? null,
        // TASK-77
        levelCategories: tournament.levelCategories ?? null,
        courtIds: tournament.courtIds,
        // TASK-76 — nomes das quadras, prontos para exibição.
        courts: (tournament.courtIds ?? [])
          .map((courtId) => courts.findById(courtId))
          .filter(Boolean)
          .map((court) => ({ id: court.id, name: court.name })),
        games: tournament.games ?? [],
        gamesTotal: (tournament.games ?? []).length,
        gamesFinished: (tournament.games ?? []).filter(
          (game) => game.status === "finalizado",
        ).length,
        standings: tournament.standings ?? null,
        status: tournament.status,
        createdAt: tournament.createdAt,
        updatedAt: tournament.updatedAt,
      };
    }

    // TASK-37 — listagem dos torneios do clube.
    if (pathname === "/api/v1/club/super8" && request.method === "GET") {
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      sendData(response, 200, {
        tournaments: super8.listByClub(club.id).map(super8View),
      });
      return true;
    }

    // TASK-38 — criação do torneio.
    if (pathname === "/api/v1/club/super8" && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const input = validateSuper8(await readJson(request));
      // jogadores vinculados precisam existir e ser jogadores da plataforma
      const players = input.players.map((player) => {
        if (!player.id) return player;
        const linked = users.findById(player.id);
        if (!linked || linked.role !== "player") {
          throw new ApiError(
            422,
            "validation_failed",
            "Um dos jogadores selecionados não foi encontrado.",
            { field: "players" },
          );
        }
        // TASK-77 — jogador precisa estar dentro das categorias permitidas
        // (jogadores sem nível definido ainda não podem ser adicionados a um
        // torneio com restrição de categoria).
        if (input.levelCategories) {
          const category = playerLevelCategory(linked);
          if (!category || !input.levelCategories.includes(category)) {
            throw new ApiError(
              422,
              "validation_failed",
              `Este Super 8 é restrito às categorias ${levelCategoriesLabel(input.levelCategories)}.`,
              { field: "players" },
            );
          }
        }
        return { id: linked.id, name: displayName(linked) };
      });
      const tournament = await super8.create({
        clubId: club.id,
        name: input.name,
        size: input.size,
        mode: input.mode,
        players,
        pairs: input.pairs,
        startTime: input.startTime,
        levelCategories: input.levelCategories,
      });
      await auditLog.record({
        actorId: user.id,
        action: "super8.created",
        resourceType: "super8",
        resourceId: tournament.id,
        before: null,
        after: { name: input.name, size: input.size, mode: input.mode },
        requestId: request.requestId,
      });
      sendData(response, 201, { tournament: super8View(tournament) });
      return true;
    }

    // TASK-39 — quadras (e horário opcional) do torneio.
    const super8CourtsRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/courts$/,
    );
    if (super8CourtsRoute && request.method === "PATCH") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(super8CourtsRoute[1]);
      super8.requireOwned(tournamentId, club.id);
      const input = validateSuper8Courts(await readJson(request));
      const owned = courts.listByClub(club.id).map((court) => court.id);
      if (input.courtIds.some((courtId) => !owned.includes(courtId))) {
        throw new ApiError(
          422,
          "validation_failed",
          "Selecione apenas quadras do seu clube.",
          { field: "courtIds" },
        );
      }
      const tournament = await super8.update(tournamentId, club.id, {
        courtIds: input.courtIds,
      });
      sendData(response, 200, { tournament: super8View(tournament) });
      return true;
    }

    // TASK-74 — define (ou redefine) as duplas fixas depois que o quadro
    // completa via inscrição espontânea/preenchimento manual (quando não
    // vieram já definidas na criação).
    const super8PairsRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/pairs$/,
    );
    if (super8PairsRoute && request.method === "PATCH") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(super8PairsRoute[1]);
      const current = super8.requireOwned(tournamentId, club.id);
      if (current.mode !== "duplas_fixas") {
        throw new ApiError(
          409,
          "super8_pairs_unavailable",
          "As duplas só se aplicam à modalidade duplas fixas.",
        );
      }
      if (current.status !== "em_configuracao") {
        throw new ApiError(
          409,
          "super8_pairs_unavailable",
          "As duplas só podem ser definidas antes de gerar a tabela.",
        );
      }
      if (current.players.length !== current.size) {
        throw new ApiError(
          409,
          "super8_roster_incomplete",
          `O torneio precisa de ${current.size} jogadores para definir as duplas (faltam ${current.size - current.players.length}).`,
        );
      }
      const body = await readJson(request);
      const pairs = validateSuper8Pairs(body?.pairs, current.size);
      const tournament = await super8.update(tournamentId, club.id, {
        pairs,
      });
      sendData(response, 200, { tournament: super8View(tournament) });
      return true;
    }

    // TASK-40 — gera as rodadas e marca o torneio como "gerado".
    const super8GenerateRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/generate$/,
    );
    if (super8GenerateRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(super8GenerateRoute[1]);
      const current = super8.requireOwned(tournamentId, club.id);
      if (current.status === "em_andamento" || current.status === "finalizado") {
        throw new ApiError(
          409,
          "super8_already_published",
          "O torneio já foi publicado e não pode ser regenerado.",
        );
      }
      if (!current.courtIds.length) {
        throw new ApiError(
          409,
          "super8_courts_required",
          "Selecione as quadras do torneio antes de gerar a tabela.",
        );
      }
      if (current.players.length !== current.size) {
        throw new ApiError(
          409,
          "super8_roster_incomplete",
          `O torneio precisa de ${current.size} jogadores para gerar a tabela (faltam ${current.size - current.players.length}).`,
        );
      }
      // TASK-74: quando o quadro completa por vagas em aberto, as duplas
      // fixas precisam ser definidas (PATCH .../pairs) antes de gerar.
      if (current.mode === "duplas_fixas" && !current.pairs) {
        throw new ApiError(
          409,
          "super8_pairs_required",
          "Defina as duplas antes de gerar a tabela.",
        );
      }
      const tournamentCourts = current.courtIds
        .map((courtId) => courts.findById(courtId))
        .filter(Boolean)
        .map((court) => ({ id: court.id, name: court.name }));
      // TASK-43: lista plana de confrontos, sem qualquer horário.
      const games = generateSuper8Games({
        mode: current.mode,
        players: current.players,
        pairs: current.pairs ?? [],
        courts: tournamentCourts,
      }).map((game) => ({
        id: createId(),
        ...game,
        status: "aguardando",
        score: null,
      }));
      const tournament = await super8.update(tournamentId, club.id, {
        games,
        standings: null,
        status: "gerado",
      });
      sendData(response, 200, { tournament: super8View(tournament) });
      return true;
    }

    // TASK-41 — publica o torneio, tornando-o visível aos jogadores.
    const super8PublishRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/publish$/,
    );
    if (super8PublishRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(super8PublishRoute[1]);
      const current = super8.requireOwned(tournamentId, club.id);
      if (current.status !== "gerado") {
        throw new ApiError(
          409,
          "super8_not_generated",
          "Gere a tabela do torneio antes de publicar.",
        );
      }
      const tournament = await super8.update(tournamentId, club.id, {
        status: "em_andamento",
      });
      await auditLog.record({
        actorId: user.id,
        action: "super8.published",
        resourceType: "super8",
        resourceId: tournamentId,
        before: null,
        after: { status: "em_andamento" },
        requestId: request.requestId,
      });
      sendData(response, 200, { tournament: super8View(tournament) });
      return true;
    }

    // TASKS-12 / TASK-47 / TASK-74 — clube abre inscrições para completar o
    // quadro em qualquer modalidade; em duplas fixas as duplas são definidas
    // à parte (PATCH .../pairs) depois que o quadro completar.
    const super8OpenRegistrationsRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/open-registrations$/,
    );
    if (super8OpenRegistrationsRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(super8OpenRegistrationsRoute[1]);
      const current = super8.requireOwned(tournamentId, club.id);
      if (current.status !== "em_configuracao") {
        throw new ApiError(
          409,
          "super8_registrations_unavailable",
          "As inscrições só podem ser abertas enquanto o torneio está em configuração.",
        );
      }
      if (current.players.length >= current.size) {
        throw new ApiError(
          409,
          "super8_full",
          "O quadro de jogadores já está completo.",
        );
      }
      const tournament = await super8.update(tournamentId, club.id, {
        status: "inscricoes_abertas",
      });
      sendData(response, 200, { tournament: super8View(tournament) });
      return true;
    }

    // TASKS-14 / TASK-63 — clube fecha as inscrições quando quiser; o
    // torneio volta para "em_configuracao". A geração dos confrontos segue
    // exigindo o número exato de jogadores (regra sugerida no documento,
    // para não quebrar o motor de rotação).
    const super8CloseRegistrationsRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/close-registrations$/,
    );
    if (super8CloseRegistrationsRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(
        super8CloseRegistrationsRoute[1],
      );
      const current = super8.requireOwned(tournamentId, club.id);
      if (current.status !== "inscricoes_abertas") {
        throw new ApiError(
          409,
          "super8_registrations_unavailable",
          "Este torneio não está com inscrições abertas.",
        );
      }
      const tournament = await super8.update(tournamentId, club.id, {
        status: "em_configuracao",
      });
      sendData(response, 200, { tournament: super8View(tournament) });
      return true;
    }

    // TASKS-12 / TASK-44 — o dono do clube lança (e pode corrigir) o placar
    // de qualquer jogo, em qualquer ordem, sem confirmação de jogadores.
    const super8GameResultRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/games\/([^/]+)\/result$/,
    );
    if (super8GameResultRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(super8GameResultRoute[1]);
      const gameId = decodeURIComponent(super8GameResultRoute[2]);
      const current = super8.requireOwned(tournamentId, club.id);
      if (!["gerado", "em_andamento"].includes(current.status)) {
        throw new ApiError(
          409,
          "super8_result_unavailable",
          "Os resultados só podem ser lançados com o torneio gerado ou em andamento.",
        );
      }
      const score = validateSuper8GameResult(await readJson(request));
      const games = (current.games ?? []).map((game) =>
        game.id === gameId
          ? { ...game, status: "finalizado", score }
          : game,
      );
      if (!games.some((game) => game.id === gameId)) {
        throw new ApiError(
          404,
          "super8_game_not_found",
          "Jogo não encontrado neste torneio.",
        );
      }
      const tournament = await super8.update(tournamentId, club.id, { games });
      await auditLog.record({
        actorId: user.id,
        action: "super8.game_result",
        resourceType: "super8",
        resourceId: tournamentId,
        before: null,
        after: { gameId, score },
        requestId: request.requestId,
      });
      sendData(response, 200, { tournament: super8View(tournament) });
      return true;
    }

    // TASKS-12 / TASK-48 — tabela final (vitórias + saldo de games).
    const super8FinalizeRoute = pathname.match(
      /^\/api\/v1\/club\/super8\/([^/]+)\/finalize$/,
    );
    if (super8FinalizeRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "club");
      const club = await clubs.ensureForUser(user);
      const tournamentId = decodeURIComponent(super8FinalizeRoute[1]);
      const current = super8.requireOwned(tournamentId, club.id);
      const games = current.games ?? [];
      const pendingGames = games.filter(
        (game) => game.status !== "finalizado",
      ).length;
      if (!games.length || pendingGames > 0) {
        throw new ApiError(
          409,
          "super8_games_pending",
          pendingGames > 0
            ? `Ainda faltam ${pendingGames} ${pendingGames === 1 ? "jogo" : "jogos"} com resultado a lançar.`
            : "Gere a tabela do torneio antes de finalizar.",
        );
      }
      if (current.status === "finalizado") {
        throw new ApiError(
          409,
          "super8_already_finished",
          "Este torneio já foi finalizado.",
        );
      }
      const standings = computeSuper8Standings({
        mode: current.mode,
        games,
      });
      const tournament = await super8.update(tournamentId, club.id, {
        standings,
        status: "finalizado",
      });
      const participantIds = current.players
        .map((player) => player.id)
        .filter(Boolean);
      const byPlayer = await achievementsEngine.verifyPlayers(participantIds);
      const winnerIds = (standings[0]?.key ?? "")
        .split("|")
        .filter((playerId) => users.findById(playerId)?.role === "player");
      const achievementsUnlocked = [
        ...Object.values(byPlayer).flat(),
        ...(await achievementsEngine.awardChampionTitle({
          competition: tournament,
          competitionType: "super8",
          winnerIds,
        })),
      ];
      await auditLog.record({
        actorId: user.id,
        action: "super8.finalized",
        resourceType: "super8",
        resourceId: tournamentId,
        before: null,
        after: { positions: standings.slice(0, 3) },
        requestId: request.requestId,
      });
      sendData(response, 200, {
        tournament: super8View(tournament),
        achievementsUnlocked,
      });
      return true;
    }

    // TASKS-12 / TASK-47 — jogador se inscreve num torneio com vagas.
    const super8JoinRoute = pathname.match(
      /^\/api\/v1\/players\/super8\/([^/]+)\/join$/,
    );
    if (super8JoinRoute && request.method === "POST") {
      assertSameOrigin(request);
      const user = requireUser(request, "player");
      const tournamentId = decodeURIComponent(super8JoinRoute[1]);
      const current = super8.findById(tournamentId);
      if (!current || current.status !== "inscricoes_abertas") {
        throw new ApiError(
          404,
          "super8_not_open",
          "Este torneio não está com inscrições abertas.",
        );
      }
      if (current.players.some((player) => player.id === user.id)) {
        throw new ApiError(
          409,
          "super8_already_joined",
          "Você já está inscrito neste torneio.",
        );
      }
      if (current.players.length >= current.size) {
        throw new ApiError(
          409,
          "super8_full",
          "As vagas deste torneio já foram preenchidas.",
        );
      }
      // TASK-77 — inscrição espontânea também respeita as categorias
      // permitidas do torneio.
      if (current.levelCategories) {
        const category = playerLevelCategory(user);
        if (!category || !current.levelCategories.includes(category)) {
          throw new ApiError(
            403,
            "super8_category_restricted",
            `Este Super 8 é restrito às categorias ${levelCategoriesLabel(current.levelCategories)}.`,
          );
        }
      }
      const players = [
        ...current.players,
        { id: user.id, name: displayName(user) },
      ];
      const changes = { players };
      // quadro completo → volta para configuração (o clube gera a tabela)
      if (players.length >= current.size) {
        changes.status = "em_configuracao";
      }
      const tournament = await super8.update(
        tournamentId,
        current.clubId,
        changes,
      );
      sendData(response, 200, {
        tournament: {
          id: tournament.id,
          name: tournament.name,
          players: tournament.players.length,
          size: tournament.size,
          status: tournament.status,
        },
      });
      return true;
    }

    // TASKS-12 / TASK-47 / TASK-76 / TASK-77 — torneios com inscrições
    // abertas (qualquer clube), já com os dados completos para a tela de
    // detalhe e filtrados pela categoria de nível do próprio jogador.
    if (
      pathname === "/api/v1/players/super8/open" &&
      request.method === "GET"
    ) {
      const user = requireUser(request, "player");
      const myCategory = playerLevelCategory(user);
      const tournaments = super8.tournaments
        .filter(
          (tournament) =>
            tournament.status === "inscricoes_abertas" &&
            tournament.players.length < tournament.size &&
            // TASK-77 — esconde torneios fora da categoria do jogador.
            (!tournament.levelCategories ||
              (myCategory && tournament.levelCategories.includes(myCategory))),
        )
        .map((tournament) => {
          const club = clubs.findById(tournament.clubId);
          return {
            id: tournament.id,
            name: tournament.name,
            size: tournament.size,
            mode: tournament.mode,
            startTime: tournament.startTime ?? null,
            levelCategories: tournament.levelCategories ?? null,
            clubName: club?.name ?? "Clube",
            clubAddress: club?.address ?? "",
            players: tournament.players.map(playerWithProfile),
            courts: (tournament.courtIds ?? [])
              .map((courtId) => courts.findById(courtId))
              .filter(Boolean)
              .map((court) => ({ id: court.id, name: court.name })),
            enrolled: tournament.players.length,
            spotsLeft: tournament.size - tournament.players.length,
            alreadyJoined: tournament.players.some(
              (player) => player.id === user.id,
            ),
          };
        });
      sendData(response, 200, { tournaments });
      return true;
    }

    // TASK-38 — busca de jogadores cadastrados (autocomplete do clube).
    if (pathname === "/api/v1/players/search" && request.method === "GET") {
      requireUser(request); // clube ou jogador autenticado
      const query = String(url.searchParams.get("q") ?? "")
        .trim()
        .toLowerCase();
      if (query.length < 2) {
        sendData(response, 200, { players: [] });
        return true;
      }
      const players = users
        .listByRole("player")
        .map((player) => ({
          id: player.id,
          displayName: displayName(player),
          level: Number.isFinite(Number(player.profile?.level))
            ? Number(player.profile.level)
            : null,
          city: player.profile?.city ?? "",
        }))
        .filter((player) => player.displayName.toLowerCase().includes(query))
        .slice(0, 8);
      sendData(response, 200, { players });
      return true;
    }

    // TASK-42/TASK-47 — torneios publicados em que o jogador está inscrito.
    if (
      (pathname === "/api/v1/players/super8" ||
        pathname === "/api/v1/players/super8/mine") &&
      request.method === "GET"
    ) {
      const user = requireUser(request, "player");
      const tournaments = super8.listPublishedByPlayer(user.id).map((tournament) => {
        const club = clubs.findById(tournament.clubId);
        return {
          ...super8View(tournament),
          clubName: club?.name ?? "Clube",
          clubAddress: club?.address ?? "",
        };
      });
      sendData(response, 200, { tournaments });
      return true;
    }

    // TASK-14/TASK-31: ranking de nível agrupado pelas 7 categorias
    // oficiais, com posição calculada dentro de cada categoria (apenas
    // dados públicos, mesmo padrão do perfil público de jogador).
    if (pathname === "/api/v1/players/ranking" && request.method === "GET") {
      const user = requireUser(request, "player");
      const ranked = users
        .listByRole("player")
        .map((player) => {
          const profile = player.profile ?? {};
          const level = Number.isFinite(Number(profile.level))
            ? Number(profile.level)
            : null;
          return {
            id: player.id,
            displayName: displayName(player),
            photoUrl: profile.photoUrl ?? "",
            level,
            levelCategory: profile.levelCategory ?? "",
            city: profile.city ?? "",
          };
        })
        .filter((player) => player.level !== null)
        .sort(
          (a, b) =>
            b.level - a.level ||
            a.displayName.localeCompare(b.displayName, "pt-BR"),
        );
      const groups = LEVEL_BANDS.slice()
        .reverse()
        .map((band) => {
          const players = ranked
            .filter(
              (player) =>
                classificationFor(player.level)?.technical === band.technical,
            )
            .slice(0, 50)
            .map((player, index) => ({ ...player, rank: index + 1 }));
          return {
            technical: band.technical,
            category: band.category,
            label: `${band.technical} · ${band.category}`,
            min: band.min,
            max: band.max,
            players,
          };
        });
      let me = null;
      for (const group of groups) {
        const found = group.players.find((player) => player.id === user.id);
        if (found) {
          me = {
            ...found,
            technical: group.technical,
            category: group.category,
            groupTotal: group.players.length,
          };
          break;
        }
      }
      sendData(response, 200, {
        groups,
        total: ranked.length,
        me,
      });
      return true;
    }

    if (pathname.startsWith("/api/")) {
      throw new ApiError(404, "route_not_found", "Rota da API não encontrada.");
    }
    return false;
  }

  async function serveStatic(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError(405, "method_not_allowed", "Método não permitido.");
    }

    if (pathname === "/") pathname = "/index.html";

    if (pathname.startsWith("/uploads/")) {
      const match = pathname.match(
        /^\/uploads\/(players|clubs|courts)\/([a-f0-9-]{8,80})\.(jpg|png|webp)$/i,
      );
      if (!match) {
        throw new ApiError(404, "image_not_found", "Imagem não encontrada.");
      }
      const [, directory, resourceId, extension] = match;
      const filePath = path.join(
        config.dataDirectory,
        "uploads",
        directory,
        `${resourceId}.${extension.toLowerCase()}`,
      );
      let fileStats;
      try {
        fileStats = await stat(filePath);
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new ApiError(404, "image_not_found", "Imagem não encontrada.");
        }
        throw error;
      }
      if (!fileStats.isFile()) {
        throw new ApiError(404, "image_not_found", "Imagem não encontrada.");
      }
      const etag = `W/"${fileStats.size}-${Math.floor(fileStats.mtimeMs)}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { "Cache-Control": "no-cache", ETag: etag });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": MIME_TYPES.get(`.${extension.toLowerCase()}`),
        "Content-Length": fileStats.size,
        "Cache-Control": "no-cache",
        ETag: etag,
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(createReadStream(filePath), response);
      return;
    }

    const requiredRole = PROTECTED_PAGES.get(pathname);
    if (requiredRole) {
      const user = currentUser(request);
      if (!user) {
        response.writeHead(302, {
          Location: `/login.html?next=${encodeURIComponent(pathname.slice(1))}`,
          "Cache-Control": "no-store",
        });
        response.end();
        return;
      }
      if (user.role !== requiredRole) {
        response.writeHead(302, {
          Location: dashboardPath(user.role),
          "Cache-Control": "no-store",
        });
        response.end();
        return;
      }
    }

    if (pathname === "/login.html") {
      const user = currentUser(request);
      if (user) {
        response.writeHead(302, {
          Location: dashboardPath(user.role),
          "Cache-Control": "no-store",
        });
        response.end();
        return;
      }
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname).replaceAll("\\", "/");
    } catch {
      throw new ApiError(400, "invalid_path", "Caminho inválido.");
    }

    const filePath = path.resolve(config.frontendDirectory, `.${decodedPath}`);
    const relativePath = path.relative(config.frontendDirectory, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new ApiError(403, "path_forbidden", "Caminho não permitido.");
    }

    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ApiError(404, "page_not_found", "Página não encontrada.");
      }
      throw error;
    }
    if (!fileStats.isFile()) {
      throw new ApiError(404, "page_not_found", "Página não encontrada.");
    }

    const extension = path.extname(filePath).toLowerCase();
    const isHtml = extension === ".html";
    const etag = `W/\"${fileStats.size}-${Math.floor(fileStats.mtimeMs)}\"`;
    const cacheControl = isHtml ? "no-store" : "no-cache";
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, {
        "Cache-Control": cacheControl,
        ETag: etag,
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES.get(extension) ?? "application/octet-stream",
      "Content-Length": fileStats.size,
      "Cache-Control": cacheControl,
      ETag: etag,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    await pipeline(createReadStream(filePath), response);
  }

  async function handler(request, response) {
    const requestId = getRequestId(request);
    request.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);
    for (const [name, value] of Object.entries(securityHeaders(config))) {
      response.setHeader(name, value);
    }

    try {
      const url = new URL(
        request.url,
        `http://${request.headers.host ?? "localhost"}`,
      );
      const handled = await handleApi(request, response, url);
      if (!handled) await serveStatic(request, response, url.pathname);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof ApiError)) {
        console.error(`[${requestId}]`, error);
      }
      if (error.retryAfter) response.setHeader("Retry-After", error.retryAfter);
      sendError(response, error, requestId);
    }
  }

  return {
    handler,
    config,
    users,
    sessions,
    clubs,
    courts,
    bookings,
    levelTests,
    matchMessages,
    recurringBookings,
    auditLog,
    supabaseEnabled,
  };
}
