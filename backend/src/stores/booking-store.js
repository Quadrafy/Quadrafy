import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../lib/http.js";
import { createId } from "../lib/security.js";

const TEAM_KEYS = ["team1", "team2"];

function participantIdsFromTeams(teams) {
  return TEAM_KEYS.flatMap((team) => teams?.[team] ?? []).filter(Boolean);
}

function teamsFromParticipants(participantIds = []) {
  const unique = [...new Set(participantIds.filter(Boolean))].slice(0, 4);
  return {
    team1: [unique[0] ?? null, unique[1] ?? null],
    team2: [unique[2] ?? null, unique[3] ?? null],
  };
}

function validPersistedTeams(teams, participantIds) {
  if (
    !teams ||
    !TEAM_KEYS.every(
      (team) =>
        Array.isArray(teams[team]) &&
        teams[team].length === 2 &&
        teams[team].every(
          (playerId) => playerId === null || typeof playerId === "string",
        ),
    )
  ) {
    return false;
  }
  const positioned = participantIdsFromTeams(teams);
  const expected = [...new Set(participantIds.filter(Boolean))];
  return (
    positioned.length === new Set(positioned).size &&
    positioned.length === expected.length &&
    expected.every((playerId) => positioned.includes(playerId))
  );
}

function ensureTeams(booking) {
  const participantIds = [
    ...new Set([booking.playerId, ...(booking.participantIds ?? [])].filter(Boolean)),
  ].slice(0, 4);
  if (!validPersistedTeams(booking.teams, participantIds)) {
    booking.teams = teamsFromParticipants(participantIds);
  } else {
    booking.teams = {
      team1: [...booking.teams.team1],
      team2: [...booking.teams.team2],
    };
  }
  booking.participantIds = participantIdsFromTeams(booking.teams);
}

function syncOpenSpots(booking) {
  booking.openSpots =
    booking.visibility === "open"
      ? Math.max(0, booking.maxPlayers - (booking.participantIds?.length ?? 0))
      : 0;
}

export class BookingStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "bookings.json");
    this.bookings = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      let migrated = false;
      this.bookings = parsed.map((booking) => {
        if (booking.visibility !== "open") return booking;
        const previousTeams = JSON.stringify(booking.teams);
        ensureTeams(booking);
        syncOpenSpots(booking);
        if (JSON.stringify(booking.teams) !== previousTeams) migrated = true;
        return booking;
      });
      if (migrated) await this.persist();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  findById(id) {
    return this.bookings.find((booking) => booking.id === id) ?? null;
  }

  listByPlayer(playerId) {
    return this.bookings.filter(
      (booking) =>
        booking.playerId === playerId ||
        booking.participantIds?.includes(playerId),
    );
  }

  listByClub(clubId) {
    return this.bookings.filter((booking) => booking.clubId === clubId);
  }

  listOpen() {
    return this.bookings.filter(
      (booking) =>
        booking.visibility === "open" && booking.status === "confirmed",
    );
  }

  listFutureConfirmedByCourt(courtId, now = Date.now()) {
    return this.bookings.filter(
      (booking) =>
        booking.courtId === courtId &&
        booking.status === "confirmed" &&
        new Date(booking.startAt).getTime() > now,
    );
  }

  async cancelFutureByCourt(courtId, cancelledBy, now = Date.now()) {
    return this.enqueueWrite(async () => {
      const affected = this.listFutureConfirmedByCourt(courtId, now);
      const cancelledAt = new Date().toISOString();
      affected.forEach((booking) => {
        booking.status = "cancelled";
        booking.cancelledAt = cancelledAt;
        booking.cancelledBy = cancelledBy;
        booking.updatedAt = cancelledAt;
        if (booking.paymentStatus === "paid") {
          booking.refundStatus = "pending";
        }
      });
      if (affected.length) await this.persist();
      return affected;
    });
  }

  async create({
    playerId,
    clubId,
    courtId,
    startAt,
    price,
    paymentMethod,
    visibility = "private",
    levelRange = null,
    levelMin = null,
    levelMax = null,
    maxPlayers,
    genderCategory = "all",
    participantIds = [],
    status = "confirmed",
  }) {
    return this.enqueueWrite(async () => {
      if (
        status === "confirmed" &&
        this.bookings.some(
          (booking) =>
            booking.courtId === courtId &&
            booking.startAt === startAt &&
            booking.status === "confirmed",
        )
      ) {
        throw new ApiError(
          409,
          "booking_conflict",
          "Este horário já foi reservado.",
          { courtId, startAt },
        );
      }

      const now = new Date().toISOString();
      const resolvedMaxPlayers = maxPlayers ?? (visibility === "open" ? 4 : 1);
      const resolvedParticipantIds = [
        ...new Set([playerId, ...participantIds]),
      ].slice(0, resolvedMaxPlayers);
      const teams =
        visibility === "open"
          ? teamsFromParticipants(resolvedParticipantIds)
          : null;
      const booking = {
        id: createId(),
        playerId,
        clubId,
        courtId,
        startAt,
        price,
        paymentMethod,
        // TASK-49: "all" | "women_only" | "men_only" | "mixed"
        genderCategory: visibility === "open" ? genderCategory : "all",
        paymentStatus: "pending",
        visibility,
        levelRange,
        levelMin,
        levelMax,
        maxPlayers: resolvedMaxPlayers,
        participantIds:
          visibility === "open"
            ? participantIdsFromTeams(teams)
            : resolvedParticipantIds,
        teams,
        status,
        createdAt: now,
        updatedAt: now,
      };
      syncOpenSpots(booking);
      this.bookings.push(booking);
      await this.persist();
      return booking;
    });
  }

  async join(bookingId, playerId, position = null) {
    return this.enqueueWrite(async () => {
      const booking = this.findById(bookingId);
      if (!booking) {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      if (booking.visibility !== "open") {
        throw new ApiError(
          409,
          "match_not_open",
          "Esta reserva não é um jogo aberto.",
        );
      }
      if (booking.status !== "confirmed") {
        throw new ApiError(
          409,
          "match_unavailable",
          "Este jogo não está disponível.",
        );
      }
      if (new Date(booking.startAt).getTime() <= Date.now()) {
        throw new ApiError(
          409,
          "match_started",
          "Esta partida já começou e não aceita novos jogadores.",
        );
      }

      ensureTeams(booking);
      const participantIds = booking.participantIds ?? [];
      if (participantIds.includes(playerId)) {
        throw new ApiError(
          409,
          "already_joined",
          "Você já participa deste jogo.",
        );
      }
      if (participantIds.length >= booking.maxPlayers) {
        throw new ApiError(
          409,
          "match_full",
          "Este jogo não possui mais vagas.",
        );
      }

      let target = position;
      if (target === null || target === undefined) {
        target = TEAM_KEYS.flatMap((team) =>
          booking.teams[team].map((value, slot) => ({ team, slot, value })),
        ).find(({ value }) => value === null);
      }
      if (
        !target ||
        !TEAM_KEYS.includes(target.team) ||
        !Number.isInteger(Number(target.slot)) ||
        Number(target.slot) < 0 ||
        Number(target.slot) > 1
      ) {
        throw new ApiError(
          422,
          "invalid_match_position",
          "Escolha uma vaga válida em uma das duplas.",
        );
      }
      const slot = Number(target.slot);
      if (booking.teams[target.team][slot] !== null) {
        throw new ApiError(
          409,
          "match_position_taken",
          "Esta vaga acabou de ser preenchida. Escolha outra posição.",
          { team: target.team, slot },
        );
      }
      booking.teams[target.team][slot] = playerId;
      booking.participantIds = participantIdsFromTeams(booking.teams);
      syncOpenSpots(booking);
      booking.updatedAt = new Date().toISOString();
      await this.persist();
      return booking;
    });
  }

  async leave(bookingId, playerId) {
    return this.enqueueWrite(async () => {
      const booking = this.findById(bookingId);
      if (!booking) {
        throw new ApiError(404, "match_not_found", "Jogo n\u00e3o encontrado.");
      }
      if (booking.visibility !== "open") {
        throw new ApiError(
          409,
          "match_not_open",
          "Esta reserva n\u00e3o \u00e9 um jogo aberto.",
        );
      }

      const participantIds = booking.participantIds ?? [];
      if (!participantIds.includes(playerId)) {
        throw new ApiError(
          409,
          "not_joined",
          "Voc\u00ea n\u00e3o participa deste jogo.",
        );
      }

      ensureTeams(booking);
      TEAM_KEYS.forEach((team) => {
        booking.teams[team] = booking.teams[team].map((positionedPlayerId) =>
          positionedPlayerId === playerId ? null : positionedPlayerId,
        );
      });
      booking.participantIds = participantIdsFromTeams(booking.teams);
      syncOpenSpots(booking);
      booking.updatedAt = new Date().toISOString();
      await this.persist();
      return booking;
    });
  }

  // TASK-32: o organizador remove outro jogador da partida, liberando a
  // vaga (mesmo efeito de quando o jogador sai por conta própria).
  async removePlayer(bookingId, organizerId, playerId) {
    return this.enqueueWrite(async () => {
      const booking = this.findById(bookingId);
      if (!booking || booking.visibility !== "open") {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      if (booking.playerId !== organizerId) {
        throw new ApiError(
          403,
          "match_forbidden",
          "Apenas o organizador pode remover jogadores desta partida.",
        );
      }
      if (playerId === organizerId) {
        throw new ApiError(
          409,
          "cannot_remove_self",
          "Para sair do jogo, cancele a reserva pela tela de reservas.",
        );
      }
      const participantIds = booking.participantIds ?? [];
      if (!participantIds.includes(playerId)) {
        throw new ApiError(
          409,
          "not_joined",
          "Este jogador não participa da partida.",
        );
      }
      ensureTeams(booking);
      TEAM_KEYS.forEach((team) => {
        booking.teams[team] = booking.teams[team].map((positionedPlayerId) =>
          positionedPlayerId === playerId ? null : positionedPlayerId,
        );
      });
      booking.participantIds = participantIdsFromTeams(booking.teams);
      syncOpenSpots(booking);
      booking.updatedAt = new Date().toISOString();
      await this.persist();
      return booking;
    });
  }

  // TASK-12: um participante pode mover apenas a própria posição para uma
  // vaga vazia (diferente do organizador, que reorganiza qualquer jogador
  // via reorganizeTeams).
  async moveSelf(bookingId, playerId, targetTeam, targetSlot) {
    return this.enqueueWrite(async () => {
      const booking = this.findById(bookingId);
      if (!booking || booking.visibility !== "open") {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      const participantIds = booking.participantIds ?? [];
      if (!participantIds.includes(playerId)) {
        throw new ApiError(
          403,
          "not_joined",
          "Você não participa deste jogo.",
        );
      }
      if (!TEAM_KEYS.includes(targetTeam)) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe uma dupla válida.",
          { field: "team" },
        );
      }
      const slot = Number(targetSlot);
      if (!Number.isInteger(slot) || slot < 0 || slot > 1) {
        throw new ApiError(
          422,
          "validation_failed",
          "Informe uma posição válida.",
          { field: "slot" },
        );
      }
      ensureTeams(booking);
      if (booking.teams[targetTeam][slot] === playerId) return booking;
      if (booking.teams[targetTeam][slot] !== null) {
        throw new ApiError(
          409,
          "match_position_taken",
          "Esta vaga acabou de ser preenchida. Escolha outra posição.",
          { team: targetTeam, slot },
        );
      }
      TEAM_KEYS.forEach((team) => {
        booking.teams[team] = booking.teams[team].map((positionedPlayerId) =>
          positionedPlayerId === playerId ? null : positionedPlayerId,
        );
      });
      booking.teams[targetTeam][slot] = playerId;
      booking.participantIds = participantIdsFromTeams(booking.teams);
      syncOpenSpots(booking);
      booking.updatedAt = new Date().toISOString();
      await this.persist();
      return booking;
    });
  }

  async reorganizeTeams(bookingId, organizerId, teams) {
    return this.enqueueWrite(async () => {
      const booking = this.findById(bookingId);
      if (!booking || booking.visibility !== "open") {
        throw new ApiError(404, "match_not_found", "Jogo não encontrado.");
      }
      if (booking.playerId !== organizerId) {
        throw new ApiError(
          403,
          "match_organizer_required",
          "Apenas o organizador pode reorganizar as duplas.",
        );
      }
      const validShape =
        teams &&
        TEAM_KEYS.every(
          (team) =>
            Array.isArray(teams[team]) &&
            teams[team].length === 2 &&
            teams[team].every(
              (playerId) =>
                playerId === null ||
                (typeof playerId === "string" && playerId.length > 0),
            ),
        );
      ensureTeams(booking);
      const positioned = validShape ? participantIdsFromTeams(teams) : [];
      const existing = booking.participantIds;
      const sameParticipants =
        validShape &&
        positioned.length === new Set(positioned).size &&
        positioned.length === existing.length &&
        existing.every((playerId) => positioned.includes(playerId));
      if (!sameParticipants) {
        throw new ApiError(
          422,
          "invalid_match_teams",
          "A reorganização deve manter todos os participantes nas quatro vagas.",
        );
      }
      booking.teams = {
        team1: [...teams.team1],
        team2: [...teams.team2],
      };
      booking.participantIds = participantIdsFromTeams(booking.teams);
      syncOpenSpots(booking);
      booking.updatedAt = new Date().toISOString();
      await this.persist();
      return booking;
    });
  }

  async setPaymentStatus(bookingId, paymentStatus) {
    return this.enqueueWrite(async () => {
      const booking = this.findById(bookingId);
      if (!booking) {
        throw new ApiError(404, "booking_not_found", "Reserva não encontrada.");
      }

      booking.paymentStatus = paymentStatus;
      booking.updatedAt = new Date().toISOString();
      await this.persist();
      return booking;
    });
  }

  async updateByOwner(bookingId, playerId, update) {
    return this.enqueueWrite(async () => {
      const booking = this.findById(bookingId);
      if (!booking || booking.playerId !== playerId) {
        throw new ApiError(404, "booking_not_found", "Reserva não encontrada.");
      }

      if (update.status === "cancelled") {
        booking.status = "cancelled";
        booking.cancelledAt = new Date().toISOString();
        if (booking.paymentStatus === "paid") {
          booking.refundStatus = "pending";
        }
      } else {
        if (booking.status !== "confirmed") {
          throw new ApiError(
            409,
            "booking_unavailable",
            "Esta reserva não pode mais ser alterada.",
          );
        }
        if (
          update.visibility === "private" &&
          (booking.participantIds?.length ?? 0) > 1
        ) {
          throw new ApiError(
            409,
            "booking_has_participants",
            "Remova os outros participantes antes de tornar o jogo privado.",
          );
        }
        booking.visibility = update.visibility;
        booking.levelRange = update.levelRange;
        booking.levelMin = update.levelMin;
        booking.levelMax = update.levelMax;
        booking.maxPlayers = update.maxPlayers;
        if (booking.visibility === "open") ensureTeams(booking);
        else booking.teams = null;
        syncOpenSpots(booking);
      }

      booking.updatedAt = new Date().toISOString();
      await this.persist();
      return booking;
    });
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${createId()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(this.bookings, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  enqueueWrite(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}
