import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../lib/http.js";
import { createId, normalizeEmail } from "../lib/security.js";

export class UserStore {
  constructor(dataDirectory, authenticationRepository = null) {
    this.dataDirectory = dataDirectory;
    this.authenticationRepository = authenticationRepository;
    this.filePath = path.join(dataDirectory, "users.json");
    this.users = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (this.authenticationRepository) {
      this.users = await this.authenticationRepository.loadUsers();
      return;
    }
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const file = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(file);
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      this.users = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  findByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    return this.users.find((user) => user.email === normalizedEmail) ?? null;
  }

  findById(id) {
    return this.users.find((user) => user.id === id) ?? null;
  }

  listByRole(role) {
    return this.users.filter((user) => user.role === role);
  }

  async create({ role, email, passwordHash, profile }) {
    return this.enqueueWrite(async () => {
      const normalizedEmail = normalizeEmail(email);
      if (this.findByEmail(normalizedEmail)) {
        throw new ApiError(
          409,
          "email_already_registered",
          "Já existe uma conta cadastrada com este e-mail.",
          { field: "email" },
        );
      }

      const now = new Date().toISOString();
      const user = {
        id: createId(),
        role,
        email: normalizedEmail,
        passwordHash,
        profile,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const persisted = this.authenticationRepository
          ? await this.authenticationRepository.createUser(user)
          : user;
        this.users.push(persisted);
        if (!this.authenticationRepository) await this.persist();
        return persisted;
      } catch (error) {
        if (error?.code === "23505") {
          throw new ApiError(
            409,
            "email_already_registered",
            "JÃ¡ existe uma conta cadastrada com este e-mail.",
            { field: "email" },
          );
        }
        throw error;
      }
    });
  }

  async updateProfile(userId, update) {
    return this.enqueueWrite(async () => {
      const user = this.findById(userId);
      if (!user) {
        throw new ApiError(404, "user_not_found", "Usuário não encontrado.");
      }
      const profile = { ...(user.profile ?? {}), ...update };
      const updatedAt = new Date().toISOString();
      const persisted = this.authenticationRepository
        ? await this.authenticationRepository.updateUserProfile(
            userId,
            profile,
            updatedAt,
          )
        : { ...user, profile, updatedAt };
      Object.assign(user, persisted);
      if (!this.authenticationRepository) await this.persist();
      return user;
    });
  }

  async updatePassword(userId, passwordHash) {
    return this.enqueueWrite(async () => {
      const user = this.findById(userId);
      if (!user) {
        throw new ApiError(404, "user_not_found", "Usuário não encontrado.");
      }
      const updatedAt = new Date().toISOString();
      const persisted = this.authenticationRepository
        ? await this.authenticationRepository.updateUserPassword(
            userId,
            passwordHash,
            updatedAt,
          )
        : { ...user, passwordHash, updatedAt };
      Object.assign(user, persisted);
      if (!this.authenticationRepository) await this.persist();
      return user;
    });
  }

  async persist() {
    await writeFile(this.filePath, `${JSON.stringify(this.users, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  enqueueWrite(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}

export function toPublicUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    profile: user.profile,
    createdAt: user.createdAt,
  };
}
