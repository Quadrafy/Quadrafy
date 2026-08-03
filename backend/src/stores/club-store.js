import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../lib/security.js";

export class ClubStore {
  constructor(dataDirectory, { autoApprove = false } = {}) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "clubs.json");
    this.clubs = [];
    this.autoApprove = autoApprove;
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
        // Novo clube nasce pendente: só aparece pros jogadores após um admin
        // aprovar (a lista pública já filtra por status === "active"). Em
        // ambientes com autoApprove (testes) já entra ativo.
        status: this.autoApprove ? "active" : "pending",
        createdAt: now,
        updatedAt: now,
      };
      this.clubs.push(club);
      await this.persist();
      return club;
    });
  }

  listByStatus(status) {
    return this.clubs.filter((club) => club.status === status);
  }

  async setStatus(clubId, status, { reason } = {}) {
    return this.enqueueWrite(async () => {
      const club = this.clubs.find((item) => item.id === clubId);
      if (!club) return null;
      club.status = status;
      club.updatedAt = new Date().toISOString();
      if (status === "rejected") club.rejectionReason = reason ?? "";
      await this.persist();
      return club;
    });
  }

  // TASKS-13 / TASK-51 — múltiplas arenas por clube.
  // Decisão documentada (a validar com produto): o botão "Adicionar arena"
  // permite ao MESMO clube gerenciar várias unidades. Implementação
  // incremental: a arena principal continua sendo o próprio registro do
  // clube (compatibilidade total com clubes existentes); arenas adicionais
  // vivem em `club.arenas` e as quadras ganham um `arenaId` opcional
  // (ausente = arena principal). Grade e financeiro seguem por clube nesta
  // fase.
  async addArena(ownerId, { name, address }) {
    return this.enqueueWrite(async () => {
      const club = this.findByOwnerId(ownerId);
      if (!club) return null;
      if (!Array.isArray(club.arenas)) club.arenas = [];
      const arena = {
        id: createId(),
        name,
        address,
        createdAt: new Date().toISOString(),
      };
      club.arenas.push(arena);
      club.updatedAt = arena.createdAt;
      await this.persist();
      return arena;
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
