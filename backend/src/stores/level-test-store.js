import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../lib/security.js";

export class LevelTestStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "level-tests.json");
    this.tests = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.tests = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  listByPlayer(playerId) {
    return this.tests.filter((entry) => entry.playerId === playerId);
  }

  async create({ playerId, answers, result, provider, rawResponse, error }) {
    return this.enqueueWrite(async () => {
      const entry = {
        id: createId(),
        playerId,
        answers,
        result,
        provider,
        rawResponse: rawResponse ?? null,
        error: error ?? null,
        createdAt: new Date().toISOString(),
      };
      this.tests.push(entry);
      await this.persist();
      return entry;
    });
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${createId()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(this.tests, null, 2)}\n`,
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
