import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Códigos OTP de verificação de telefone (apenas o hash SHA-256 do código).
 * Persistido em JSON no volume de dados. Cada novo pedido substitui o anterior
 * do mesmo usuário; guarda tentativas para limitar brute force do código.
 */
export class PhoneVerificationStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "phone-verifications.json");
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

  async create({ userId, phone, codeHash, expiresAt }) {
    return this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      this.entries = this.entries.filter((entry) => entry.userId !== userId);
      this.entries.push({
        userId,
        phone,
        codeHash,
        expiresAt,
        createdAt: now,
        usedAt: null,
        attempts: 0,
      });
      await this.persist();
    });
  }

  findByUser(userId) {
    return this.entries.find((entry) => entry.userId === userId) ?? null;
  }

  async registerAttempt(userId) {
    return this.enqueueWrite(async () => {
      const entry = this.entries.find((item) => item.userId === userId);
      if (entry) entry.attempts = (entry.attempts ?? 0) + 1;
      await this.persist();
    });
  }

  async consume(userId) {
    return this.enqueueWrite(async () => {
      const entry = this.entries.find((item) => item.userId === userId);
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
