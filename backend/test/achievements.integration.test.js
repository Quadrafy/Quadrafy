import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(testDirectory, "../../frontend");

test("GET /players/:id/achievements expõe pins e detalhes de campeão publicamente", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "padelfy-achievements-api-"));
  let server;
  try {
    await writeFile(
      path.join(dataDirectory, "users.json"),
      `${JSON.stringify([
        {
          id: "player-public",
          role: "player",
          email: "public@example.com",
          passwordHash: "not-used-for-public-read",
          profile: { firstName: "Ana", lastName: "Pin" },
          createdAt: "2026-07-20T12:00:00.000Z",
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
      ])}\n`,
    );
    await writeFile(
      path.join(dataDirectory, "achievements.json"),
      `${JSON.stringify([
        {
          id: "progress-1",
          playerId: "player-public",
          achievementId: "matches-1",
          type: "progress_tier",
          tier: "bronze",
          unlockedAt: "2026-07-20T12:00:00.000Z",
        },
        {
          id: "title-1",
          playerId: "player-public",
          achievementId: "champion-super8",
          type: "champion_title",
          tier: "champion",
          competitionId: "super8-1",
          competitionType: "super8",
          competitionName: "Super 8 de Julho",
          clubId: "club-1",
          clubName: "Arena Central",
          competitionDate: "2026-07-20T12:00:00.000Z",
          levelCategory: "3.5–5.0",
          unlockedAt: "2026-07-20T12:00:00.000Z",
        },
      ])}\n`,
    );
    const app = await createApp({
      environment: "test",
      dataDirectory,
      frontendDirectory,
      sessionTtlHours: 1,
      anthropicApiKey: "",
    });
    server = createServer(app.handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/players/player-public/achievements`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.achievements.length, 2);
    assert.equal(payload.data.catalog.length, 0, "visitantes não recebem pins bloqueados");
    const title = payload.data.achievements.find(
      (achievement) => achievement.type === "champion_title",
    );
    assert.equal(title.asset, "/assets/images/achievements/pin-campeao-super8.svg");
    assert.equal(title.titleDetails.clubName, "Arena Central");
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
