import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ACHIEVEMENT_CATALOG } from "../src/config/achievements.js";
import {
  countFinishedParticipations,
  eligibleProgressAchievements,
  matchMetricsForPlayer,
  toAchievementView,
} from "../src/lib/achievements-engine.js";
import { AchievementStore } from "../src/stores/achievement-store.js";

function confirmedResult(index, { won = true } = {}) {
  return {
    confirmedAt: new Date(2026, 0, index + 1).toISOString(),
    teams: {
      team1: ["player-1", `partner-${index}`],
      team2: [`rival-${index}-a`, `rival-${index}-b`],
    },
    winningTeam: won ? "team1" : "team2",
  };
}

test("o catálogo é genérico e desbloqueia uma conquista de cada categoria", () => {
  const player = {
    id: "player-1",
    profile: { matchesPlayed: 250, wins: 250, level: 6.9 },
  };
  const results = Array.from({ length: 10 }, (_, index) => confirmedResult(index));
  const metrics = {
    ...matchMetricsForPlayer(player, results),
    eventsParticipated: countFinishedParticipations(
      player.id,
      Array.from({ length: 15 }, () => ({ status: "finalizado", players: [{ id: player.id }] })),
    ),
  };

  assert.equal(metrics.currentWinStreak, 10);
  assert.equal(metrics.frequentPartners, 10);
  assert.equal(metrics.recurringRivals, 20);
  assert.equal(metrics.eventsParticipated, 15);
  assert.deepEqual(
    eligibleProgressAchievements(metrics).map((achievement) => achievement.id),
    ACHIEVEMENT_CATALOG.map((achievement) => achievement.id),
  );
});

test("marcos respeitam o limite e não concedem uma vitória antes da hora", () => {
  const metrics = {
    matchesPlayed: 1,
    wins: 0,
    currentWinStreak: 0,
    eventsParticipated: 0,
    level: 0,
    frequentPartners: 0,
    recurringRivals: 0,
  };
  assert.deepEqual(
    eligibleProgressAchievements(metrics).map((achievement) => achievement.id),
    ["matches-1"],
  );
});

test("o store mantém progressão idempotente e acumula títulos distintos", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quadrafy-achievements-test-"));
  try {
    const store = new AchievementStore(directory);
    await store.initialize();
    const first = await store.grantProgress({
      playerId: "player-1",
      achievementId: "wins-1",
      tier: "bronze",
    });
    const repeated = await store.grantProgress({
      playerId: "player-1",
      achievementId: "wins-1",
      tier: "bronze",
    });
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);

    const champion = await store.grantChampionTitle({
      playerId: "player-1",
      competitionId: "super8-1",
      competitionType: "super8",
      competitionName: "Super 8 de Inverno",
      clubId: "club-1",
      clubName: "Arena Central",
      competitionDate: "2026-07-20T12:00:00.000Z",
    });
    const sameChampion = await store.grantChampionTitle({
      playerId: "player-1",
      competitionId: "super8-1",
      competitionType: "super8",
      competitionName: "Super 8 de Inverno",
      clubId: "club-1",
      clubName: "Arena Central",
      competitionDate: "2026-07-20T12:00:00.000Z",
    });
    const secondChampion = await store.grantChampionTitle({
      playerId: "player-1",
      competitionId: "super8-2",
      competitionType: "super8",
      competitionName: "Super 8 de Primavera",
      clubId: "club-1",
      clubName: "Arena Central",
      competitionDate: "2026-08-20T12:00:00.000Z",
    });
    assert.equal(champion.created, true);
    assert.equal(sameChampion.created, false);
    assert.equal(secondChampion.created, true);
    assert.equal(store.listByPlayer("player-1").length, 3);

    const view = toAchievementView(champion.achievement);
    assert.equal(view.asset, "/assets/images/achievements/pin-campeao-super8.svg");
    assert.equal(view.titleDetails.clubName, "Arena Central");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
