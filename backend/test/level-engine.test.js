import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_K,
  EXPECTATION_SCALE,
  INITIAL_RELIABILITY,
  MARGIN_FACTOR_MAX,
  MARGIN_FACTOR_MIN,
  MAX_DELTA_PER_MATCH,
  RELIABILITY_MULTIPLIER_MAX,
  RELIABILITY_MULTIPLIER_MIN,
  assessQuestionnaire,
  classificationFor,
  clampDynamicLevel,
  computeMatchOutcome,
  expectedWinRate,
  marginFactor,
  normalizeReliability,
  reliabilityForMatchesPlayed,
  reliabilityMultiplier,
  womenToGeneralLevel,
} from "../src/lib/level-engine.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const sets = (rows) => rows.map(([team1, team2]) => ({ team1, team2 }));

// Placar com saldo de exatamente 6 games → margem neutra (1,0). Usado em todo
// teste de calibração para isolar o fator que está sendo medido.
const NEUTRAL_SETS = sets([
  [6, 2],
  [6, 2],
  [4, 6],
]);

function match({
  team1Levels,
  team2Levels,
  team1Matches = 60,
  team2Matches = 60,
  winningTeam,
  matchSets = NEUTRAL_SETS,
}) {
  const player = (id, team, level, matchesPlayed) => ({
    id,
    team,
    level,
    matchesPlayed,
    reliability: reliabilityForMatchesPlayed(matchesPlayed),
  });
  return computeMatchOutcome({
    players: [
      player("a1", "team1", team1Levels[0], team1Matches),
      player("a2", "team1", team1Levels[1], team1Matches),
      player("b1", "team2", team2Levels[0], team2Matches),
      player("b2", "team2", team2Levels[1], team2Matches),
    ],
    winningTeam,
    sets: matchSets,
  });
}

const round3 = (value) => Math.round(value * 1000) / 1000;

/* ------------------------------------------------------------------ */
/* questionário inicial                                                */
/* ------------------------------------------------------------------ */

const answers = (value) => ({
  q1: Math.min(value, 4),
  q2: value,
  q3: value,
  q4: value,
  q5: value,
  q6: value,
  q7: value,
});

test("questionário: sem torneio o nível inicial não passa de 2,0", () => {
  for (const [value, score, level] of [
    [1, 7, 0.5],
    [2, 14, 1.98],
    [3, 21, 2],
    [5, 34, 2],
  ]) {
    const result = assessQuestionnaire(answers(value));
    assert.equal(result.score, score);
    assert.equal(result.nivel_inicial, level);
    assert.equal(result.confiabilidade_inicial, INITIAL_RELIABILITY);
    assert.equal(
      result.categoria_sugerida,
      classificationFor(result.nivel_inicial).technical,
    );
    // determinístico
    assert.deepEqual(assessQuestionnaire(answers(value)), result);
  }
});

test("questionário: torneio destrava os níveis acima do teto de 2,0", () => {
  for (const [cat, stage, level] of [
    ["7", "grupo", 0.62],
    ["5", "quartas", 2.15],
    ["4", "final", 4.72],
    ["open", "final", 6.61],
  ]) {
    const result = assessQuestionnaire({ ...answers(3), q8: true, cat, stage });
    assert.equal(result.nivel_inicial, level);
  }
});

/* ------------------------------------------------------------------ */
/* fiabilidade                                                         */
/* ------------------------------------------------------------------ */

test("fiabilidade: 35% na estreia, 75% na 10ª partida, monotônica até 100%", () => {
  assert.equal(reliabilityForMatchesPlayed(0), INITIAL_RELIABILITY);
  // Alvo de calibração: o ponto em que o motor considera o nível "assentado".
  assert.equal(reliabilityForMatchesPlayed(10), 75);
  assert.equal(reliabilityForMatchesPlayed(20), 90);

  let previous = -Infinity;
  for (let matches = 0; matches <= 300; matches += 1) {
    const value = reliabilityForMatchesPlayed(matches);
    assert.ok(value >= previous, `fiabilidade caiu em ${matches} partidas`);
    assert.ok(value <= 100);
    previous = value;
  }
});

test("normalizeReliability converte a escala legada 0–1 para percentual", () => {
  assert.equal(normalizeReliability(0.2), 20);
  assert.equal(normalizeReliability(35), 35);
  assert.equal(normalizeReliability(undefined), INITIAL_RELIABILITY);
});

test("multiplicador de fiabilidade é estritamente decrescente, de 2,1 a 1,0", () => {
  assert.equal(reliabilityMultiplier(INITIAL_RELIABILITY), RELIABILITY_MULTIPLIER_MAX);
  assert.equal(reliabilityMultiplier(100), RELIABILITY_MULTIPLIER_MIN);
  // abaixo da fiabilidade inicial satura no teto em vez de extrapolar
  assert.equal(reliabilityMultiplier(0), RELIABILITY_MULTIPLIER_MAX);

  let previous = Infinity;
  for (let reliability = 35; reliability <= 100; reliability += 0.5) {
    const value = reliabilityMultiplier(reliability);
    assert.ok(value <= previous, `multiplicador subiu em ${reliability}%`);
    previous = value;
  }
});

/* ------------------------------------------------------------------ */
/* expectativa e margem                                                */
/* ------------------------------------------------------------------ */

test("expectativa: 50% em duplas iguais e cresce com a diferença de nível", () => {
  assert.equal(expectedWinRate(0), 0.5);
  assert.equal(round3(expectedWinRate(1)), 0.651);
  assert.equal(round3(expectedWinRate(2)), 0.776);
  assert.equal(round3(expectedWinRate(3)), 0.866);
  // simétrica
  for (const difference of [0.5, 1, 2, 3, 5]) {
    assert.equal(
      round3(expectedWinRate(difference) + expectedWinRate(-difference)),
      1,
    );
  }
  assert.equal(EXPECTATION_SCALE, 3.7);
});

test("margem de vitória vai de 0,8 (sofrida) a 1,2 (atropelo), neutra em +6 games", () => {
  assert.equal(marginFactor(sets([[7, 6], [7, 6], [0, 6]]), "team1"), MARGIN_FACTOR_MIN);
  assert.equal(marginFactor(NEUTRAL_SETS, "team1"), 1);
  assert.equal(marginFactor(sets([[6, 1], [6, 0], [6, 2]]), "team1"), MARGIN_FACTOR_MAX);
  // sem placar (resultados antigos) fica neutra
  assert.equal(marginFactor(null, "team1"), 1);
  assert.equal(marginFactor([], "team1"), 1);
  // conta os games do vencedor, não os do team1
  assert.equal(
    marginFactor(sets([[1, 6], [0, 6], [2, 6]]), "team2"),
    MARGIN_FACTOR_MAX,
  );
});

/* ------------------------------------------------------------------ */
/* CALIBRAÇÃO — os alvos de produto                                    */
/* ------------------------------------------------------------------ */

test("CALIBRAÇÃO: jogo equilibrado entre jogadores consolidados move ~0,10", () => {
  const outcome = match({
    team1Levels: [4, 4],
    team2Levels: [4, 4],
    winningTeam: "team1",
  });
  assert.equal(outcome.updates.a1.delta, 0.1);
  assert.equal(outcome.updates.b1.delta, -0.1);
  assert.equal(outcome.updates.a1.expected, 0.5);
});

test("CALIBRAÇÃO: vitória esperada contra nível bem abaixo move ~0,045", () => {
  const outcome = match({
    team1Levels: [4, 4],
    team2Levels: [2, 2],
    winningTeam: "team1",
  });
  assert.equal(outcome.updates.a1.delta, 0.045);
  // e contra alguém MUITO abaixo, menos ainda
  const wider = match({
    team1Levels: [4, 4],
    team2Levels: [1, 1],
    winningTeam: "team1",
  });
  assert.ok(wider.updates.a1.delta < outcome.updates.a1.delta);
  assert.equal(wider.updates.a1.delta, 0.027);
});

test("CALIBRAÇÃO: o ganho cai de forma contínua conforme a vantagem cresce", () => {
  let previous = Infinity;
  for (const opponent of [4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5]) {
    const outcome = match({
      team1Levels: [4, 4],
      team2Levels: [opponent, opponent],
      winningTeam: "team1",
    });
    const delta = outcome.updates.a1.delta;
    assert.ok(
      delta < previous,
      `ganho não caiu ao enfrentar ${opponent} (${delta} vs ${previous})`,
    );
    previous = delta;
  }
});

test("CALIBRAÇÃO: zebra paga bem mais que vitória esperada", () => {
  const upset = match({
    team1Levels: [2, 2],
    team2Levels: [4, 4],
    winningTeam: "team1",
  });
  const expectedWin = match({
    team1Levels: [4, 4],
    team2Levels: [2, 2],
    winningTeam: "team1",
  });
  assert.equal(upset.breakdown.upset, true);
  assert.equal(expectedWin.breakdown.upset, false);
  assert.equal(upset.updates.a1.delta, 0.155);
  assert.ok(upset.updates.a1.delta > expectedWin.updates.a1.delta * 3);
});

test("CALIBRAÇÃO: fiabilidade multiplica por cima — estreante move o dobro do consolidado", () => {
  const outcome = match({
    team1Levels: [4, 4],
    team2Levels: [4, 4],
    team1Matches: 0, // 35% → 2,1×
    team2Matches: 60, // 100% → 1,0×
    winningTeam: "team1",
  });
  assert.equal(outcome.updates.a1.delta, 0.21);
  assert.equal(outcome.updates.b1.delta, -0.1);
  assert.equal(outcome.updates.a1.multiplier, RELIABILITY_MULTIPLIER_MAX);
  assert.equal(outcome.updates.b1.multiplier, RELIABILITY_MULTIPLIER_MIN);
});

test("CALIBRAÇÃO: a fiabilidade é individual, não a média da dupla", () => {
  const outcome = computeMatchOutcome({
    players: [
      { id: "novato", team: "team1", level: 4, matchesPlayed: 0, reliability: reliabilityForMatchesPlayed(0) },
      { id: "veterano", team: "team1", level: 4, matchesPlayed: 60, reliability: reliabilityForMatchesPlayed(60) },
      { id: "c1", team: "team2", level: 4, matchesPlayed: 30, reliability: reliabilityForMatchesPlayed(30) },
      { id: "c2", team: "team2", level: 4, matchesPlayed: 30, reliability: reliabilityForMatchesPlayed(30) },
    ],
    winningTeam: "team1",
    sets: NEUTRAL_SETS,
  });
  // mesma dupla, mesmo nível, mesma partida — históricos diferentes movem
  // quantidades diferentes
  assert.ok(
    outcome.updates.novato.delta > outcome.updates.veterano.delta * 2,
    "estreante deve mover bem mais que o parceiro consolidado",
  );
});

/* ------------------------------------------------------------------ */
/* monotonicidade e teto                                               */
/* ------------------------------------------------------------------ */

test("a variação de um jogador nunca sobe conforme ele acumula partidas", () => {
  for (const winner of ["team1", "team2"]) {
    let previous = Infinity;
    for (let matches = 0; matches <= 200; matches += 1) {
      const outcome = match({
        team1Levels: [4, 4],
        team2Levels: [3.5, 3.5],
        team1Matches: matches,
        team2Matches: matches,
        winningTeam: winner,
      });
      const delta = Math.abs(outcome.updates.a1.delta);
      assert.ok(
        delta <= previous + 1e-9,
        `variação subiu na partida ${matches} (${delta} > ${previous})`,
      );
      previous = delta;
    }
  }
});

test("nenhuma partida move o nível além do teto configurado", () => {
  // pior caso: zebra máxima + estreante + atropelo + dupla desbalanceada
  const outcome = match({
    team1Levels: [6.8, 0.5],
    team2Levels: [6.9, 6.9],
    team1Matches: 0,
    team2Matches: 0,
    winningTeam: "team1",
    matchSets: sets([
      [6, 0],
      [6, 0],
      [6, 0],
    ]),
  });
  for (const update of Object.values(outcome.updates)) {
    assert.ok(
      Math.abs(update.delta) <= MAX_DELTA_PER_MATCH,
      `delta ${update.delta} passou do teto`,
    );
  }
  assert.equal(outcome.updates.a2.capped, true);
});

/* ------------------------------------------------------------------ */
/* distribuição dentro da dupla                                        */
/* ------------------------------------------------------------------ */

test("distribuição inversa: o mais fraco ganha mais, o mais forte perde mais", () => {
  const win = match({
    team1Levels: [6, 3],
    team2Levels: [4.5, 4.5],
    winningTeam: "team1",
  });
  assert.equal(win.updates.a2.weight, 0.667); // fraco (3.0) usa 6/9
  assert.equal(win.updates.a1.weight, 0.333); // forte (6.0) usa 3/9
  assert.ok(win.updates.a2.delta > win.updates.a1.delta);

  const loss = match({
    team1Levels: [6, 3],
    team2Levels: [4.5, 4.5],
    winningTeam: "team2",
  });
  assert.ok(Math.abs(loss.updates.a1.delta) > Math.abs(loss.updates.a2.delta));
  assert.ok(loss.updates.a1.delta < 0 && loss.updates.a2.delta < 0);
});

test("numa dupla equilibrada cada jogador recebe a fatia cheia (pairShare 1,0)", () => {
  const outcome = match({
    team1Levels: [4, 4],
    team2Levels: [4, 4],
    winningTeam: "team1",
  });
  assert.equal(outcome.updates.a1.pairShare, 1);
  assert.equal(outcome.updates.a1.delta, BASE_K * 0.5);
});

/* ------------------------------------------------------------------ */
/* invariantes                                                         */
/* ------------------------------------------------------------------ */

test("o nível nunca sai de [0, 7] e a categoria acompanha a tabela", () => {
  const nearCeiling = match({
    team1Levels: [6.95, 6.9],
    team2Levels: [6.99, 6.98],
    team1Matches: 0,
    winningTeam: "team1",
  });
  const nearFloor = match({
    team1Levels: [0.05, 0.1],
    team2Levels: [0.06, 0.08],
    team1Matches: 0,
    winningTeam: "team2",
  });
  for (const outcome of [nearCeiling, nearFloor]) {
    for (const update of Object.values(outcome.updates)) {
      assert.ok(update.level >= 0 && update.level <= 7);
      assert.equal(
        update.classification.technical,
        classificationFor(update.level).technical,
      );
    }
  }
  assert.equal(clampDynamicLevel(9.4), 7);
  assert.equal(clampDynamicLevel(-1), 0);
});

test("médias iguais tratam o vencedor como favorito (sem zebra)", () => {
  const outcome = match({
    team1Levels: [4, 4],
    team2Levels: [4, 4],
    winningTeam: "team2",
  });
  assert.equal(outcome.breakdown.upset, false);
  assert.equal(outcome.updates.b1.expected, 0.5);
});

test("vencedor e perdedor têm surpresas simétricas", () => {
  const outcome = match({
    team1Levels: [5, 5],
    team2Levels: [3, 3],
    winningTeam: "team2",
  });
  assert.equal(
    round3(Math.abs(outcome.updates.a1.surprise)),
    round3(Math.abs(outcome.updates.b1.surprise)),
  );
});

test("com fiabilidades iguais a partida é soma zero", () => {
  const outcome = match({
    team1Levels: [5, 4],
    team2Levels: [3, 3.5],
    winningTeam: "team1",
  });
  const total = Object.values(outcome.updates).reduce(
    (sum, update) => sum + update.delta,
    0,
  );
  assert.ok(Math.abs(total) < 1e-9, `soma dos deltas foi ${total}`);
});

test("womenToGeneralLevel desconta 1,5 categorias na escala uniforme", () => {
  assert.equal(womenToGeneralLevel(3.125), 1.25);
  assert.equal(womenToGeneralLevel(0), 0);
  assert.equal(womenToGeneralLevel("nao-numero"), null);
});
