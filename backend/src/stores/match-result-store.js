import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../lib/http.js";
import { createId } from "../lib/security.js";

const TEAM_KEYS = ["team1", "team2"];

// TASK-17 — Resultados de partida com confirmação cruzada.
// Um resultado nasce "pending" (lançado por um participante) e só vira
// "confirmed" quando um jogador do time adversário confirma.
export class MatchResultStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "match-results.json");
    this.results = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.results = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  findByMatch(matchId) {
    return this.results.find((entry) => entry.matchId === matchId) ?? null;
  }

  listConfirmed() {
    return this.results.filter((entry) => entry.status === "confirmed");
  }

  listConfirmedByPlayer(playerId) {
    return this.listConfirmed()
      .filter((entry) =>
        TEAM_KEYS.some((team) => entry.teams[team].includes(playerId)),
      )
      .sort(
        (a, b) =>
          new Date(a.confirmedAt).getTime() - new Date(b.confirmedAt).getTime(),
      );
  }

  playerTeam(entry, playerId) {
    return (
      TEAM_KEYS.find((team) => entry.teams[team].includes(playerId)) ?? null
    );
  }

  async create({
    matchId,
    teams,
    playerLevels,
    playerReliabilities = {},
    sets,
    winningTeam,
    reportedBy,
  }) {
    return this.enqueueWrite(async () => {
      const existing = this.findByMatch(matchId);
      if (existing?.status === "confirmed") {
        throw new ApiError(
          409,
          "result_already_confirmed",
          "O resultado desta partida já foi confirmado.",
        );
      }
      if (existing) {
        // Um resultado pendente pode ser substituído por um novo lançamento
        // (ex.: correção de placar antes da confirmação).
        this.results = this.results.filter(
          (entry) => entry.id !== existing.id,
        );
      }
      const entry = {
        id: createId(),
        matchId,
        teams: {
          team1: [...teams.team1],
          team2: [...teams.team2],
        },
        // Níveis dos 4 jogadores no momento do lançamento, para que a
        // expectativa (TASK-18) seja calculada de forma determinística.
        playerLevels: { ...playerLevels },
        // Fiabilidades (%) no momento do lançamento — usadas pelo motor
        // (TASK-28) e pelo explicador passo a passo (TASK-29).
        playerReliabilities: { ...playerReliabilities },
        sets: sets.map((set) => ({
          team1: set.team1,
          team2: set.team2,
        })),
        winningTeam,
        reportedBy,
        status: "pending",
        confirmedBy: null,
        confirmedAt: null,
        createdAt: new Date().toISOString(),
      };
      this.results.push(entry);
      await this.persist();
      return entry;
    });
  }

  // TASK-29/36: memoriza o passo a passo do cálculo e o ΔNível de cada
  // jogador aplicados na confirmação (consultáveis depois pelos 4 jogadores).
  async attachOutcome(matchId, { breakdown, levelChanges }) {
    return this.enqueueWrite(async () => {
      const entry = this.findByMatch(matchId);
      if (!entry) return null;
      entry.breakdown = breakdown;
      entry.levelChanges = levelChanges;
      await this.persist();
      return entry;
    });
  }

  async confirm(matchId, playerId) {
    return this.enqueueWrite(async () => {
      const entry = this.findByMatch(matchId);
      if (!entry) {
        throw new ApiError(
          404,
          "result_not_found",
          "Nenhum resultado foi lançado para esta partida.",
        );
      }
      if (entry.status === "confirmed") {
        throw new ApiError(
          409,
          "result_already_confirmed",
          "O resultado desta partida já foi confirmado.",
        );
      }
      const confirmerTeam = this.playerTeam(entry, playerId);
      if (!confirmerTeam) {
        throw new ApiError(
          403,
          "result_confirm_forbidden",
          "Apenas participantes da partida podem confirmar o resultado.",
        );
      }
      const reporterTeam = this.playerTeam(entry, entry.reportedBy);
      if (confirmerTeam === reporterTeam) {
        throw new ApiError(
          409,
          "result_confirm_same_team",
          "A confirmação deve vir de um jogador da dupla adversária.",
        );
      }
      entry.status = "confirmed";
      entry.confirmedBy = playerId;
      entry.confirmedAt = new Date().toISOString();
      await this.persist();
      return entry;
    });
  }

  async persist() {
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.results, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  enqueueWrite(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}
