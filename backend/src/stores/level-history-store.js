import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../lib/security.js";

// TASK-19 — Série histórica de nível de cada jogador.
export class LevelHistoryStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "level-history.json");
    this.entries = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.entries = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  listByPlayer(playerId) {
    return this.entries
      .filter((entry) => entry.playerId === playerId)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
  }

  async record({
    playerId,
    level,
    levelCategory,
    levelConfidence = null,
    source,
    matchId = null,
  }) {
    return this.enqueueWrite(async () => {
      const entry = {
        id: createId(),
        playerId,
        level,
        levelCategory: levelCategory ?? null,
        // TASK-30: fiabilidade (%) registrada junto de cada mudança de nível.
        levelConfidence,
        source,
        matchId,
        createdAt: new Date().toISOString(),
      };
      this.entries.push(entry);
      await this.persist();
      return entry;
    });
  }

  async recordMany(records) {
    return this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      const created = records.map((record) => ({
        id: createId(),
        playerId: record.playerId,
        level: record.level,
        levelCategory: record.levelCategory ?? null,
        levelConfidence: record.levelConfidence ?? null,
        source: record.source,
        matchId: record.matchId ?? null,
        createdAt: now,
      }));
      this.entries.push(...created);
      await this.persist();
      return created;
    });
  }

  async persist() {
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.entries, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  enqueueWrite(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}
