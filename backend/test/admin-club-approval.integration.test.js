import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

let baseUrl;
let dataDirectory;
let server;
const mails = [];

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "padelfy-admin-test-"));
  const app = await createApp({
    environment: "test",
    dataDirectory,
    frontendDirectory,
    sessionTtlHours: 1,
    adminEmails: "boss@example.com",
    autoApproveClubs: false,
    mailer: {
      enabled: true,
      async sendClubApplication(p) {
        mails.push(["application", p]);
      },
      async sendClubApproved(p) {
        mails.push(["approved", p]);
      },
      async sendClubRejected(p) {
        mails.push(["rejected", p]);
      },
      async sendEmailVerification() {},
    },
  });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDirectory, { recursive: true, force: true });
});

async function api(pathname, { method = "GET", body, cookie } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: baseUrl } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const cookieOf = (r) => r.headers.get("set-cookie").split(";", 1)[0];

test("club is created pending, admin approves, and it becomes active", async () => {
  const clubReg = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "club",
      responsibleName: "Dona Arena",
      arenaName: "Arena Central",
      cnpj: "12.345.678/0001-90",
      email: "arena@example.com",
      password: "SenhaSegura123",
      phone: "11912345678",
    },
  });
  assert.equal(clubReg.status, 201);
  const clubCookie = cookieOf(clubReg);

  // Clube começa pendente e admins foram notificados.
  const dash = await api("/api/v1/club/dashboard", { cookie: clubCookie });
  assert.equal((await dash.json()).data.clubStatus, "pending");
  assert.ok(mails.some(([type]) => type === "application"));

  // Admin (e-mail na lista) enxerga isAdmin e a solicitação pendente.
  const adminReg = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Boss",
      lastName: "Admin",
      email: "boss@example.com",
      password: "SenhaSegura123",
      phone: "11912345678",
      level: "Iniciante",
      city: "São Paulo",
      gender: "male",
    },
  });
  const adminCookie = cookieOf(adminReg);
  const me = await api("/api/v1/auth/me", { cookie: adminCookie });
  assert.equal((await me.json()).data.isAdmin, true);

  const pending = await api("/api/v1/admin/clubs?status=pending", {
    cookie: adminCookie,
  });
  const pendingBody = await pending.json();
  assert.equal(pendingBody.data.clubs.length, 1);
  const clubId = pendingBody.data.clubs[0].id;
  assert.equal(pendingBody.data.clubs[0].ownerEmail, "arena@example.com");

  const approve = await api(`/api/v1/admin/clubs/${clubId}/approve`, {
    method: "POST",
    cookie: adminCookie,
    body: {},
  });
  assert.equal(approve.status, 200);
  assert.ok(mails.some(([type]) => type === "approved"));

  // Clube agora ativo.
  const dash2 = await api("/api/v1/club/dashboard", { cookie: clubCookie });
  assert.equal((await dash2.json()).data.clubStatus, "active");
});

test("non-admin cannot access admin endpoints", async () => {
  const reg = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      firstName: "Zé",
      lastName: "Comum",
      email: "ze@example.com",
      password: "SenhaSegura123",
      phone: "11912345678",
      level: "Iniciante",
      city: "Santos",
      gender: "male",
    },
  });
  const cookie = cookieOf(reg);
  const me = await api("/api/v1/auth/me", { cookie });
  assert.equal((await me.json()).data.isAdmin, false);
  const forbidden = await api("/api/v1/admin/clubs", { cookie });
  assert.equal(forbidden.status, 403);
});
