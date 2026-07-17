import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSuper8Standings,
  generateSuper8Games,
} from "../src/lib/super8-engine.js";

function makePlayers(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    name: `Jogador ${index}`,
  }));
}

function makeCourts(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    name: `Quadra ${index + 1}`,
  }));
}

function makePairs(count) {
  const pairs = [];
  for (let index = 0; index < count; index += 2) pairs.push([index, index + 1]);
  return pairs;
}

function gamePlayers(game) {
  return [...game.team1, ...game.team2].map((player) => player.id);
}

function assertValidGames(games) {
  games.forEach((game, index) => {
    assert.equal(game.order, index + 1, "games must be sequentially numbered");
    assert.equal(new Set(gamePlayers(game)).size, 4);
    assert.ok(!("startAt" in game), "TASK-43: games must not carry any time");
    assert.ok(game.court?.id);
  });
}

function partnerCounts(games) {
  const counts = new Map();
  for (const game of games) {
    for (const team of [game.team1, game.team2]) {
      const key = team
        .map((player) => player.id)
        .sort()
        .join("|");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

test("fixed pairs, 8 players: every pair faces every other exactly once", () => {
  const players = makePlayers(8);
  const games = generateSuper8Games({
    mode: "duplas_fixas",
    players,
    pairs: makePairs(8),
    courts: makeCourts(2),
  });
  assertValidGames(games);
  // 4 duplas → C(4,2) = 6 confrontos
  assert.equal(games.length, 6);
  const matchupKeys = games.map((game) =>
    [game.team1, game.team2]
      .map((team) => team.map((p) => p.id).sort().join("|"))
      .sort()
      .join(" vs "),
  );
  assert.equal(new Set(matchupKeys).size, 6);
});

test("rotation, 8 players: classic Super 8 — everyone partners everyone exactly once", () => {
  const players = makePlayers(8);
  const games = generateSuper8Games({
    mode: "rotacao",
    players,
    courts: makeCourts(2),
  });
  assertValidGames(games);
  assert.equal(games.length, 14); // 7 blocos × 2 jogos
  const partners = partnerCounts(games);
  assert.equal(partners.size, (8 * 7) / 2); // C(8,2) = 28 parcerias distintas
  assert.ok([...partners.values()].every((count) => count === 1));
});

test("rotation, 12 and 16 players: perfectly balanced partnerships", () => {
  for (const size of [12, 16]) {
    const games = generateSuper8Games({
      mode: "rotacao",
      players: makePlayers(size),
      courts: makeCourts(size / 4),
    });
    assertValidGames(games);
    assert.equal(games.length, ((size - 1) * size) / 4);
    const partners = partnerCounts(games);
    assert.equal(partners.size, (size * (size - 1)) / 2);
    assert.ok([...partners.values()].every((count) => count === 1));
  }
});

test("fixed pairs, 12 and 16 players: full round-robin of pairs", () => {
  for (const size of [12, 16]) {
    const pairCount = size / 2;
    const games = generateSuper8Games({
      mode: "duplas_fixas",
      players: makePlayers(size),
      pairs: makePairs(size),
      courts: makeCourts(3),
    });
    assertValidGames(games);
    assert.equal(games.length, (pairCount * (pairCount - 1)) / 2);
  }
});

test("one court vs multiple courts: same matchups, all courts used", () => {
  const players = makePlayers(8);
  const single = generateSuper8Games({
    mode: "rotacao",
    players,
    courts: makeCourts(1),
  });
  assertValidGames(single);
  assert.equal(single.length, 14);
  assert.ok(single.every((game) => game.court.id === "c0"));

  const multi = generateSuper8Games({
    mode: "rotacao",
    players,
    courts: makeCourts(2),
  });
  assert.equal(multi.length, 14);
  assert.equal(new Set(multi.map((game) => game.court.id)).size, 2);
});

test("court rotation: no player is locked to a single court across the tournament", () => {
  const players = makePlayers(8);
  const games = generateSuper8Games({
    mode: "rotacao",
    players,
    courts: makeCourts(2),
  });
  const courtsByPlayer = new Map();
  for (const game of games) {
    for (const playerId of gamePlayers(game)) {
      if (!courtsByPlayer.has(playerId))
        courtsByPlayer.set(playerId, new Set());
      courtsByPlayer.get(playerId).add(game.court.id);
    }
  }
  assert.ok(
    [...courtsByPlayer.values()].every((courts) => courts.size > 1),
    "every player must visit more than one court",
  );
});

/* TASK-48 — tabela final */

test("standings (rotation): ordered by wins, ties broken by games balance", () => {
  const [a, b, c, d] = makePlayers(4);
  const games = [
    { team1: [a, b], team2: [c, d], score: { team1Games: 7, team2Games: 3 } },
    { team1: [a, c], team2: [b, d], score: { team1Games: 5, team2Games: 7 } },
    { team1: [a, d], team2: [b, c], score: { team1Games: 7, team2Games: 6 } },
  ];
  const standings = computeSuper8Standings({ mode: "rotacao", games });
  assert.equal(standings.length, 4);
  // vitórias: a=2, b=2, d=2, c=0 → desempate por saldo:
  // a: (7-3)+(5-7)+(7-6)=+3 · b: (7-3)+(7-5)+(6-7)=+5 · d: (3-7)+(7-5)+(7-6)=-1
  assert.deepEqual(
    standings.map((row) => row.key),
    [b.id, a.id, d.id, c.id],
  );
  assert.deepEqual(
    standings.map((row) => row.position),
    [1, 2, 3, 4],
  );
  assert.equal(standings[0].wins, 2);
  assert.equal(standings[0].balance, 5);
  assert.ok(standings.every((row) => row.played === 3));
});

test("standings (fixed pairs): one row per pair with aggregated games balance", () => {
  const [a, b, c, d] = makePlayers(4);
  const games = [
    { team1: [a, b], team2: [c, d], score: { team1Games: 7, team2Games: 5 } },
    { team1: [a, b], team2: [c, d], score: { team1Games: 4, team2Games: 7 } },
  ];
  const standings = computeSuper8Standings({ mode: "duplas_fixas", games });
  assert.equal(standings.length, 2);
  assert.ok(standings.every((row) => row.wins === 1 && row.played === 2));
  // desempate por saldo: dupla CD tem (5-7)+(7-4)=+1; AB tem -1
  assert.deepEqual(standings[0].names.slice().sort(), [c.name, d.name].sort());
});
