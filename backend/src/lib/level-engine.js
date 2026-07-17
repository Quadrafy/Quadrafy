// TASKS-07 — Motor de nível "Playtomic Engine" do Quadrafy.
// Substitui integralmente a fórmula Elo-like do TASKS-06 (ΔN = (R−E)×K×(1−Φ+0.1)).
// Sistema 100% determinístico, sem nenhuma chamada de IA:
//   - TASK-26: teste inicial por questionário de 6 perguntas (pontuação 6–24).
//   - TASK-27: Fiabilidade em percentual 0–100, começando em 35%.
//   - TASK-28: cálculo pós-jogo por Pote de Pontos + Distribuição Inversa.
// Toda a matemática e os coeficientes ajustáveis vivem neste módulo, com
// testes unitários em test/level-engine.test.js.

export const LEVEL_FLOOR = 0;
export const LEVEL_CEILING = 7;

// Teto do nível inicial pelo questionário (TASK-26): ninguém começa acima
// de 5.6 — só resultados de partidas (TASK-28) levam além disso.
export const INITIAL_LEVEL_CAP = 5.6;
export const INITIAL_RELIABILITY = 35; // % (TASK-26/27)

// Pote Base (TASK-28): igual para as duas duplas na mesma partida.
export const POT_BASE_FAVORITE_WIN = 0.06;
export const POT_BASE_UNDERDOG_WIN = 0.34;

// Tabela oficial de faixas (inalterada desde o TASKS-06).
export const LEVEL_BANDS = [
  { min: 0, max: 1, technical: "Iniciante", category: "7ª Categoria" },
  {
    min: 1,
    max: 2,
    technical: "Iniciante Intermediário",
    category: "6ª Categoria",
  },
  { min: 2, max: 3.5, technical: "Intermediário", category: "5ª Categoria" },
  {
    min: 3.5,
    max: 5.5,
    technical: "Intermediário Avançado",
    category: "4ª Categoria",
  },
  { min: 5.5, max: 6.5, technical: "Avançado", category: "3ª Categoria" },
  {
    min: 6.5,
    max: 6.8,
    technical: "Avançado Elevado",
    category: "2ª Categoria",
  },
  { min: 6.8, max: 7, technical: "Elite", category: "Categoria Open" },
];

export function clampDynamicLevel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return (
    Math.round(
      Math.min(LEVEL_CEILING, Math.max(LEVEL_FLOOR, numeric)) * 100,
    ) / 100
  );
}

export function classificationFor(level) {
  const numeric = clampDynamicLevel(level);
  if (numeric === null) return null;
  const band =
    LEVEL_BANDS.find(
      (candidate) => numeric >= candidate.min && numeric < candidate.max,
    ) ?? LEVEL_BANDS.at(-1);
  return { ...band, label: `${band.technical} · ${band.category}` };
}

/* ------------------------------------------------------------------ */
/* TASK-26 — questionário determinístico                               */
/* ------------------------------------------------------------------ */

// Faixas de pontuação → nível inicial, com interpolação linear dentro de
// cada faixa (ex.: pontuação 12 na faixa 10–14 fica na metade → nível na
// metade de 1.3–2.4).
export const SCORE_BANDS = [
  { minScore: 6, maxScore: 9, minLevel: 0.5, maxLevel: 1.2 },
  { minScore: 10, maxScore: 14, minLevel: 1.3, maxLevel: 2.4 },
  { minScore: 15, maxScore: 19, minLevel: 2.5, maxLevel: 3.9 },
  { minScore: 20, maxScore: 24, minLevel: 4.0, maxLevel: 5.6 },
];

export function initialLevelForScore(score) {
  const numeric = Number(score);
  if (!Number.isInteger(numeric) || numeric < 6 || numeric > 24) return null;
  const band = SCORE_BANDS.find(
    (candidate) => numeric >= candidate.minScore && numeric <= candidate.maxScore,
  );
  const position =
    band.maxScore === band.minScore
      ? 0
      : (numeric - band.minScore) / (band.maxScore - band.minScore);
  const level = band.minLevel + (band.maxLevel - band.minLevel) * position;
  return Math.min(INITIAL_LEVEL_CAP, Math.round(level * 100) / 100);
}

// Textos fixos por faixa de pontuação (sem custo de API) — 2 variações por
// faixa, escolhidas de forma determinística pela pontuação.
const SCORE_BAND_TEXTS = [
  [
    "Você está começando no padel. Seu nível inicial reflete isso e vai se ajustar rápido conforme você jogar partidas confirmadas.",
    "Perfil de iniciante: foque em consistência nos golpes básicos. Cada partida confirmada vai calibrar seu nível rapidamente.",
  ],
  [
    "Você já sustenta trocas e conhece o jogo. Seu nível vai se refinar conforme você enfrentar duplas de força parecida.",
    "Perfil em evolução: seu nível inicial considera sua rotina de jogo e experiência com raquete. As próximas partidas confirmadas farão o ajuste fino.",
  ],
  [
    "Jogador intermediário com boa vivência de quadra. O motor vai calibrar seu nível com precisão nas primeiras partidas confirmadas.",
    "Você domina os fundamentos e usa as paredes. Seu nível será lapidado pelos resultados contra duplas do seu patamar.",
  ],
  [
    "Perfil avançado: experiência competitiva e domínio técnico. O teto inicial é 5.6 — acima disso, só vencendo em quadra.",
    "Você chega com bagagem forte. O questionário limita o início a 5.6; seus resultados em partidas confirmadas dirão até onde seu nível vai.",
  ],
];

export function assessQuestionnaire(answers) {
  const values = Object.values(answers);
  const score = values.reduce((sum, value) => sum + Number(value), 0);
  const level = initialLevelForScore(score);
  const bandIndex = SCORE_BANDS.findIndex(
    (band) => score >= band.minScore && score <= band.maxScore,
  );
  const texts = SCORE_BAND_TEXTS[bandIndex];
  const classification = classificationFor(level);
  return {
    score,
    nivel_inicial: level,
    confiabilidade_inicial: INITIAL_RELIABILITY,
    categoria_sugerida: classification.technical,
    analise_tecnica: texts[score % texts.length],
  };
}

/* ------------------------------------------------------------------ */
/* TASK-27 — Fiabilidade em percentual (0–100)                          */
/* ------------------------------------------------------------------ */

// Cresce a cada partida confirmada com incrementos decrescentes, partindo
// de 35% e se aproximando de ~95–100% por volta de 50+ partidas.
export function reliabilityForMatchesPlayed(matchesPlayed) {
  const matches = Math.max(0, Number(matchesPlayed) || 0);
  const reliability = 35 + 65 * (1 - Math.exp(-matches / 20));
  return Math.min(100, Math.round(reliability));
}

// Normaliza valores legados: escala antiga 0.1–1.0 (TASKS-06) e o valor
// antigo fixo 20 já eram numéricos — tudo vira percentual 0–100.
export function normalizeReliability(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return INITIAL_RELIABILITY;
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

/* ------------------------------------------------------------------ */
/* TASK-28 — Multiplicador de Fiabilidade por dupla                     */
/* ------------------------------------------------------------------ */

// M_f a partir da fiabilidade média (%) da dupla:
//   < 50%:  8.0 em 0% caindo linearmente até 5.0 em 50%  (variação grande)
//   50–70%: interpolação linear entre 5.0 (50%) e 2.0 (70%)
//           — o documento de referência não fixa a curva desta faixa;
//           a interpolação linear é a proposta de implementação, validar
//           com produto antes de considerar final.
//   > 70%:  2.0 em 70% caindo linearmente até 1.0 em 100% (nível consolidado)
export function reliabilityMultiplier(averageReliability) {
  const reliability = Math.min(
    100,
    Math.max(0, Number(averageReliability) || 0),
  );
  let multiplier;
  if (reliability < 50) {
    multiplier = 8 - (reliability / 50) * 3;
  } else if (reliability > 70) {
    multiplier = 2 - ((reliability - 70) / 30) * 1;
  } else {
    multiplier = 5 - ((reliability - 50) / 20) * 3;
  }
  return Math.round(multiplier * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* TASK-28 — Pote de Pontos + Distribuição Inversa                      */
/* ------------------------------------------------------------------ */

function pairAverage(players, key) {
  const values = players.map((player) => Number(player[key]) || 0);
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

// Pesos invertidos dentro da dupla: o peso do jogador fraco usa o nível do
// forte e vice-versa (o mais fraco ganha mais na vitória; na derrota os
// pesos são cruzados de novo, então o mais forte absorve o maior prejuízo).
function inverseWeights(pair) {
  const [a, b] = pair;
  const sum = Number(a.level) + Number(b.level);
  if (!Number.isFinite(sum) || sum <= 0) {
    return new Map([
      [a.id, 0.5],
      [b.id, 0.5],
    ]);
  }
  const strong = a.level >= b.level ? a : b;
  const weak = strong === a ? b : a;
  return new Map([
    [weak.id, strong.level / sum],
    [strong.id, weak.level / sum],
  ]);
}

// players: [{ id, team: "team1"|"team2", level, reliability (%), matchesPlayed }]
// Retorna { updates: { id → {...} }, breakdown } — o breakdown alimenta o
// explicador passo a passo da TASK-29.
export function computeMatchOutcome({ players, winningTeam }) {
  const byTeam = {
    team1: players.filter((player) => player.team === "team1"),
    team2: players.filter((player) => player.team === "team2"),
  };
  const averages = {
    team1: pairAverage(byTeam.team1, "level"),
    team2: pairAverage(byTeam.team2, "level"),
  };
  const reliabilities = {
    team1: pairAverage(byTeam.team1, "reliability"),
    team2: pairAverage(byTeam.team2, "reliability"),
  };
  const difference = Math.abs(averages.team1 - averages.team2);
  // Empate exato de médias: tratamos a vencedora como favorita (sem zebra).
  const favorite =
    averages.team1 === averages.team2
      ? winningTeam
      : averages.team1 > averages.team2
        ? "team1"
        : "team2";
  const upset = winningTeam !== favorite;
  const potBase = upset ? POT_BASE_UNDERDOG_WIN : POT_BASE_FAVORITE_WIN;
  const multipliers = {
    team1: reliabilityMultiplier(reliabilities.team1),
    team2: reliabilityMultiplier(reliabilities.team2),
  };
  const pots = {
    team1: potBase * multipliers.team1,
    team2: potBase * multipliers.team2,
  };
  const updates = {};
  for (const team of ["team1", "team2"]) {
    const pair = byTeam[team];
    const weights = inverseWeights(pair);
    const won = team === winningTeam;
    const strong = pair[0].level >= pair[1].level ? pair[0] : pair[1];
    for (const player of pair) {
      const ownWeight = weights.get(player.id);
      const partner = pair.find((candidate) => candidate.id !== player.id);
      const partnerWeight = partner ? weights.get(partner.id) : ownWeight;
      // Vitória: cada jogador usa o próprio peso (fraco ganha mais).
      // Derrota: pesos cruzados (fraco perde com o peso do forte → menor
      // impacto; forte perde com o peso do fraco → maior prejuízo).
      const weight = won ? ownWeight : partnerWeight;
      const delta = (won ? 1 : -1) * pots[team] * weight;
      const previousLevel = clampDynamicLevel(player.level) ?? 3.5;
      const level = clampDynamicLevel(previousLevel + delta);
      const matchesPlayed = Math.max(0, Number(player.matchesPlayed) || 0) + 1;
      updates[player.id] = {
        previousLevel,
        delta: Math.round(delta * 1000) / 1000,
        level,
        won,
        weight: Math.round(weight * 1000) / 1000,
        isStrong: player === strong && pair[0].level !== pair[1].level,
        matchesPlayed,
        reliability: reliabilityForMatchesPlayed(matchesPlayed),
        classification: classificationFor(level),
      };
    }
  }
  return {
    updates,
    breakdown: {
      averages,
      reliabilities,
      difference: Math.round(difference * 100) / 100,
      favorite,
      upset,
      potBase,
      multipliers,
      pots: {
        team1: Math.round(pots.team1 * 1000) / 1000,
        team2: Math.round(pots.team2 * 1000) / 1000,
      },
      winningTeam,
    },
  };
}

// Compatível com o nome usado no restante do app.
export function applyMatchResult(input) {
  return computeMatchOutcome(input).updates;
}
