import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../lib/security.js";

export class ClubStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "clubs.json");
    this.clubs = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.clubs = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  list() {
    return this.clubs;
  }

  findById(id) {
    return this.clubs.find((club) => club.id === id) ?? null;
  }

  findByOwnerId(ownerId) {
    return this.clubs.find((club) => club.ownerId === ownerId) ?? null;
  }

  listByOwner(ownerId) {
    return this.clubs.filter((club) => club.ownerId === ownerId);
  }

  async ensureForUser(user) {
    return this.enqueueWrite(async () => {
      const existing = this.findByOwnerId(user.id);
      if (existing) return existing;

      const now = new Date().toISOString();
      const club = {
        id: createId(),
        ownerId: user.id,
        name: user.profile?.arenaName ?? "",
        responsibleName: user.profile?.responsibleName ?? "",
        cnpj: user.profile?.cnpj ?? "",
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      this.clubs.push(club);
      await this.persist();
      return club;
    });
  }

  async updateProfile(ownerId, update) {
    return this.enqueueWrite(async () => {
      const club = this.findByOwnerId(ownerId);
      if (!club) return null;

      Object.assign(club, update);
      const previousUpdatedAt = new Date(club.updatedAt ?? 0).getTime();
      club.updatedAt = new Date(
        Math.max(Date.now(), previousUpdatedAt + 1),
      ).toISOString();
      await this.persist();
      return club;
    });
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${createId()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(this.clubs, null, 2)}\n`,
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
