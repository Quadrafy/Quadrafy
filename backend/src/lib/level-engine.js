// TASKS-07 — Motor de nível "Playtomic Engine" do Padelfy.
// Substitui integralmente a fórmula Elo-like do TASKS-06 (ΔN = (R−E)×K×(1−Φ+0.1)).
// Sistema 100% determinístico, sem nenhuma chamada de IA:
//   - TASK-26: teste inicial por questionário de 6 perguntas (pontuação 6–24).
//   - TASK-27: Fiabilidade em percentual 0–100, começando em 35%.
//   - TASK-28: cálculo pós-jogo por Pote de Pontos + Distribuição Inversa.
// Toda a matemática e os coeficientes ajustáveis vivem neste módulo, com
// testes unitários em test/level-engine.test.js.

export const LEVEL_FLOOR = 0;
export const LEVEL_CEILING = 7;

// Sem histórico de torneio o jogador não ultrapassa 2,0 (início da 5ª);
// com torneio pode chegar até 7,0.
export const INITIAL_LEVEL_CAP = 7.0;
export const INITIAL_RELIABILITY = 35; // % (TASK-26/27)

// Amplitude máxima de um jogo: o quanto o nível anda quando o resultado é
// uma surpresa total (venceu quem não tinha nenhuma chance). Numa partida
// equilibrada a surpresa é 0,5, então o movimento típico é BASE_K/2 = 0,10 —
// o alvo de referência para um jogo entre iguais com nível já consolidado.
export const BASE_K = 0.2;

// Escala da curva de expectativa (níveis). Define quanta vantagem uma
// diferença de nível representa:
//   0,5 de diferença → 58% de chance para a dupla mais forte
//   1,0             → 65%
//   2,0             → 78%
//   3,0             → 87%
// Calibrada para que uma vitória esperada contra adversário ~2 níveis abaixo
// renda ~0,045, sem achatar a ponto de vitórias normais valerem quase nada.
export const EXPECTATION_SCALE = 3.7;

// Teto de segurança por partida. Os fatores (surpresa, fiabilidade, margem,
// desequilíbrio da dupla) são multiplicativos e no pior caso se acumulavam
// perto de 0,9 — mais de uma categoria inteira num jogo só.
export const MAX_DELTA_PER_MATCH = 0.4;

// Probabilidade de vitória da dupla A dada a diferença de nível (A − B).
export function expectedWinRate(levelDifference) {
  const difference = Number(levelDifference) || 0;
  return 1 / (1 + 10 ** (-difference / EXPECTATION_SCALE));
}

// Tabela oficial de faixas.
export const LEVEL_BANDS = [
  { min: 0,   max: 1,   technical: "Iniciante",               category: "7ª Categoria"   },
  { min: 1,   max: 2,   technical: "Iniciante Intermediário",  category: "6ª Categoria"   },
  { min: 2,   max: 3.5, technical: "Intermediário",            category: "5ª Categoria"   },
  { min: 3.5, max: 5.2, technical: "Intermediário Avançado",   category: "4ª Categoria"   },
  { min: 5.2, max: 6.2, technical: "Avançado",                 category: "3ª Categoria"   },
  { min: 6.2, max: 6.8, technical: "Avançado Elevado",         category: "2ª Categoria"   },
  { min: 6.8, max: 7,   technical: "Elite",                    category: "Categoria Open" },
];

// TASK-77 — nomes técnicos das 7 categorias oficiais, para reaproveitar em
// qualquer feature que precise restringir por categoria (ex.: Super 8).
export const LEVEL_CATEGORY_NAMES = LEVEL_BANDS.map((band) => band.technical);

// Tabela de conversão entre escala uniforme (7 categorias × 1 unidade) e escala real.
const UNIFORM_BANDS = [
  { uMin: 0, uMax: 1, rMin: 0.0, rMax: 1.0 },
  { uMin: 1, uMax: 2, rMin: 1.0, rMax: 2.0 },
  { uMin: 2, uMax: 3, rMin: 2.0, rMax: 3.5 },
  { uMin: 3, uMax: 4, rMin: 3.5, rMax: 5.2 },
  { uMin: 4, uMax: 5, rMin: 5.2, rMax: 6.2 },
  { uMin: 5, uMax: 6, rMin: 6.2, rMax: 6.8 },
  { uMin: 6, uMax: 7, rMin: 6.8, rMax: 7.0 },
];

function realToUniform(real) {
  for (const b of UNIFORM_BANDS) {
    if (real >= b.rMin && (real < b.rMax || b.uMax === 7)) {
      return b.uMin + (real - b.rMin) / (b.rMax - b.rMin);
    }
  }
  return 0;
}

function uniformToReal(u) {
  const clamped = Math.min(7, Math.max(0, u));
  for (const b of UNIFORM_BANDS) {
    if (clamped >= b.uMin && (clamped < b.uMax || b.uMax === 7)) {
      return b.rMin + ((clamped - b.uMin) / (b.uMax - b.uMin)) * (b.rMax - b.rMin);
    }
  }
  return 0;
}

// Converte nível feminino → nível geral subtraindo 1,5 categorias na escala uniforme.
// Exemplo: 5ª a 75% (nível 3,125) → uniforme 2,75 → 1,25 → 6ª a 25% (nível 1,25).
export function womenToGeneralLevel(femaleLevel) {
  const clamped = clampDynamicLevel(femaleLevel);
  if (clamped === null) return null;
  const uGeneral = Math.max(0, realToUniform(clamped) - 1.5);
  return r2(uniformToReal(uGeneral));
}

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
/* TASK-26 v2 — Questionário de 8 perguntas com torneio opcional       */
/* ------------------------------------------------------------------ */

export const TOURNEY_CATS = [
  { value: "7",    label: "7ª Categoria",   floor: 0.0, ceil: 1.0 },
  { value: "6",    label: "6ª Categoria",   floor: 1.0, ceil: 2.0 },
  { value: "5",    label: "5ª Categoria",   floor: 2.0, ceil: 3.5 },
  { value: "4",    label: "4ª Categoria",   floor: 3.5, ceil: 5.2 },
  { value: "3",    label: "3ª Categoria",   floor: 5.2, ceil: 6.2 },
  { value: "2",    label: "2ª Categoria",   floor: 6.2, ceil: 6.8 },
  { value: "open", label: "Categoria Open", floor: 6.8, ceil: 7.0 },
];

export const TOURNEY_STAGES = [
  { value: "grupo",   label: "Grupo / Oitavas",    factor: -0.25 },
  { value: "quartas", label: "Quartas / Semifinal", factor:  0.00 },
  { value: "final",   label: "Final",               factor:  0.80 },
];

function r2(n) {
  return Math.round(n * 100) / 100;
}

// Pontuação técnica (7–34) → nível (0,5–6,2).
export function techScoreToLevel(score) {
  const pct = (score - 7) / 27;
  return r2(0.5 + pct * 5.7);
}

// Nível calculado a partir da categoria e fase do torneio.
export function tourneyLevelFor(catValue, stageValue) {
  const cat   = TOURNEY_CATS.find((c) => c.value === catValue);
  const stage = TOURNEY_STAGES.find((s) => s.value === stageValue);
  const range = cat.ceil - cat.floor;
  return r2(Math.min(7.0, Math.max(0.3, cat.floor + stage.factor * range)));
}

const ANALYSIS_TEXTS = [
  "Você está começando no padel. Seu nível inicial reflete isso e vai se ajustar rapidamente conforme você jogar partidas confirmadas.",
  "Você já tem alguma vivência em quadra. Seu nível vai se refinar conforme você enfrentar duplas de força parecida.",
  "Jogador com boa base técnica. O motor vai calibrar seu nível com precisão nas primeiras partidas confirmadas.",
  "Perfil intermediário avançado com boa vivência de quadra. Seus resultados em partidas confirmadas definirão até onde seu nível vai.",
  "Perfil avançado com experiência competitiva. O motor vai acompanhar seus resultados para calibrar seu nível com precisão.",
  "Perfil de alto nível com histórico competitivo expressivo. As partidas confirmadas vão definir seu nível com exatidão.",
  "Perfil de elite. Seus resultados em partidas confirmadas definirão seu exato posicionamento no topo.",
];

function buildAnalysis(level, hasPlayed) {
  let idx = LEVEL_BANDS.findIndex((band) => level >= band.min && level < band.max);
  if (idx < 0) idx = LEVEL_BANDS.length - 1;
  const base = ANALYSIS_TEXTS[idx] ?? ANALYSIS_TEXTS[ANALYSIS_TEXTS.length - 1];
  return hasPlayed
    ? base
    : base + " Participar de torneios vai destravar categorias superiores no seu nivelamento.";
}

export function assessQuestionnaire(answers) {
  const techScore = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"].reduce(
    (sum, k) => sum + (Number(answers[k]) || 0),
    0,
  );
  const techLevel = techScoreToLevel(techScore);
  const hasPlayed = !!answers.q8;
  let nivel_inicial;
  if (hasPlayed) {
    const tl = tourneyLevelFor(answers.cat, answers.stage);
    nivel_inicial = r2(Math.min(7.0, Math.max(0.5, 0.10 * techLevel + 0.90 * tl)));
  } else {
    nivel_inicial = r2(Math.min(2.0, Math.max(0.5, techLevel)));
  }
  const classification = classificationFor(nivel_inicial);
  return {
    score: techScore,
    nivel_inicial,
    confiabilidade_inicial: INITIAL_RELIABILITY,
    categoria_sugerida: classification.technical,
    analise_tecnica: buildAnalysis(nivel_inicial, hasPlayed),
  };
}

/* ------------------------------------------------------------------ */
/* TASK-27 — Fiabilidade em percentual (0–100)                          */
/* ------------------------------------------------------------------ */

export const RELIABILITY_CEILING = 100;

// Alvo de calibração: a fiabilidade sai de 35% na estreia e chega a 75% na
// 10ª partida confirmada — o mesmo ponto em que o noviceDamping libera o
// delta cheio. Sem essa ancoragem o multiplicador de fiabilidade ainda
// estaria alto na 10ª e a variação de nível daria um pico logo depois do
// amortecimento acabar, em vez de cair de forma contínua.
const RELIABILITY_TARGET_MATCHES = 10;
const RELIABILITY_TARGET = 75;
const RELIABILITY_TAU =
  -RELIABILITY_TARGET_MATCHES /
  Math.log(
    1 -
      (RELIABILITY_TARGET - INITIAL_RELIABILITY) /
        (RELIABILITY_CEILING - INITIAL_RELIABILITY),
  );

// Cresce a cada partida confirmada com incrementos decrescentes: 35% na
// estreia, 75% na 10ª, ~90% na 20ª e praticamente 100% a partir da 50ª.
export function reliabilityForMatchesPlayed(matchesPlayed) {
  const matches = Math.max(0, Number(matchesPlayed) || 0);
  const reliability =
    INITIAL_RELIABILITY +
    (RELIABILITY_CEILING - INITIAL_RELIABILITY) *
      (1 - Math.exp(-matches / RELIABILITY_TAU));
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

// M_f a partir da fiabilidade média (%) da dupla: quanto menos consolidado o
// nível, maior a variação permitida. Vai linearmente de 2,1× na estreia (35%,
// a fiabilidade inicial) até 1,0× com o nível totalmente consolidado (100%).
//
// A curva anterior (3 trechos, chegando a 8,0× em fiabilidade baixa) fazia uma
// única zebra mover o nível de um estreante quase 1,0 ponto. O teto foi
// achatado no lugar de compensar com um fator de amortecimento separado: como
// a fiabilidade só cresce a cada partida confirmada e este multiplicador é
// estritamente decrescente nela, a variação de nível de um jogador cai
// partida após partida, sem pico no meio do caminho. Duas alavancas (um teto
// alto + um amortecedor crescente) produziam justamente esse pico.
export const RELIABILITY_MULTIPLIER_MAX = 2.1;
export const RELIABILITY_MULTIPLIER_MIN = 1;

export function reliabilityMultiplier(averageReliability) {
  const reliability = Math.min(
    100,
    Math.max(0, Number(averageReliability) || 0),
  );
  // Abaixo da fiabilidade inicial (dados legados) o multiplicador satura no
  // teto em vez de extrapolar.
  const progress = Math.min(
    1,
    Math.max(
      0,
      (reliability - INITIAL_RELIABILITY) /
        (RELIABILITY_CEILING - INITIAL_RELIABILITY),
    ),
  );
  const multiplier =
    RELIABILITY_MULTIPLIER_MAX -
    (RELIABILITY_MULTIPLIER_MAX - RELIABILITY_MULTIPLIER_MIN) * progress;
  return Math.round(multiplier * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* Margem de vitória                                                    */
/* ------------------------------------------------------------------ */

// Antes só importava quem venceu: uma virada em 3 sets valia o mesmo que um
// atropelo. A margem escala o pote pela diferença total de games, de 0,8×
// (vitória sofrida) a 1,2× (atropelo), com 1,0× numa vitória "padrão" de 6
// games de diferença.
//
// Não interfere na monotonicidade da variação por partida: o fator depende
// só do placar, não do histórico do jogador, então para um mesmo placar o
// delta continua caindo a cada partida disputada.
export const MARGIN_FACTOR_MIN = 0.8;
export const MARGIN_FACTOR_MAX = 1.2;
const MARGIN_PIVOT_GAMES = 6;
const MARGIN_SPAN_GAMES = 6;

export function marginFactor(sets, winningTeam) {
  // Resultados antigos (gravados antes desta regra) e chamadas sem placar
  // continuam neutros.
  if (!Array.isArray(sets) || sets.length === 0) return 1;
  let winnerGames = 0;
  let loserGames = 0;
  for (const set of sets) {
    const team1 = Number(set?.team1);
    const team2 = Number(set?.team2);
    if (!Number.isFinite(team1) || !Number.isFinite(team2)) return 1;
    winnerGames += winningTeam === "team1" ? team1 : team2;
    loserGames += winningTeam === "team1" ? team2 : team1;
  }
  const factor =
    1 +
    ((winnerGames - loserGames - MARGIN_PIVOT_GAMES) / MARGIN_SPAN_GAMES) *
      (MARGIN_FACTOR_MAX - 1);
  return (
    Math.round(
      Math.min(MARGIN_FACTOR_MAX, Math.max(MARGIN_FACTOR_MIN, factor)) * 1000,
    ) / 1000
  );
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
// sets: [{ team1, team2 }] — opcional; sem placar a margem de vitória é neutra.
// Retorna { updates: { id → {...} }, breakdown } — o breakdown alimenta o
// explicador passo a passo da TASK-29.
export function computeMatchOutcome({ players, winningTeam, sets = null }) {
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
  // Expectativa por dupla a partir da diferença de nível. Substitui o pote
  // binário (0,06 favorito / 0,34 zebra), que ignorava o TAMANHO da vantagem:
  // bater alguém 0,1 acima pagava o mesmo que bater alguém 3,0 acima, e por
  // isso toda partida convergia para o mesmo valor minúsculo.
  const expected = {
    team1: expectedWinRate(averages.team1 - averages.team2),
    team2: expectedWinRate(averages.team2 - averages.team1),
  };
  const margin = marginFactor(sets, winningTeam);
  const updates = {};
  for (const team of ["team1", "team2"]) {
    const pair = byTeam[team];
    const weights = inverseWeights(pair);
    const won = team === winningTeam;
    const strong = pair[0].level >= pair[1].level ? pair[0] : pair[1];
    // Quanto o resultado surpreendeu: +(1 − E) para quem venceu, −E para quem
    // perdeu. Vitória esperada rende pouco; vitória improvável rende muito.
    const surprise = (won ? 1 : 0) - expected[team];
    for (const player of pair) {
      const ownWeight = weights.get(player.id);
      const partner = pair.find((candidate) => candidate.id !== player.id);
      const partnerWeight = partner ? weights.get(partner.id) : ownWeight;
      // Vitória: cada jogador usa o próprio peso (fraco ganha mais).
      // Derrota: pesos cruzados (fraco perde com o peso do forte → menor
      // impacto; forte perde com o peso do fraco → maior prejuízo).
      const weight = won ? ownWeight : partnerWeight;
      // Normalizado para 1,0 numa dupla equilibrada, para que BASE_K continue
      // legível como "o quanto um jogador anda", e não "o quanto a dupla anda".
      const pairShare = 2 * weight;
      // A fiabilidade é individual: cada jogador usa a própria, não a média da
      // dupla. Quem tem o nível menos consolidado se ajusta mais rápido.
      const reliabilityUsed = normalizeReliability(player.reliability);
      const multiplier = reliabilityMultiplier(reliabilityUsed);
      const raw = BASE_K * surprise * multiplier * margin * pairShare;
      // Teto de segurança: os quatro fatores são multiplicativos e sem limite
      // chegavam perto de 0,9 num único jogo.
      const delta =
        Math.sign(raw) * Math.min(Math.abs(raw), MAX_DELTA_PER_MATCH);
      const previousLevel = clampDynamicLevel(player.level) ?? 3.5;
      const level = clampDynamicLevel(previousLevel + delta);
      const matchesPlayed = Math.max(0, Number(player.matchesPlayed) || 0) + 1;
      updates[player.id] = {
        previousLevel,
        delta: Math.round(delta * 1000) / 1000,
        level,
        won,
        weight: Math.round(weight * 1000) / 1000,
        pairShare: Math.round(pairShare * 1000) / 1000,
        reliabilityUsed,
        multiplier,
        expected: Math.round(expected[team] * 1000) / 1000,
        surprise: Math.round(surprise * 1000) / 1000,
        capped: Math.abs(raw) > MAX_DELTA_PER_MATCH,
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
      baseK: BASE_K,
      expected,
      margin,
      // Multiplicador, expectativa e surpresa também vão por jogador em
      // updates[id], porque a fiabilidade é individual.
      winningTeam,
    },
  };
}

// Compatível com o nome usado no restante do app.
export function applyMatchResult(input) {
  return computeMatchOutcome(input).updates;
}
