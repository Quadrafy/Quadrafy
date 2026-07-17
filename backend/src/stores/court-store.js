import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../lib/http.js";
import { createId } from "../lib/security.js";

export class CourtStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "courts.json");
    this.courts = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.courts = parsed.map((court) => {
        const openTime = court.openTime ?? court.opensAt;
        const closeTime = court.closeTime ?? court.closesAt;
        const slotDuration =
          court.slotDuration ?? court.slotDurationMinutes ?? 90;
        return {
          ...court,
          openTime,
          closeTime,
          slotDuration,
          opensAt: openTime,
          closesAt: closeTime,
          slotDurationMinutes: slotDuration,
        };
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  findById(id) {
    return this.courts.find((court) => court.id === id) ?? null;
  }

  listByClub(clubId) {
    return this.courts.filter((court) => court.clubId === clubId);
  }

  listActiveByClub(clubId) {
    return this.courts.filter(
      (court) => court.clubId === clubId && court.active === true,
    );
  }

  async create({
    clubId,
    name,
    price,
    type,
    active = true,
    openTime,
    closeTime,
    slotDuration,
    photoUrl = "",
  }) {
    return this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      const court = {
        id: createId(),
        clubId,
        name,
        price,
        type,
        active,
        openTime,
        closeTime,
        slotDuration,
        photoUrl,
        opensAt: openTime,
        closesAt: closeTime,
        slotDurationMinutes: slotDuration,
        createdAt: now,
        updatedAt: now,
      };
      this.courts.push(court);
      await this.persist();
      return court;
    });
  }

  async setActive(courtId, active) {
    return this.enqueueWrite(async () => {
      const court = this.findById(courtId);
      if (!court) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      court.active = Boolean(active);
      court.updatedAt = new Date().toISOString();
      await this.persist();
      return court;
    });
  }

  async update(courtId, update) {
    return this.enqueueWrite(async () => {
      const court = this.findById(courtId);
      if (!court) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      Object.assign(court, update, {
        opensAt: update.openTime,
        closesAt: update.closeTime,
        slotDurationMinutes: update.slotDuration,
        updatedAt: new Date().toISOString(),
      });
      await this.persist();
      return court;
    });
  }

  async delete(courtId) {
    return this.enqueueWrite(async () => {
      const index = this.courts.findIndex((court) => court.id === courtId);
      if (index === -1) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      const [deleted] = this.courts.splice(index, 1);
      await this.persist();
      return deleted;
    });
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${createId()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(this.courts, null, 2)}\n`,
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
