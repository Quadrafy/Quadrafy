import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../lib/http.js";
import { createId } from "../lib/security.js";

function recurrencesOverlap(left, right) {
  if (left.frequency !== right.frequency) return true;
  if (left.frequency === "weekly") {
    return left.dayOfWeek === right.dayOfWeek;
  }
  return left.dayOfMonth === right.dayOfMonth;
}

export class RecurringBookingStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "recurring-bookings.json");
    this.recurringBookings = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.recurringBookings = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  findById(id) {
    return (
      this.recurringBookings.find(
        (recurring) => recurring.id === id && !recurring.deletedAt,
      ) ?? null
    );
  }

  listByClub(clubId) {
    return this.recurringBookings.filter(
      (recurring) => recurring.clubId === clubId && !recurring.deletedAt,
    );
  }

  listByCourt(courtId) {
    return this.recurringBookings.filter(
      (recurring) => recurring.courtId === courtId && !recurring.deletedAt,
    );
  }

  async create({ clubId, courtId, clientName, startTime, recurrence }) {
    return this.enqueueWrite(async () => {
      const duplicate = this.recurringBookings.some(
        (entry) =>
          entry.courtId === courtId &&
          !entry.deletedAt &&
          entry.startTime === startTime &&
          recurrencesOverlap(entry.recurrence, recurrence),
      );
      if (duplicate) {
        throw new ApiError(
          409,
          "recurring_booking_conflict",
          "Já existe uma reserva fixa com essa recorrência.",
        );
      }

      const now = new Date().toISOString();
      const recurringBooking = {
        id: createId(),
        clubId,
        courtId,
        clientName,
        startTime,
        recurrence,
        createdAt: now,
        updatedAt: now,
      };
      this.recurringBookings.push(recurringBooking);
      await this.persist();
      return recurringBooking;
    });
  }

  async update(id, { courtId, clientName, startTime, recurrence }) {
    return this.enqueueWrite(async () => {
      const recurring = this.findById(id);
      if (!recurring) {
        throw new ApiError(
          404,
          "recurring_booking_not_found",
          "Reserva fixa não encontrada.",
        );
      }
      const duplicate = this.recurringBookings.some(
        (entry) =>
          entry.id !== id &&
          entry.courtId === courtId &&
          !entry.deletedAt &&
          entry.startTime === startTime &&
          recurrencesOverlap(entry.recurrence, recurrence),
      );
      if (duplicate) {
        throw new ApiError(
          409,
          "recurring_booking_conflict",
          "Já existe uma reserva fixa com essa recorrência.",
        );
      }

      recurring.courtId = courtId;
      recurring.clientName = clientName;
      recurring.startTime = startTime;
      recurring.recurrence = recurrence;
      const timestamp = Date.now();
      const previousTimestamp = Date.parse(recurring.updatedAt);
      recurring.updatedAt = new Date(
        Math.max(timestamp, previousTimestamp + 1),
      ).toISOString();
      await this.persist();
      return recurring;
    });
  }

  async delete(id, actorId) {
    return this.enqueueWrite(async () => {
      const recurring = this.findById(id);
      if (!recurring) {
        throw new ApiError(
          404,
          "recurring_booking_not_found",
          "Reserva fixa não encontrada.",
        );
      }
      recurring.deletedAt = new Date().toISOString();
      recurring.deletedBy = actorId ?? null;
      recurring.updatedAt = recurring.deletedAt;
      await this.persist();
      return recurring;
    });
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${createId()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(this.recurringBookings, null, 2)}\n`,
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
