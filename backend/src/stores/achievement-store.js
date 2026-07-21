import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../lib/security.js";

// TASKS-16 / 68–69 — store append-only para marcos e títulos. A fila de
// escrita mantém a concessão idempotente mesmo quando duas verificações chegam
// muito próximas uma da outra.
export class AchievementStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, "achievements.json");
    this.achievements = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Expected an array");
      // TASK-83 — Torneios deixaram de existir; pins de campeão de Torneio
      // já concedidos são removidos (decisão do produto), mantendo só
      // Super 8 e as conquistas de progressão.
      const withoutTournamentTitles = parsed.filter(
        (achievement) =>
          !(
            achievement.type === "champion_title" &&
            achievement.competitionType === "tournament"
          ),
      );
      this.achievements = withoutTournamentTitles;
      if (withoutTournamentTitles.length !== parsed.length) await this.persist();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  listByPlayer(playerId) {
    return this.achievements
      .filter((achievement) => achievement.playerId === playerId)
      .sort((a, b) => new Date(b.unlockedAt).getTime() - new Date(a.unlockedAt).getTime());
  }

  async grantProgress({ playerId, achievementId, tier }) {
    return this.enqueueWrite(async () => {
      const existing = this.achievements.find(
        (achievement) =>
          achievement.playerId === playerId &&
          achievement.type === "progress_tier" &&
          achievement.achievementId === achievementId,
      );
      if (existing) return { achievement: existing, created: false };
      const achievement = {
        id: createId(),
        playerId,
        achievementId,
        type: "progress_tier",
        tier,
        unlockedAt: new Date().toISOString(),
      };
      this.achievements.push(achievement);
      await this.persist();
      return { achievement, created: true };
    });
  }

  async grantChampionTitle({ playerId, competitionId, competitionType, competitionName, clubId, clubName, competitionDate, levelCategory }) {
    return this.enqueueWrite(async () => {
      const existing = this.achievements.find(
        (achievement) =>
          achievement.playerId === playerId &&
          achievement.type === "champion_title" &&
          achievement.competitionId === competitionId,
      );
      if (existing) return { achievement: existing, created: false };
      const achievement = {
        id: createId(),
        playerId,
        achievementId: `champion-${competitionType}`,
        type: "champion_title",
        tier: "champion",
        competitionId,
        competitionType,
        competitionName,
        clubId,
        clubName,
        competitionDate,
        levelCategory: levelCategory ?? null,
        unlockedAt: new Date().toISOString(),
      };
      this.achievements.push(achievement);
      await this.persist();
      return { achievement, created: true };
    });
  }

  async persist() {
    await writeFile(this.filePath, `${JSON.stringify(this.achievements, null, 2)}\n`, {
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
