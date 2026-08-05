import { createSessionToken, digestToken } from "../lib/security.js";

export class SessionStore {
  constructor(ttlMs, authenticationRepository = null) {
    this.ttlMs = ttlMs;
    this.authenticationRepository = authenticationRepository;
    this.sessions = new Map();
  }

  async initialize() {
    if (!this.authenticationRepository) return;
    const sessions = await this.authenticationRepository.loadActiveSessions(
      new Date(),
    );
    for (const session of sessions) {
      this.sessions.set(session.tokenHash, {
        userId: session.userId,
        expiresAt: session.expiresAt,
      });
    }
  }

  async create(userId) {
    this.removeExpired();
    const token = createSessionToken();
    const tokenHash = digestToken(token);
    const session = {
      userId,
      expiresAt: Date.now() + this.ttlMs,
    };
    if (this.authenticationRepository) {
      await this.authenticationRepository.removeExpiredSessions(new Date());
      await this.authenticationRepository.createSession({ tokenHash, ...session });
    }
    this.sessions.set(tokenHash, session);
    return token;
  }

  get(token) {
    if (!token) return null;
    const key = digestToken(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  async revoke(token) {
    if (!token) return;
    const tokenHash = digestToken(token);
    if (this.authenticationRepository) {
      await this.authenticationRepository.revokeSession(tokenHash);
    }
    this.sessions.delete(tokenHash);
  }

  // Revoga TODAS as sessões de um usuário (troca/reset de senha, vínculo de
  // conta) — expulsa qualquer sessão anterior, inclusive de um atacante.
  async revokeAllForUser(userId) {
    for (const [key, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(key);
    }
    if (this.authenticationRepository?.revokeSessionsForUser) {
      await this.authenticationRepository.revokeSessionsForUser(userId);
    }
  }

  removeExpired() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }
}
