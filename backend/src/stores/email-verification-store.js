import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Armazena tokens de confirmação de e-mail (apenas o hash SHA-256 do token).
 * Segue o mesmo padrão do password-reset-store: persistido em JSON no volume
 * de dados, cada novo pedido invalida os anteriores do mesmo usuário e os
 * tokens têm vida curta.
 */
export class EmailVerificationStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "email-verifications.json");
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
