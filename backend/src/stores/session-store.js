import { createSessionToken, digestToken } from "../lib/security.js";

export class SessionStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  create(userId) {
    this.removeExpired();
    const token = createSessionToken();
    this.sessions.set(digestToken(token), {
      userId,
      expiresAt: Date.now() + this.ttlMs,
    });
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

  revoke(token) {
    if (token) this.sessions.delete(digestToken(token));
  }

  removeExpired() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }
}
