import { ApiError } from "./http.js";
import { normalizeEmail } from "./security.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COURT_TYPES = new Set(["covered", "outdoor"]);
const PAYMENT_METHODS = new Set(["pix", "card", "venue"]);
const VISIBILITIES = new Set(["private", "open"]);
const HALF_HOUR_TIME_PATTERN = /^([01]\d|2[0-3]):(?:00|30)$/;
const MAX_BOOKING_HORIZON_MS = 90 * 24 * 60 * 60 * 1_000;
// TASK-26 — questionário determinístico: 6 perguntas, cada resposta vale
// de 1 a 4 pontos (pontuação total 6–24).
export const LEVEL_TEST_QUESTIONS = [
  "tempo_pratica",
  "frequencia_semanal",
  "experiencia_esportes_raquete",
  "autoavaliacao_golpes",
  "experiencia_competicoes",
  "tatica_posicionamento",
];


function text(value, field, { min = 2, max = 120 } = {}) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(
      422,
      "validation_failed",
      `Verifique o campo ${field}.`,
      { field },
    );
  }
  return normalized;
}

function email(value) {
  const normalized = normalizeEmail(value);
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new ApiError(422, "validation_failed", "Informe um e-mail válido.", {
      field: "email",
    });
  }
  return normalized;
}

function password(value) {
  const normalized = String(value ?? "");
  if (normalized.length < 8 || normalized.length > 128) {
    throw new ApiError(
      422,
      "validation_failed",
      "A senha deve ter entre 8 e 128 caracteres.",
      { field: "password" },
    );
  }
  return normalized;
}

function number(value, field, { min, max }) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < min || normalized > max) {
    throw new ApiError(
      422,
      "validation_failed",
      `Verifique o campo ${field}.`,
      {
        field,
      },
    );
  }
  return normalized;
}

function identifier(value, field) {
  return text(value, field, { min: 8, max: 80 });
}

// TASK-21 — valores aceitos nos novos campos de perfil. Mantém os valores
// antigos ("direito"/"esquerdo"/...) por compatibilidade com perfis já salvos.
const PREFERRED_SIDES = new Set([
  "drive",
  "reves",
  "direito",
  "esquerdo",
  "indiferente",
]);
const PLAY_STYLES = new Set(["competitivo", "social", "misto"]);
// TASKS-11 — gênero do jogador. Decisão documentada: além de "female" e
// "male" existe "unspecified" ("prefiro não informar"); quem estiver como
// unspecified (ou sem o campo) NÃO pode entrar em partidas com restrição de
// gênero até definir female/male no perfil.
const PLAYER_GENDERS = new Set(["female", "male", "unspecified"]);
export const GENDER_CATEGORIES = new Set([
  "all",
  "women_only",
  "men_only",
  "mixed",
]);
const PREFERRED_TIME_BLOCKS = new Set(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].flatMap((day) =>
    ["morning", "afternoon", "evening"].map((period) => `${day}_${period}`),
  ),
);

function optionalChoice(value, field, allowed) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === "") return "";
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new ApiError(422, "validation_failed", `Verifique o campo ${field}.`, {
      field,
    });
  }
  return normalized;
}

function optionalPreferredTimes(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > PREFERRED_TIME_BLOCKS.size) {
    throw new ApiError(
      422,
      "validation_failed",
      "Informe uma lista válida de horários de preferência.",
      { field: "preferredTimes" },
    );
  }
  const normalized = [...new Set(value.map((item) => String(item).trim()))];
  for (const block of normalized) {
    if (!PREFERRED_TIME_BLOCKS.has(block)) {
      throw new ApiError(
        422,
        "validation_failed",
        "Informe blocos de horário válidos (ex.: mon_evening).",
        { field: "preferredTimes" },
      );
    }
  }
  return normalized;
}

// TASKS-09 — validação da criação do Super 8 (TASK-38).
export function validateSuper8(body) {
  const name = text(body?.name, "name", { min: 3, max: 80 });
  const size = Number(body?.size);
  if (![8, 12, 16].includes(size)) {
    throw new ApiError(
      422,
      "validation_failed",
      "Escolha entre Super 8, Super 12 ou Super 16.",
      { field: "size" },
    );
  }
  const mode = String(body?.mode ?? "").trim();
  if (!["duplas_fixas", "rotacao"].includes(mode)) {
    throw new ApiError(
      422,
      "validation_failed",
      "Escolha a modalidade: duplas fixas ou cada um por si.",
      { field: "mode" },
    );
  }
  const rawPlayers = body?.players;
  // TASKS-12: na rotação individual o clube pode criar com menos jogadores e
  // completar via inscrições abertas; em duplas fixas o quadro completo (e as
  // duplas) precisam existir já na criação.
  const requireFull = mode === "duplas_fixas";
  if (
    !Array.isArray(rawPlayers) ||
    rawPlayers.length > size ||
    (requireFull ? rawPlayers.length !== size : rawPlayers.length < 1)
  ) {
    throw new ApiError(
      422,
      "validation_failed",
      requireFull
        ? `Informe exatamente ${size} jogadores.`
        : `Informe de 1 a ${size} jogadores (as vagas restantes podem ser abertas para inscrição).`,
      { field: "players" },
    );
  }
  const players = rawPlayers.map((player, index) => ({
    // id nulo = jogador convidado (sem conta na plataforma)
    id: player?.id ? String(player.id).trim() : null,
    name: text(player?.name, `players[${index}].name`, { min: 2, max: 80 }),
  }));
  const linkedIds = players
    .filter((player) => player.id)
    .map((player) => player.id);
  if (new Set(linkedIds).size !== linkedIds.length) {
    throw new ApiError(
      422,
      "validation_failed",
      "Um mesmo jogador cadastrado não pode aparecer duas vezes.",
      { field: "players" },
    );
  }
  let pairs = null;
  if (mode === "duplas_fixas") {
    const rawPairs = body?.pairs;
    if (!Array.isArray(rawPairs) || rawPairs.length !== size / 2) {
      throw new ApiError(
        422,
        "validation_failed",
        `Organize os jogadores em ${size / 2} duplas.`,
        { field: "pairs" },
      );
    }
    const used = new Set();
    pairs = rawPairs.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new ApiError(
          422,
          "validation_failed",
          "Cada dupla deve ter exatamente 2 jogadores.",
          { field: "pairs" },
        );
      }
      return pair.map((value) => {
        const index = Number(value);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= size ||
          used.has(index)
        ) {
          throw new ApiError(
            422,
            "validation_failed",
            "As duplas devem cobrir todos os jogadores, sem repetição.",
            { field: "pairs" },
          );
        }
        used.add(index);
        return index;
      });
    });
  }
  return { name, size, mode, players, pairs };
}

// TASK-39 — quadras do torneio (TASK-43: sem horário).
export function validateSuper8Courts(body) {
  const courtIds = body?.courtIds;
  if (
    !Array.isArray(courtIds) ||
    !courtIds.length ||
    courtIds.some((id) => !String(id ?? "").trim())
  ) {
    throw new ApiError(
      422,
      "validation_failed",
      "Selecione ao menos uma quadra para o torneio.",
      { field: "courtIds" },
    );
  }
  return { courtIds: [...new Set(courtIds.map((id) => String(id).trim()))] };
}

// TASKS-12 / TASK-44 — placar de um jogo do Super 8.
// Decisão documentada (a validar com produto): formato de "games corridos"
// em um único placar por dupla (padrão de torneios Americano/Super 8
// informais), em vez dos 3 sets dos jogos abertos — a TASK-48 só precisa do
// total de games de cada dupla, que este formato fornece diretamente.
export function validateSuper8GameResult(body) {
  const team1Games = Number(body?.team1Games);
  const team2Games = Number(body?.team2Games);
  const valid = (value) =>
    Number.isInteger(value) && value >= 0 && value <= 99;
  if (!valid(team1Games) || !valid(team2Games) || team1Games === team2Games) {
    throw new ApiError(
      422,
      "validation_failed",
      "Informe o total de games de cada dupla (números inteiros, sem empate).",
      { field: "score" },
    );
  }
  return { team1Games, team2Games };
}

// TASK-17/17B — placar de partida: sempre exatamente 3 sets, games inteiros
// de 0 a 7, sem empate dentro do set.
export function validateMatchResult(body) {
  const sets = body?.sets;
  if (!Array.isArray(sets) || sets.length !== 3) {
    throw new ApiError(
      422,
      "validation_failed",
      "Informe o placar de exatamente 3 sets.",
      { field: "sets" },
    );
  }
  const normalizedSets = sets.map((set, index) => {
    const team1 = Number(set?.team1);
    const team2 = Number(set?.team2);
    const valid = (value) =>
      Number.isInteger(value) && value >= 0 && value <= 7;
    if (!valid(team1) || !valid(team2) || team1 === team2) {
      throw new ApiError(
        422,
        "validation_failed",
        `Verifique o placar do set ${index + 1} (games de 0 a 7, sem empate).`,
        { field: "sets", set: index + 1 },
      );
    }
    return { team1, team2 };
  });
  const team1Sets = normalizedSets.filter((set) => set.team1 > set.team2)
    .length;
  const winningTeam = team1Sets >= 2 ? "team1" : "team2";
  if (
    body.winningTeam !== undefined &&
    body.winningTeam !== winningTeam
  ) {
    throw new ApiError(
      422,
      "validation_failed",
      "A dupla vencedora informada não corresponde ao placar dos sets.",
      { field: "winningTeam" },
    );
  }
  return { sets: normalizedSets, winningTeam };
}

function optionalText(value, field, options = {}) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === "") return "";
  return text(value, field, options);
}

function optionalImageUrl(value, field, uploadDirectory) {
  const url = optionalText(value, field, { min: 8, max: 2_048 });
  if (url === undefined || url === "") return url;
  const uploadedImage = new RegExp(
    `^/uploads/${uploadDirectory}/[a-f0-9-]+\\.(?:jpe?g|png|webp)$`,
    "i",
  );
  if (
    !/^https:\/\//i.test(url) &&
    !/^\/assets\//i.test(url) &&
    !uploadedImage.test(url)
  ) {
    throw new ApiError(
      422,
      "validation_failed",
      "A foto deve usar uma imagem enviada pela plataforma ou uma URL HTTPS válida.",
      { field },
    );
  }
  return url;
}

function questionScore(value, field) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 4) {
    throw new ApiError(
      422,
      "validation_failed",
      `Verifique o campo ${field} (resposta de 1 a 4).`,
      { field },
    );
  }
  return numeric;
}

function level(value, field) {
  const normalized = number(value, field, { min: 0.5, max: 7 });
  if (Math.abs(normalized * 100 - Math.round(normalized * 100)) > 1e-9) {
    throw new ApiError(
      422,
      "validation_failed",
      "O limite de nível deve usar no máximo duas casas decimais.",
      { field },
    );
  }
  return Math.round(normalized * 100) / 100;
}

export function validateLogin(body) {
  return {
    email: email(body.email),
    password: password(body.password),
  };
}

export function validateRegistration(body) {
  const role = body.role;
  if (role !== "player" && role !== "club") {
    throw new ApiError(
      422,
      "validation_failed",
      "Escolha um tipo de conta válido.",
      { field: "role" },
    );
  }

  const credentials = {
    role,
    email: email(body.email),
    password: password(body.password),
  };

  if (role === "player") {
    return {
      ...credentials,
      profile: {
        firstName: text(body.firstName, "firstName", { max: 60 }),
        lastName: text(body.lastName, "lastName", { max: 80 }),
        city: text(body.city, "city", { max: 100 }),
        level: "Iniciante",
        levelAssessmentCompleted: false,
      },
    };
  }

  return {
    ...credentials,
    profile: {
      responsibleName: text(body.responsibleName, "responsibleName", {
        max: 120,
      }),
      arenaName: text(body.arenaName, "arenaName", { max: 120 }),
      cnpj: text(body.cnpj, "cnpj", { min: 14, max: 24 }),
    },
  };
}

export function validateClubProfile(body) {
  return {
    name: text(body.name, "name", { min: 2, max: 120 }),
    description:
      optionalText(body.description, "description", { min: 2, max: 800 }) ?? "",
    phone: optionalText(body.phone, "phone", { min: 7, max: 40 }) ?? "",
    address: text(body.address, "address", { min: 5, max: 240 }),
    photoUrl: optionalImageUrl(body.photoUrl, "photoUrl", "clubs") ?? "",
  };
}

export function validateCourt(body) {
  const type = String(body.type ?? "");
  if (!COURT_TYPES.has(type)) {
    throw new ApiError(
      422,
      "validation_failed",
      "Selecione um tipo de quadra válido.",
      { field: "type" },
    );
  }

  const openTime = String(body.openTime ?? body.opensAt ?? "");
  const closeTime = String(body.closeTime ?? body.closesAt ?? "");
  if (
    !HALF_HOUR_TIME_PATTERN.test(openTime) ||
    !HALF_HOUR_TIME_PATTERN.test(closeTime) ||
    openTime >= closeTime
  ) {
    throw new ApiError(
      422,
      "validation_failed",
      "Informe um horário de funcionamento válido.",
      { field: "openTime" },
    );
  }

  const slotDuration = Number(
    body.slotDuration ?? body.slotDurationMinutes ?? 90,
  );
  if (![60, 90].includes(slotDuration)) {
    throw new ApiError(
      422,
      "validation_failed",
      "A duração da reserva deve ser de 60 ou 90 minutos.",
      { field: "slotDuration" },
    );
  }

  return {
    name: text(body.name, "name", { max: 100 }),
    price: number(body.price, "price", { min: 1, max: 10_000 }),
    type,
    openTime,
    closeTime,
    slotDuration,
    photoUrl: optionalImageUrl(body.photoUrl, "photoUrl", "courts") ?? "",
  };
}

export function validateBooking(body) {
  const paymentMethod = String(body.paymentMethod ?? "").toLowerCase();
  const visibility = String(body.visibility ?? "private").toLowerCase();
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    throw new ApiError(
      422,
      "validation_failed",
      "Selecione uma forma de pagamento válida.",
      { field: "paymentMethod" },
    );
  }
  if (!VISIBILITIES.has(visibility)) {
    throw new ApiError(
      422,
      "validation_failed",
      "Selecione uma visibilidade válida.",
      { field: "visibility" },
    );
  }

  const startAt = new Date(body.startAt);
  if (
    Number.isNaN(startAt.getTime()) ||
    startAt.getTime() < Date.now() - 5 * 60 * 1000
  ) {
    throw new ApiError(
      422,
      "validation_failed",
      "Selecione uma data e um horário futuros.",
      { field: "startAt" },
    );
  }
  if (startAt.getTime() > Date.now() + MAX_BOOKING_HORIZON_MS) {
    throw new ApiError(
      422,
      "booking_horizon_exceeded",
      "As reservas podem ser feitas com até 90 dias de antecedência.",
      { field: "startAt", maximumDays: 90 },
    );
  }

  let levelMin = null;
  let levelMax = null;
  let levelRange = null;
  if (visibility === "open") {
    levelMin = level(body.levelMin, "levelMin");
    levelMax = level(body.levelMax, "levelMax");
    if (levelMin > levelMax) {
      throw new ApiError(
        422,
        "validation_failed",
        "O nível mínimo não pode superar o máximo.",
        { field: "levelMin" },
      );
    }
    levelRange = `${levelMin.toFixed(2)} – ${levelMax.toFixed(2)}`;
  }
  // TASK-49 — categoria de gênero da partida aberta.
  let genderCategory = "all";
  if (body.genderCategory !== undefined && body.genderCategory !== null) {
    const normalized = String(body.genderCategory).trim();
    if (!GENDER_CATEGORIES.has(normalized)) {
      throw new ApiError(
        422,
        "validation_failed",
        "Escolha uma categoria de gênero válida.",
        { field: "genderCategory" },
      );
    }
    genderCategory = normalized;
  }

  return {
    clubId: identifier(body.clubId, "clubId"),
    courtId: identifier(body.courtId, "courtId"),
    startAt: startAt.toISOString(),
    genderCategory,
    paymentMethod,
    visibility,
    levelRange,
    levelMin,
    levelMax,
    maxPlayers: visibility === "open" ? 4 : 1,
  };
}

export function validatePlayerProfile(body) {
  const update = {
    firstName:
      body.firstName === undefined
        ? undefined
        : text(body.firstName, "firstName", { max: 60 }),
    lastName:
      body.lastName === undefined
        ? undefined
        : text(body.lastName, "lastName", { max: 80 }),
    city:
      body.city === undefined
        ? undefined
        : text(body.city, "city", { max: 100 }),
    preferredSide: optionalChoice(
      body.preferredSide,
      "preferredSide",
      PREFERRED_SIDES,
    ),
    dominantHand: optionalText(body.dominantHand, "dominantHand", {
      min: 2,
      max: 40,
    }),
    availability: optionalText(body.availability, "availability", {
      min: 2,
      max: 160,
    }),
    playStyle: optionalChoice(body.playStyle, "playStyle", PLAY_STYLES),
    gender: optionalChoice(body.gender, "gender", PLAYER_GENDERS),
    preferredTimes: optionalPreferredTimes(body.preferredTimes),
    photoUrl: optionalImageUrl(body.photoUrl, "photoUrl", "players"),
  };
  const filtered = Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined),
  );
  if (!Object.keys(filtered).length) {
    throw new ApiError(
      422,
      "validation_failed",
      "Informe ao menos um dado para atualizar.",
    );
  }
  return filtered;
}

export function validateLevelTest(body) {
  return Object.fromEntries(
    LEVEL_TEST_QUESTIONS.map((question) => [
      question,
      questionScore(body?.[question], question),
    ]),
  );
}

export function validateMatchMessage(body) {
  return {
    content: text(body.content, "content", { min: 1, max: 1_000 }),
  };
}

export function validateBookingUpdate(body) {
  if (body.status === "cancelled") return { status: "cancelled" };
  const visibility = String(body.visibility ?? "").toLowerCase();
  if (!VISIBILITIES.has(visibility)) {
    throw new ApiError(
      422,
      "validation_failed",
      "Selecione uma visibilidade válida.",
      { field: "visibility" },
    );
  }
  if (visibility === "private") {
    return {
      visibility,
      levelMin: null,
      levelMax: null,
      levelRange: null,
      maxPlayers: 1,
    };
  }
  const levelMin = level(body.levelMin, "levelMin");
  const levelMax = level(body.levelMax, "levelMax");
  if (levelMin > levelMax) {
    throw new ApiError(
      422,
      "validation_failed",
      "O nível mínimo não pode superar o máximo.",
      { field: "levelMin" },
    );
  }
  return {
    visibility,
    levelMin,
    levelMax,
    levelRange: `${levelMin.toFixed(2)} – ${levelMax.toFixed(2)}`,
    maxPlayers: 4,
  };
}

export function validateRecurringBooking(body) {
  const startTime = String(body.startTime ?? "");
  if (!HALF_HOUR_TIME_PATTERN.test(startTime)) {
    throw new ApiError(
      422,
      "validation_failed",
      "Informe um horário válido em intervalos de 30 minutos.",
      { field: "startTime" },
    );
  }
  const recurrence = body.recurrence ?? {};
  if (recurrence.frequency === "weekly") {
    const dayOfWeek = Number(recurrence.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw new ApiError(
        422,
        "validation_failed",
        "Informe um dia da semana válido.",
        { field: "recurrence.dayOfWeek" },
      );
    }
    return {
      clientName: text(body.clientName, "clientName", { max: 100 }),
      startTime,
      recurrence: { frequency: "weekly", dayOfWeek },
    };
  }
  if (recurrence.frequency === "monthly") {
    const dayOfMonth = Number(recurrence.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new ApiError(
        422,
        "validation_failed",
        "Informe um dia do mês válido.",
        { field: "recurrence.dayOfMonth" },
      );
    }
    return {
      clientName: text(body.clientName, "clientName", { max: 100 }),
      startTime,
      recurrence: { frequency: "monthly", dayOfMonth },
    };
  }
  throw new ApiError(
    422,
    "validation_failed",
    "Informe uma recorrência válida.",
    { field: "recurrence.frequency" },
  );
}

export function validateRecurringBookingUpdate(body) {
  return {
    courtId: text(body.courtId, "courtId", { max: 200 }),
    ...validateRecurringBooking(body),
  };
}
