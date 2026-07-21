// TASKS-16 / 67 — catálogo declarativo de conquistas.
// Para criar uma conquista de progressão basta acrescentar uma entrada aqui:
// o motor lê `criterion.metric` e `criterion.threshold` genericamente.

export const ACHIEVEMENT_TIERS = ["bronze", "prata", "ouro", "diamante", "elite"];

const progress = ({
  id,
  name,
  description,
  category,
  metric,
  threshold,
  tier,
  asset,
}) => ({
  id,
  type: "progress_tier",
  name,
  description,
  category,
  tier,
  asset: `/assets/images/achievements/${asset}.svg`,
  criterion: { metric, operator: "gte", threshold },
});

export const ACHIEVEMENT_CATALOG = Object.freeze([
  progress({ id: "matches-1", name: "Estreante", description: "Jogou a primeira partida na Quadrafy.", category: "Jogos disputados", metric: "matchesPlayed", threshold: 1, tier: "bronze", asset: "pin-jogos-bronze" }),
  progress({ id: "matches-10", name: "Em quadra", description: "Jogou 10 partidas na Quadrafy.", category: "Jogos disputados", metric: "matchesPlayed", threshold: 10, tier: "prata", asset: "pin-jogos-prata" }),
  progress({ id: "matches-50", name: "Ritmo de jogo", description: "Jogou 50 partidas na Quadrafy.", category: "Jogos disputados", metric: "matchesPlayed", threshold: 50, tier: "ouro", asset: "pin-jogos-ouro" }),
  progress({ id: "matches-100", name: "Centurião da quadra", description: "Jogou 100 partidas na Quadrafy.", category: "Jogos disputados", metric: "matchesPlayed", threshold: 100, tier: "diamante", asset: "pin-jogos-diamante" }),
  progress({ id: "matches-250", name: "Lenda da quadra", description: "Jogou 250 partidas na Quadrafy.", category: "Jogos disputados", metric: "matchesPlayed", threshold: 250, tier: "elite", asset: "pin-jogos-elite" }),

  progress({ id: "wins-1", name: "Primeira vitória", description: "Conquistou a primeira vitória na Quadrafy.", category: "Vitórias", metric: "wins", threshold: 1, tier: "bronze", asset: "pin-vitorias-bronze" }),
  progress({ id: "wins-10", name: "Dez vitórias", description: "Conquistou 10 vitórias na Quadrafy.", category: "Vitórias", metric: "wins", threshold: 10, tier: "prata", asset: "pin-vitorias-prata" }),
  progress({ id: "wins-50", name: "Vitória consistente", description: "Conquistou 50 vitórias na Quadrafy.", category: "Vitórias", metric: "wins", threshold: 50, tier: "ouro", asset: "pin-vitorias-ouro" }),
  progress({ id: "wins-100", name: "Cem vitórias", description: "Conquistou 100 vitórias na Quadrafy.", category: "Vitórias", metric: "wins", threshold: 100, tier: "diamante", asset: "pin-vitorias-diamante" }),
  progress({ id: "wins-250", name: "Imparável", description: "Conquistou 250 vitórias na Quadrafy.", category: "Vitórias", metric: "wins", threshold: 250, tier: "elite", asset: "pin-vitorias-elite" }),

  progress({ id: "streak-3", name: "Em chamas", description: "Venceu 3 partidas seguidas.", category: "Sequência de vitórias", metric: "currentWinStreak", threshold: 3, tier: "bronze", asset: "pin-sequencia-bronze" }),
  progress({ id: "streak-5", name: "Sequência forte", description: "Venceu 5 partidas seguidas.", category: "Sequência de vitórias", metric: "currentWinStreak", threshold: 5, tier: "prata", asset: "pin-sequencia-prata" }),
  progress({ id: "streak-10", name: "Invencível", description: "Venceu 10 partidas seguidas.", category: "Sequência de vitórias", metric: "currentWinStreak", threshold: 10, tier: "ouro", asset: "pin-sequencia-ouro" }),

  // TASK-83 — Torneios deixaram de existir; a categoria conta só Super 8.
  progress({ id: "events-1", name: "Primeiro desafio", description: "Participou de um Super 8 finalizado.", category: "Super 8", metric: "eventsParticipated", threshold: 1, tier: "bronze", asset: "pin-torneios-bronze" }),
  progress({ id: "events-5", name: "Competidor", description: "Participou de 5 Super 8 finalizados.", category: "Super 8", metric: "eventsParticipated", threshold: 5, tier: "prata", asset: "pin-torneios-prata" }),
  progress({ id: "events-15", name: "Veterano de Super 8", description: "Participou de 15 Super 8 finalizados.", category: "Super 8", metric: "eventsParticipated", threshold: 15, tier: "ouro", asset: "pin-torneios-ouro" }),

  progress({ id: "level-2", name: "Intermediário", description: "Alcançou o nível 2,0.", category: "Evolução de nível", metric: "level", threshold: 2, tier: "bronze", asset: "pin-nivel-bronze" }),
  progress({ id: "level-3-5", name: "Intermediário avançado", description: "Alcançou o nível 3,5.", category: "Evolução de nível", metric: "level", threshold: 3.5, tier: "prata", asset: "pin-nivel-prata" }),
  progress({ id: "level-5-5", name: "Avançado", description: "Alcançou o nível 5,5.", category: "Evolução de nível", metric: "level", threshold: 5.5, tier: "ouro", asset: "pin-nivel-ouro" }),
  progress({ id: "level-6-8", name: "Elite", description: "Alcançou o nível 6,8.", category: "Evolução de nível", metric: "level", threshold: 6.8, tier: "diamante", asset: "pin-nivel-diamante" }),

  progress({ id: "social-partners-5", name: "Parceiro de quadra", description: "Jogou com 5 parceiros frequentes diferentes.", category: "Social", metric: "frequentPartners", threshold: 5, tier: "bronze", asset: "pin-social-parceiros-bronze" }),
  progress({ id: "social-rivals-10", name: "Colecionador de rivais", description: "Enfrentou 10 rivais recorrentes diferentes.", category: "Social", metric: "recurringRivals", threshold: 10, tier: "prata", asset: "pin-social-rivais-prata" }),
]);

// TASK-83 — Torneios deixaram de existir; só o pin de campeão de Super 8
// permanece.
export const CHAMPION_PIN_ASSETS = Object.freeze({
  super8: "/assets/images/achievements/pin-campeao-super8.svg",
});

export function achievementById(id) {
  return ACHIEVEMENT_CATALOG.find((achievement) => achievement.id === id) ?? null;
}

export function publicAchievementCatalog() {
  return ACHIEVEMENT_CATALOG.map(({ criterion, ...achievement }) => ({
    ...achievement,
    criterion: {
      metric: criterion.metric,
      threshold: criterion.threshold,
    },
  }));
}
