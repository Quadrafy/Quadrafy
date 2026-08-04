import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

async function withTestServer(run) {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "padelfy-tasks07-test-"),
  );
  let server;
  try {
    const app = await createApp({
      environment: "test",
      dataDirectory,
      frontendDirectory,
      sessionTtlHours: 1,
      anthropicApiKey: "",
      // Rede indisponível de propósito: o teste inicial NÃO pode depender de
      // nenhuma chamada externa (TASK-26).
      fetchImplementation: () => {
        throw new Error("network must not be used by the level test");
      },
    });
    server = createServer(app.handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    async function api(
      pathname,
      { method = "GET", body, cookie, headers = {} } = {},
    ) {
      return fetch(`${baseUrl}${pathname}`, {
        method,
        redirect: "manual",
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== "GET" && method !== "HEAD" ? { Origin: baseUrl } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    }
    await run({ api });
  } finally {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "the authenticated response must set a session cookie");
  return header.split(";", 1)[0];
}

async function registerPlayer(api, suffix) {
  const response = await api("/api/v1/auth/register", {
    method: "POST",
    body: {
      role: "player",
      gender: "male",
      firstName: "Ana",
      lastName: `Silva ${suffix}`,
      email: `jogador-tasks07-${suffix}@example.com`,
      password: "SenhaSeguraJogador123",
      phone: "11912345678",
      city: "Sao Paulo",
    },
  });
  assert.equal(response.status, 201);
  return { cookie: cookieFrom(response), user: (await response.json()).data.user };
}

function answers(value) {
  return {
    // q1 vale 1-4; q2-q7 vao ate 5
    q1: Math.min(value, 4),
    q2: value,
    q3: value,
    q4: value,
    q5: value,
    q6: value,
    q7: value,
  };
}

const OFFICIAL_TECHNICAL = [
  "Iniciante",
  "Iniciante Intermediário",
  "Intermediário",
  "Intermediário Avançado",
  "Avançado",
  "Avançado Elevado",
  "Elite",
];

test("TASK-26: deterministic level test, no tournament history caps the level at 2.0", async () => {
  await withTestServer(async ({ api }) => {
    // q1 vale 1–4 e q2–q7 valem 1–5 (score 7–34). Sem histórico de torneio
    // o nível não passa de 2,0 (início da 5ª categoria).
    const expectations = [
      { value: 1, score: 7, level: 0.5 },
      { value: 2, score: 14, level: 1.98 },
      { value: 3, score: 21, level: 2 }, // já no teto
      { value: 5, score: 34, level: 2 }, // pontuação máxima, mesmo teto
    ];
    for (const expected of expectations) {
      const player = await registerPlayer(api, `faixa-${expected.value}`);
      const response = await api("/api/v1/player/level-test", {
        method: "POST",
        cookie: player.cookie,
        body: answers(expected.value),
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()).data;
      assert.equal(payload.result.score, expected.score);
      assert.equal(payload.result.nivel_inicial, expected.level);
      assert.ok(payload.result.nivel_inicial <= 2);
      assert.equal(payload.result.confiabilidade_inicial, 35);
      assert.equal(payload.user.profile.levelConfidence, 35);
      assert.ok(
        OFFICIAL_TECHNICAL.includes(payload.result.categoria_sugerida),
        "categoria deve vir da tabela oficial de 7 faixas",
      );
      assert.equal(payload.engine.provider, "deterministic");
      assert.ok(payload.result.analise_tecnica.length > 10);
    }

    // q1 aceita no máximo 4 → 422
    const player = await registerPlayer(api, "invalido");
    const invalid = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: player.cookie,
      body: { ...answers(2), q1: 5 },
    });
    assert.equal(invalid.status, 422);
  });
});

test("TASK-26: tournament history unlocks the levels above the 2.0 cap", async () => {
  await withTestServer(async ({ api }) => {
    const expectations = [
      { cat: "7", stage: "grupo", level: 0.62 },
      { cat: "5", stage: "quartas", level: 2.15 },
      { cat: "4", stage: "final", level: 4.72 },
      { cat: "open", stage: "final", level: 6.61 },
    ];
    for (const expected of expectations) {
      const player = await registerPlayer(api, `torneio-${expected.cat}`);
      const response = await api("/api/v1/player/level-test", {
        method: "POST",
        cookie: player.cookie,
        body: { ...answers(3), q8: true, cat: expected.cat, stage: expected.stage },
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()).data;
      assert.equal(payload.result.nivel_inicial, expected.level);
      assert.equal(payload.result.confiabilidade_inicial, 35);
    }

    // q8 verdadeiro exige categoria e fase válidas
    const player = await registerPlayer(api, "torneio-invalido");
    const invalid = await api("/api/v1/player/level-test", {
      method: "POST",
      cookie: player.cookie,
      body: { ...answers(3), q8: true, cat: "99", stage: "final" },
    });
    assert.equal(invalid.status, 422);
  });
});

test("TASK-29: level explanation is empty before any confirmed match", async () => {
  await withTestServer(async ({ api }) => {
    const player = await registerPlayer(api, "sem-partida");
    const response = await api("/api/v1/player/level-explanation", {
      cookie: player.cookie,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.explanation, null);
  });
});
