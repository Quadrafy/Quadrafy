import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");
const temporaryDirectories = [];

function clone(value) {
  return structuredClone(value);
}

class MemoryAuthenticationRepository {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
  }

  async loadUsers() {
    return [...this.users.values()].map(clone);
  }

  async createUser(user) {
    if ([...this.users.values()].some((stored) => stored.email === user.email)) {
      const error = new Error("duplicate e-mail");
      error.code = "23505";
      throw error;
    }
    this.users.set(user.id, clone(user));
    return clone(user);
  }

  async updateUserProfile(userId, profile, updatedAt) {
    const user = this.users.get(userId);
    const updated = { ...user, profile: clone(profile), updatedAt };
    this.users.set(userId, updated);
    return clone(updated);
  }

  async loadActiveSessions(now) {
    return [...this.sessions.values()]
      .filter((session) => session.expiresAt > now.getTime())
      .map(clone);
  }

  async createSession(session) {
    this.sessions.set(session.tokenHash, clone(session));
  }

  async revokeSession(tokenHash) {
    this.sessions.delete(tokenHash);
  }

  async removeExpiredSessions(now) {
    for (const [tokenHash, session] of this.sessions) {
      if (session.expiresAt <= now.getTime()) this.sessions.delete(tokenHash);
    }
  }
}

async function startApplication(repository) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "padelfy-supabase-auth-test-"),
  );
  temporaryDirectories.push(dataDirectory);
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    authenticationRepository: repository,
    sessionTtlHours: 1,
  });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { app, server, baseUrl: `http://127.0.0.1:${port}` };
}

async function closeApplication(application) {
  if (application.server.listening) {
    await new Promise((resolve) => application.server.close(resolve));
  }
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("registration and session survive an application restart through the database repository", async () => {
  const repository = new MemoryAuthenticationRepository();
  const first = await startApplication(repository);
  let cookie;

  try {
    const registration = await fetch(`${first.baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: first.baseUrl,
      },
      body: JSON.stringify({
        role: "player",
        gender: "male",
        firstName: "Ana",
        lastName: "Banco",
        email: "ana.banco@example.com",
        password: "SenhaMuitoSegura123",
        phone: "11912345678",
        level: "Intermediário",
        city: "São Paulo",
      }),
    });

    assert.equal(registration.status, 201);
    cookie = registration.headers.get("set-cookie").split(";", 1)[0];
    assert.equal(repository.users.size, 1);
    assert.equal(repository.sessions.size, 1);
    const storedUser = [...repository.users.values()][0];
    assert.equal(storedUser.email, "ana.banco@example.com");
    assert.doesNotMatch(storedUser.passwordHash, /SenhaMuitoSegura123/);
    assert.match(storedUser.passwordHash, /^scrypt\$/);
  } finally {
    await closeApplication(first);
  }

  const second = await startApplication(repository);
  try {
    const me = await fetch(`${second.baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).data.user.email, "ana.banco@example.com");

    const logout = await fetch(`${second.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: second.baseUrl },
    });
    assert.equal(logout.status, 204);
    assert.equal(repository.sessions.size, 0);
  } finally {
    await closeApplication(second);
  }
});
