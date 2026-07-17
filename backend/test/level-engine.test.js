import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INITIAL_LEVEL_CAP,
  INITIAL_RELIABILITY,
  POT_BASE_FAVORITE_WIN,
  POT_BASE_UNDERDOG_WIN,
  assessQuestionnaire,
  classificationFor,
  clampDynamicLevel,
  computeMatchOutcome,
  initialLevelForScore,
  normalizeReliability,
  reliabilityForMatchesPlayed,
  reliabilityMultiplier,
} from "../src/lib/level-engine.js";

function answersForScore(score) {
  // distribui a pontuação em 6 respostas de 1 a 4
  const answers = {};
  let remaining = score;
  const keys = ["q1", "q2", "q3", "q4", "q5", "q6"];
  keys.forEach((key, index) => {
    const left = keys.length - index - 1;
    const value = Math.max(1, Math.min(4, remaining - left));
    answers[key] = value;
    remaining -= value;
  });
  return answers;
}

function match({ team1Levels, team2Levels, team1Rel, team2Rel, winningTeam }) {
  return computeMatchOutcome({
    players: [
      { id: "a1", team: "team1", level: team1Levels[0], reliability: team1Rel, matchesPlayed: 5 },
      { id: "a2", team: "team1", level: team1Levels[1], reliability: team1Rel, matchesPlayed: 5 },
      { id: "b1", team: "team2", level: team2Levels[0], reliability: team2Rel, matchesPlayed: 5 },
      { id: "b2", team: "team2", level: team2Levels[1], reliability: team2Rel, matchesPlayed: 5 },
    ],
    winningTeam,
  });
}

/* TASK-26 — questionário determinístico */

test("TASK-26: score bands interpolate linearly with a hard cap at 5.6", () => {
  // um caso de cada uma das 4 faixas de pontuação
  assert.equal(initialLevelForScore(6), 0.5);
  assert.equal(initialLevelForScore(9), 1.2);
  assert.equal(initialLevelForScore(12), 1.85); // metade de 10–14 → metade de 1.3–2.4
  assert.equal(initialLevelForScore(17), 3.2);
  assert.equal(initialLevelForScore(24), 5.6);
  assert.ok(initialLevelForScore(24) <= INITIAL_LEVEL_CAP);
  assert.equal(initialLevelForScore(5), null);
  assert.equal(initialLevelForScore(25), null);
});

test("TASK-26: assessment is deterministic, uses the official band table and 35% reliability", () => {
  for (const score of [7, 12, 17, 22]) {
    const result = assessQuestionnaire(answersForScore(score));
    assert.equal(result.score, score);
    assert.equal(result.confiabilidade_inicial, INITIAL_RELIABILITY);
    assert.ok(result.nivel_inicial <= INITIAL_LEVEL_CAP);
    // categoria sempre vem da tabela oficial de 7 faixas
    assert.equal(
      result.categoria_sugerida,
      classificationFor(result.nivel_inicial).technical,
    );
    assert.ok(result.analise_tecnica.length > 10);
    // determinístico: mesma entrada → mesma saída
    assert.deepEqual(assessQuestionnaire(answersForScore(score)), result);
  }
});

/* TASK-27 — fiabilidade percentual */

test("TASK-27: reliability starts at 35%, grows with decreasing increments toward 95–100%", () => {
  assert.equal(reliabilityForMatchesPlayed(0), 35);
  let previous = 35;
  let previousStep = Infinity;
  for (let matches = 1; matches <= 60; matches += 1) {
    const value = reliabilityForMatchesPlayed(matches);
    assert.ok(value >= previous, "must be monotonic");
    const step = value - previous;
    assert.ok(step <= previousStep + 1, "increments must shrink overall");
    previous = value;
    previousStep = Math.max(step, 1);
  }
  assert.ok(reliabilityForMatchesPlayed(50) >= 90);
  assert.ok(reliabilityForMatchesPlayed(500) <= 100);
});

test("normalizeReliability converts the legacy 0–1 scale to percent", () => {
  assert.equal(normalizeReliability(0.2), 20);
  assert.equal(normalizeReliability(35), 35);
  assert.equal(normalizeReliability(undefined), INITIAL_RELIABILITY);
});

/* TASK-28 — reliabilityMultiplier isolada */

test("TASK-28: reliabilityMultiplier follows the documented piecewise interpolation", () => {
  assert.equal(reliabilityMultiplier(0), 8);
  assert.equal(reliabilityMultiplier(25), 6.5);
  assert.equal(reliabilityMultiplier(50), 5);
  assert.equal(reliabilityMultiplier(60), 3.5); // interpolação 50–70%
  assert.equal(reliabilityMultiplier(70), 2);
  assert.equal(reliabilityMultiplier(85), 1.5);
  assert.equal(reliabilityMultiplier(100), 1);
});

/* TASK-28 — pote de pontos + distribuição inversa */

test("TASK-28: underdog win pays a much bigger pot than favorite win", () => {
  const favoriteWin = match({
    team1Levels: [5, 5],
    team2Levels: [3, 3],
    team1Rel: 60,
    team2Rel: 60,
    winningTeam: "team1",
  });
  const underdogWin = match({
    team1Levels: [5, 5],
    team2Levels: [3, 3],
    team1Rel: 60,
    team2Rel: 60,
    winningTeam: "team2",
  });
  assert.equal(favoriteWin.breakdown.potBase, POT_BASE_FAVORITE_WIN);
  assert.equal(favoriteWin.breakdown.upset, false);
  assert.equal(underdogWin.breakdown.potBase, POT_BASE_UNDERDOG_WIN);
  assert.equal(underdogWin.breakdown.upset, true);
  assert.ok(
    underdogWin.updates.b1.delta > favoriteWin.updates.a1.delta * 3,
    "zebra deve ganhar bem mais que favorito",
  );
});

test("TASK-28: low reliability pair swings much more than high reliability pair", () => {
  // duplas de mesmo nível; fiabilidades diferentes → potes diferentes na
  // mesma partida (pote calculado separadamente por dupla)
  const outcome = match({
    team1Levels: [4, 4],
    team2Levels: [4, 4],
    team1Rel: 35, // calibração → M_f = 5.9
    team2Rel: 90, // veterano → M_f ≈ 1.33
    winningTeam: "team1",
  });
  assert.ok(
    outcome.breakdown.pots.team1 > outcome.breakdown.pots.team2 * 3,
  );
  assert.ok(
    Math.abs(outcome.updates.a1.delta) >
      Math.abs(outcome.updates.b1.delta) * 3,
  );
  // veterano perdendo uma partida isolada quase não se move
  assert.ok(Math.abs(outcome.updates.b1.delta) < 0.06);
});

test("TASK-28: inverse distribution inside an unbalanced pair (6.0 with 3.0)", () => {
  const win = match({
    team1Levels: [6, 3],
    team2Levels: [4.5, 4.5],
    team1Rel: 60,
    team2Rel: 60,
    winningTeam: "team1",
  });
  const strongWin = win.updates.a1; // 6.0
  const weakWin = win.updates.a2; // 3.0
  // pesos invertidos: fraco (3.0) usa 6/9 ≈ 0.667; forte usa 3/9 ≈ 0.333
  assert.equal(weakWin.weight, 0.667);
  assert.equal(strongWin.weight, 0.333);
  assert.ok(weakWin.delta > strongWin.delta, "fraco ganha mais na vitória");

  const loss = match({
    team1Levels: [6, 3],
    team2Levels: [4.5, 4.5],
    team1Rel: 60,
    team2Rel: 60,
    winningTeam: "team2",
  });
  const strongLoss = loss.updates.a1;
  const weakLoss = loss.updates.a2;
  // na derrota os pesos são cruzados: o forte absorve o maior prejuízo
  assert.ok(
    Math.abs(strongLoss.delta) > Math.abs(weakLoss.delta),
    "forte perde mais na derrota",
  );
  assert.ok(strongLoss.delta < 0 && weakLoss.delta < 0);
});

test("TASK-28: resulting level never leaves [0, 7] and category follows the table", () => {
  const nearCeiling = match({
    team1Levels: [6.95, 6.9],
    team2Levels: [6.99, 6.98],
    team1Rel: 10,
    team2Rel: 10,
    winningTeam: "team1", // zebra com fiabilidade baixíssima → delta grande
  });
  for (const update of Object.values(nearCeiling.updates)) {
    assert.ok(update.level >= 0 && update.level <= 7);
    assert.equal(
      update.classification.technical,
      classificationFor(update.level).technical,
    );
  }
  const nearFloor = match({
    team1Levels: [0.05, 0.1],
    team2Levels: [0.06, 0.08],
    team1Rel: 10,
    team2Rel: 10,
    winningTeam: "team2",
  });
  for (const update of Object.values(nearFloor.updates)) {
    assert.ok(update.level >= 0 && update.level <= 7);
  }
  assert.equal(clampDynamicLevel(9.4), 7);
  assert.equal(clampDynamicLevel(-1), 0);
});

test("TASK-28: equal team averages treat the winner as favorite (no upset)", () => {
  const outcome = match({
    team1Levels: [4, 4],
    team2Levels: [4, 4],
    team1Rel: 60,
    team2Rel: 60,
    winningTeam: "team2",
  });
  assert.equal(outcome.breakdown.upset, false);
  assert.equal(outcome.breakdown.potBase, POT_BASE_FAVORITE_WIN);
});
