import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Armazena tokens de redefinição de senha (apenas o hash SHA-256 do token,
 * nunca o token em claro). Persistido em JSON no volume de dados, seguindo o
 * mesmo padrão dos demais stores operacionais. Tokens são de vida curta e
 * cada novo pedido invalida os anteriores do mesmo usuário.
 */
export class PasswordResetStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "password-resets.json");
    this.entries = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      this.entries = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  async create({ userId, email, tokenHash, expiresAt }) {
    return this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      // invalida qualquer token anterior do mesmo usuário: só o último link vale
      this.entries = this.entries.filter((entry) => entry.userId !== userId);
      this.entries.push({
        tokenHash,
        userId,
        email,
        expiresAt,
        createdAt: now,
        usedAt: null,
      });
      await this.persist();
    });
  }

  findByTokenHash(tokenHash) {
    return this.entries.find((entry) => entry.tokenHash === tokenHash) ?? null;
  }

  async consume(tokenHash) {
    return this.enqueueWrite(async () => {
      const entry = this.entries.find((item) => item.tokenHash === tokenHash);
      if (entry) entry.usedAt = new Date().toISOString();
      await this.persist();
    });
  }

  async purgeExpired(now = Date.now()) {
    return this.enqueueWrite(async () => {
      const before = this.entries.length;
      this.entries = this.entries.filter(
        (entry) => !entry.usedAt && Date.parse(entry.expiresAt) > now,
      );
      if (this.entries.length !== before) await this.persist();
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
