import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../lib/http.js";
import { createId } from "../lib/security.js";

// TASKS-09/TASKS-12 — Torneios Super 8 do clube.
// Status: "em_configuracao" → (opcional "inscricoes_abertas", quando o clube
// abre vagas para jogadores se inscreverem sozinhos) → "gerado" →
// "em_andamento" → "finalizado".
export class Super8Store {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "super8.json");
    this.tournaments = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      // TASK-95 — torneios criados antes do campo de data ficam sem data
      // definida (o clube pode preencher depois pela edição).
      this.tournaments = parsed.map((tournament) => ({
        date: null,
        genderCategory: "all",
        ...tournament,
      }));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  findById(id) {
    return this.tournaments.find((entry) => entry.id === id) ?? null;
  }

  listByClub(clubId) {
    return this.tournaments
      .filter((entry) => entry.clubId === clubId)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }

  listAll() {
    return this.tournaments;
  }

  // Torneios publicados (visíveis ao jogador) em que o jogador está inscrito.
  listPublishedByPlayer(playerId) {
    return this.tournaments
      .filter(
        (entry) =>
          ["em_andamento", "finalizado"].includes(entry.status) &&
          entry.players.some((player) => player.id === playerId),
      )
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }

  requireOwned(id, clubId) {
    const tournament = this.findById(id);
    if (!tournament || tournament.clubId !== clubId) {
      throw new ApiError(
        404,
        "super8_not_found",
        "Torneio Super 8 não encontrado.",
      );
    }
    return tournament;
  }

  async create({
    clubId,
    name,
    size,
    mode,
    players,
    pairs,
    date,
    startTime,
    levelCategories,
    genderCategory,
  }) {
    return this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      const tournament = {
        id: createId(),
        clubId,
        name,
        size,
        mode,
        players,
        pairs: pairs ?? null,
        // TASK-95: data do evento ("YYYY-MM-DD") ou null (a definir depois)
        date: date ?? null,
        // TASK-59: horário de início do evento (convocação), "HH:MM" ou null
        startTime: startTime ?? null,
        // TASK-77: categorias de nível permitidas ou null = todas
        levelCategories: levelCategories ?? null,
        genderCategory: genderCategory ?? "all",
        courtIds: [],
        // TASK-43: jogos são apenas confrontos, sem horário.
        games: [],
        // TASK-48: tabela final (vitórias + saldo de games), após finalizar.
        standings: null,
        status: "em_configuracao",
        createdAt: now,
        updatedAt: now,
      };
      this.tournaments.push(tournament);
      await this.persist();
      return tournament;
    });
  }

  async update(id, clubId, changes) {
    return this.enqueueWrite(async () => {
      const tournament = this.requireOwned(id, clubId);
      Object.assign(tournament, changes, {
        updatedAt: new Date().toISOString(),
      });
      await this.persist();
      return tournament;
    });
  }

  async persist() {
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.tournaments, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  enqueueWrite(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}
