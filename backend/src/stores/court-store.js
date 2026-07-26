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
        const rawDuration = court.slotDuration ?? court.slotDurationMinutes ?? 90;
        const slotDurations = Array.isArray(court.slotDurations)
          ? court.slotDurations
          : [rawDuration];
        const slotDuration = Math.min(...slotDurations);
        const blockedSlots = [
          ...new Set(
            (Array.isArray(court.blockedSlots) ? court.blockedSlots : []).filter(
              (startAt) =>
                typeof startAt === "string" && !Number.isNaN(Date.parse(startAt)),
            ),
          ),
        ];
        const blockedWindows = Array.isArray(court.blockedWindows)
          ? court.blockedWindows
          : [];
        const durationWindows = Array.isArray(court.durationWindows)
          ? court.durationWindows
          : [];
        // TASK-99 — quadras não distinguem mais coberta/descoberta.
        const { type, ...rest } = court;
        return {
          ...rest,
          openTime,
          closeTime,
          slotDurations,
          slotDuration,
          opensAt: openTime,
          closesAt: closeTime,
          slotDurationMinutes: slotDuration,
          blockedSlots,
          blockedWindows,
          durationWindows,
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
    active = true,
    openTime,
    closeTime,
    slotDuration,
    slotDurations,
    durationWindows = [],
    photoUrl = "",
    arenaId = null,
    blockedWindows = [],
  }) {
    return this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      const resolvedDurations = Array.isArray(slotDurations)
        ? slotDurations
        : [slotDuration ?? 90];
      const minDuration = Math.min(...resolvedDurations);
      const court = {
        id: createId(),
        clubId,
        name,
        price,
        active,
        openTime,
        closeTime,
        slotDurations: resolvedDurations,
        slotDuration: minDuration,
        durationWindows: Array.isArray(durationWindows) ? durationWindows : [],
        photoUrl,
        blockedSlots: [],
        blockedWindows,
        // TASK-51: null = arena principal do clube
        arenaId: arenaId || null,
        opensAt: openTime,
        closesAt: closeTime,
        slotDurationMinutes: minDuration,
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
      const resolvedDurations = Array.isArray(update.slotDurations)
        ? update.slotDurations
        : update.slotDuration
          ? [update.slotDuration]
          : court.slotDurations;
      const minDuration = Math.min(...resolvedDurations);
      Object.assign(court, update, {
        slotDurations: resolvedDurations,
        slotDuration: minDuration,
        durationWindows: Array.isArray(update.durationWindows)
          ? update.durationWindows
          : court.durationWindows ?? [],
        opensAt: update.openTime,
        closesAt: update.closeTime,
        slotDurationMinutes: minDuration,
        updatedAt: new Date().toISOString(),
      });
      await this.persist();
      return court;
    });
  }

  async setBlockedWindows(courtId, windows) {
    return this.enqueueWrite(async () => {
      const court = this.findById(courtId);
      if (!court) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      court.blockedWindows = windows;
      court.updatedAt = new Date().toISOString();
      await this.persist();
      return court;
    });
  }

  async setSlotBlocked(courtId, startAt, blocked) {
    return this.enqueueWrite(async () => {
      const court = this.findById(courtId);
      if (!court) {
        throw new ApiError(404, "court_not_found", "Quadra não encontrada.");
      }
      const current = new Set(court.blockedSlots ?? []);
      if (blocked) current.add(startAt);
      else current.delete(startAt);
      court.blockedSlots = [...current].sort();
      court.updatedAt = new Date().toISOString();
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
