import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../lib/security.js";

export class MatchMessageStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "match-messages.json");
    this.messages = [];
    this.maxMessagesPerMatch = 1_000;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.messages = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  listByMatch(matchId, { after, limit = 50 } = {}) {
    let result = this.messages.filter((message) => message.matchId === matchId);
    if (after) {
      const cursorIndex = result.findIndex((message) => message.id === after);
      result =
        cursorIndex >= 0
          ? result.slice(cursorIndex + 1)
          : result.filter((message) => message.createdAt > after);
    }
    return result.slice(0, limit);
  }

  async create({ matchId, playerId, content }) {
    return this.enqueueWrite(async () => {
      const message = {
        id: createId(),
        matchId,
        playerId,
        content,
        createdAt: new Date().toISOString(),
      };
      this.messages.push(message);
      while (
        this.messages.filter((entry) => entry.matchId === matchId).length >
        this.maxMessagesPerMatch
      ) {
        const oldestIndex = this.messages.findIndex(
          (entry) => entry.matchId === matchId,
        );
        if (oldestIndex < 0) break;
        this.messages.splice(oldestIndex, 1);
      }
      await this.persist();
      return message;
    });
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${createId()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(this.messages, null, 2)}\n`,
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
