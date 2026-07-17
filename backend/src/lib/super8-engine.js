// TASKS-09 / TASK-40 — Motor de geração de rodadas do Super 8.
// Módulo isolado e testável (mesmo padrão do level-engine.js), cobrindo os
// tamanhos 8, 12 e 16 nas duas modalidades:
//
//   "duplas_fixas"  → round-robin de duplas (cada dupla enfrenta todas as
//                     outras exatamente uma vez), via "circle method".
//                     Com 8/12/16 jogadores o número de duplas é sempre par
//                     (4, 6 ou 8), então o circle method não precisa de
//                     "bye": são (P−1) rodadas-base com P/2 confrontos cada.
//
//   "rotacao"       → "cada um por si": usamos uma 1-fatoração do grafo
//                     completo K_N (circle method sobre jogadores), que
//                     particiona os N jogadores em N/2 duplas por rodada ao
//                     longo de N−1 rodadas, com CADA PAR de jogadores
//                     formando dupla EXATAMENTE UMA VEZ — perfeito para
//                     N = 8, 12 e 16. Dentro de cada rodada, as duplas são
//                     agrupadas em N/4 confrontos. Os adversários não são
//                     perfeitamente balanceados (limitação matemática
//                     conhecida do formato: priorizamos o equilíbrio de
//                     PARCERIAS, que é o critério central do Super 8), mas a
//                     ordem das duplas gerada pelo circle method distribui
//                     bem os confrontos.
//
// TASKS-12 / TASK-43 — SEM horário: o motor devolve apenas uma lista
// ordenada de CONFRONTOS (número sequencial, quadra e as duas duplas).
// O conceito de "rodada-base" continua existindo apenas como agrupamento
// lógico interno (garante que ninguém apareça duas vezes num mesmo bloco de
// jogos paralelos) — ele nunca é exposto como horário ao clube ou jogador.
// A quadra de cada jogo gira com um offset por bloco, evitando que um mesmo
// jogador fique preso à mesma quadra o torneio inteiro; quadras excedentes
// ficam ociosas quando um bloco tem menos jogos que quadras.

export const SUPER8_SIZES = [8, 12, 16];
export const SUPER8_MODES = ["duplas_fixas", "rotacao"];

// Circle method clássico: retorna, para N participantes (N par), N−1
// rodadas, cada uma com N/2 pares — cobrindo cada par exatamente uma vez.
function circlePairings(count) {
  const items = Array.from({ length: count }, (_, index) => index);
  const fixed = items[0];
  let rotating = items.slice(1);
  const rounds = [];
  for (let round = 0; round < count - 1; round += 1) {
    const order = [fixed, ...rotating];
    const pairs = [];
    for (let index = 0; index < count / 2; index += 1) {
      pairs.push([order[index], order[count - 1 - index]]);
    }
    rounds.push(pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

// Fatia os jogos de cada bloco em grupos de até `courts.length` jogos
// paralelos e devolve a lista plana e numerada de confrontos (sem tempo).
function scheduleGames({ baseRounds, courts }) {
  const games = [];
  let block = 0;
  for (const baseGames of baseRounds) {
    for (
      let sliceStart = 0;
      sliceStart < baseGames.length;
      sliceStart += courts.length
    ) {
      const slice = baseGames.slice(sliceStart, sliceStart + courts.length);
      slice.forEach((game, index) => {
        games.push({
          order: games.length + 1,
          court: courts[(index + block) % courts.length],
          team1: game.team1,
          team2: game.team2,
        });
      });
      block += 1;
    }
  }
  return games;
}

// Modalidade "duplas fixas": round-robin entre as duplas.
function fixedPairsBaseRounds(pairs) {
  const pairingRounds = circlePairings(pairs.length);
  return pairingRounds.map((matchups) =>
    matchups.map(([a, b]) => ({
      team1: pairs[a].map((player) => ({ ...player })),
      team2: pairs[b].map((player) => ({ ...player })),
    })),
  );
}

// Modalidade "cada um por si": 1-fatoração de K_N → duplas da rodada;
// duplas consecutivas se enfrentam.
function rotationBaseRounds(players) {
  const partnerRounds = circlePairings(players.length);
  return partnerRounds.map((pairs) => {
    const games = [];
    for (let index = 0; index < pairs.length; index += 2) {
      const [a1, a2] = pairs[index];
      const [b1, b2] = pairs[index + 1];
      games.push({
        team1: [{ ...players[a1] }, { ...players[a2] }],
        team2: [{ ...players[b1] }, { ...players[b2] }],
      });
    }
    return games;
  });
}

// Entrada:
//   mode: "duplas_fixas" | "rotacao"
//   players: [{ id|null, name }] (tamanho 8, 12 ou 16)
//   pairs (apenas duplas fixas): [[indexA, indexB], ...] cobrindo todos
//   courts: [{ id, name }] (>= 1)
// Saída (TASK-43, sem horário): lista ordenada de confrontos
//   [{ order, court, team1, team2 }]
export function generateSuper8Games({ mode, players, pairs = [], courts }) {
  if (!SUPER8_MODES.includes(mode)) {
    throw new Error(`invalid mode: ${mode}`);
  }
  if (!SUPER8_SIZES.includes(players.length)) {
    throw new Error(`invalid player count: ${players.length}`);
  }
  if (!Array.isArray(courts) || !courts.length) {
    throw new Error("at least one court is required");
  }
  const baseRounds =
    mode === "duplas_fixas"
      ? fixedPairsBaseRounds(
          pairs.map((pair) => pair.map((index) => players[index])),
        )
      : rotationBaseRounds(players);
  return scheduleGames({ baseRounds, courts });
}

/* ------------------------------------------------------------------ */
/* TASK-48 — tabela final: vitórias + saldo de games                    */
/* ------------------------------------------------------------------ */

// games: [{ team1, team2, score: { team1Games, team2Games } }] (todos com
// resultado lançado). Na modalidade "duplas_fixas" a tabela é por DUPLA;
// em "rotacao" ("cada um por si") é por JOGADOR.
// Ordenação: vitórias (desc) e, no empate, saldo de games (desc) — critério
// padrão de desempate do formato.
export function computeSuper8Standings({ mode, games }) {
  const rows = new Map();
  const ensureRow = (key, names) => {
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        names,
        played: 0,
        wins: 0,
        gamesFor: 0,
        gamesAgainst: 0,
      });
    }
    return rows.get(key);
  };
  const unitsOf = (team) =>
    mode === "duplas_fixas"
      ? [
          {
            key: team
              .map((player) => player.id ?? player.name)
              .sort()
              .join("|"),
            names: team.map((player) => player.name),
          },
        ]
      : team.map((player) => ({
          key: player.id ?? player.name,
          names: [player.name],
        }));
  for (const game of games) {
    if (!game.score) continue;
    const sides = [
      { team: game.team1, gamesFor: game.score.team1Games, gamesAgainst: game.score.team2Games },
      { team: game.team2, gamesFor: game.score.team2Games, gamesAgainst: game.score.team1Games },
    ];
    for (const side of sides) {
      const won = side.gamesFor > side.gamesAgainst;
      for (const unit of unitsOf(side.team)) {
        const row = ensureRow(unit.key, unit.names);
        row.played += 1;
        if (won) row.wins += 1;
        row.gamesFor += side.gamesFor;
        row.gamesAgainst += side.gamesAgainst;
      }
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, balance: row.gamesFor - row.gamesAgainst }))
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.balance - a.balance ||
        a.names.join().localeCompare(b.names.join(), "pt-BR"),
    )
    .map((row, index) => ({ ...row, position: index + 1 }));
}
