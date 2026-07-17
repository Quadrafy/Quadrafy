(() => {
  "use strict";

  if (document.documentElement.dataset.page !== "club") return;
  const {
    $,
    $$,
    apiRequest,
    closeModal,
    escapeHTML,
    formatCurrency,
    formatDate,
    hydrateIcons,
    icon,
    loadDashboard,
    openModal,
    showGenericModal,
    showToast,
    uploadImage,
    validateImageFile,
  } = window.Quadrafy;

  const state = {
    session: null,
    club: null,
    courts: [],
    bookings: [],
    finance: null,
    scheduleDate: null,
    schedulePeriod: "day",
    schedule: null,
    selectedRecurringId: null,
    editingRecurringId: null,
    editingCourtId: null,
    courtPreviewObjectUrl: null,
    clubPreviewObjectUrl: null,
  };

  const emptyState = (title, text) =>
    `<div class="data-empty-state"><span>${icon("court")}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(text)}</p></div>`;

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function timeToMinutes(time) {
    const [hour, minute] = String(time || "00:00")
      .split(":")
      .map(Number);
    return hour * 60 + minute;
  }

  function minutesToTime(minutes) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
    const minute = String(minutes % 60).padStart(2, "0");
    return `${hour}:${minute}`;
  }

  function courtOpenTime(court) {
    return court.openTime || court.opensAt || "06:00";
  }

  function courtCloseTime(court) {
    return court.closeTime || court.closesAt || "23:00";
  }

  function courtSlotDuration(court) {
    return Number(court.slotDuration || court.slotDurationMinutes || 90);
  }

  function safePhotoUrl(value) {
    const url = String(value || "").trim();
    if (!url) return "";
    if (
      /^\/(?:assets\/[a-z0-9/_\-.]+|uploads\/(?:players|clubs|courts)\/[a-f0-9-]+\.(?:jpe?g|png|webp))$/i.test(
        url,
      )
    ) {
      return url;
    }
    try {
      const parsed = new URL(url, location.origin);
      return parsed.protocol === "https:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function switchOwnerView(name) {
    $$("[data-owner-view]").forEach((view) =>
      view.classList.toggle("active", view.dataset.ownerView === name),
    );
    $$("[data-owner-tab]").forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.ownerTab === name ||
          (name === "manage" && button.dataset.ownerTab === "arenas"),
      ),
    );
    $(".app-nav")?.classList.remove("menu-open");
    scrollTo({ top: 0, behavior: "smooth" });
    if (name === "finance") loadFinance();
    if (name === "super8") loadSuper8();
  }

  function switchManageView(name) {
    $$("[data-manage-view]").forEach((view) =>
      view.classList.toggle("active", view.dataset.manageView === name),
    );
    $$("[data-manage-tab]").forEach((button) =>
      button.classList.toggle("active", button.dataset.manageTab === name),
    );
    if (name === "schedule") loadSchedule();
    if (name === "reservations") loadBookings();
  }


  /* ================= TASKS-09 — Super 8 ================= */

  const super8State = {
    tournaments: [],
    players: [], // [{id|null, name}]
    searchTimer: null,
    current: null,
  };

  const SUPER8_STATUS_LABELS = {
    em_configuracao: "Em configuração",
    inscricoes_abertas: "Inscrições abertas",
    gerado: "Tabela gerada",
    em_andamento: "Em andamento",
    finalizado: "Finalizado",
  };

  function super8Card(tournament) {
    const modeLabel =
      tournament.mode === "duplas_fixas"
        ? "Duplas fixas"
        : "Cada um por si (rotação)";
    const statusLabel =
      SUPER8_STATUS_LABELS[tournament.status] || tournament.status;
    const progress = tournament.gamesTotal
      ? `${tournament.gamesFinished}/${tournament.gamesTotal} jogos`
      : `${tournament.players.length}/${tournament.size} jogadores`;
    return `<article class="super8-card card-hover" data-super8-open="${escapeHTML(tournament.id)}" tabindex="0" role="button" aria-label="Abrir torneio ${escapeHTML(tournament.name)}">
      <div class="match-top"><span class="status-badge super8-status-${escapeHTML(tournament.status)}">${escapeHTML(statusLabel)}</span><span class="match-date">${escapeHTML(progress)}</span></div>
      <h3>${escapeHTML(tournament.name)}</h3>
      <div class="match-detail"><div><small>Formato</small><strong>Super ${tournament.size}</strong></div><div><small>Modalidade</small><strong>${escapeHTML(modeLabel)}</strong></div><div><small>Jogos</small><strong>${tournament.gamesTotal || "—"}</strong></div></div>
    </article>`;
  }

  async function loadSuper8() {
    const grid = $("[data-super8-grid]");
    if (!grid) return;
    try {
      const data = await apiRequest("/api/v1/club/super8");
      super8State.tournaments = data.tournaments;
      grid.innerHTML = data.tournaments.length
        ? data.tournaments.map(super8Card).join("")
        : `<p class="profile-data-note">Nenhum Super 8 criado ainda. Clique em "Criar novo Super 8" para montar o primeiro torneio.</p>`;
      $$("[data-super8-open]", grid).forEach((card) => {
        const open = () => openSuper8Detail(card.dataset.super8Open);
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
      });
    } catch (error) {
      grid.innerHTML = `<p class="profile-data-note">${escapeHTML(error.message)}</p>`;
    }
  }

  /* -------- criação -------- */

  function super8Size() {
    return Number($("[data-super8-size]").value);
  }

  function super8Mode() {
    return $("[data-super8-mode]").value;
  }

  function renderSuper8Players() {
    const size = super8Size();
    $("[data-super8-player-count]").textContent =
      `${super8State.players.length}/${size}`;
    const container = $("[data-super8-players]");
    container.innerHTML = super8State.players.length
      ? super8State.players
          .map(
            (player, index) =>
              `<span class="super8-chip">${escapeHTML(player.name)}${player.id ? "" : ' <em title="Convidado sem conta">convidado</em>'}<button type="button" data-super8-remove="${index}" aria-label="Remover ${escapeHTML(player.name)}">×</button></span>`,
          )
          .join("")
      : '<p class="profile-data-note">Nenhum jogador adicionado ainda.</p>';
    $$("[data-super8-remove]", container).forEach((button) =>
      button.addEventListener("click", () => {
        super8State.players.splice(Number(button.dataset.super8Remove), 1);
        renderSuper8Players();
        renderSuper8Pairs();
      }),
    );
    renderSuper8Pairs();
  }

  function addSuper8Player(player) {
    const size = super8Size();
    if (super8State.players.length >= size) {
      showToast(`O torneio comporta ${size} jogadores.`);
      return;
    }
    if (player.id && super8State.players.some((item) => item.id === player.id)) {
      showToast("Este jogador já está no torneio.");
      return;
    }
    super8State.players.push(player);
    renderSuper8Players();
  }

  function renderSuper8SearchResults(players) {
    const box = $("[data-super8-search-results]");
    if (!players.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = players
      .map(
        (player) =>
          `<button type="button" data-super8-pick="${escapeHTML(player.id)}" data-player-name="${escapeHTML(player.displayName)}"><strong>${escapeHTML(player.displayName)}</strong><small>${player.level !== null ? `Nível ${Number(player.level).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "Sem nível"}${player.city ? ` · ${escapeHTML(player.city)}` : ""}</small></button>`,
      )
      .join("");
    $$("[data-super8-pick]", box).forEach((button) =>
      button.addEventListener("click", () => {
        addSuper8Player({
          id: button.dataset.super8Pick,
          name: button.dataset.playerName,
        });
        $("[data-super8-search]").value = "";
        box.classList.add("hidden");
      }),
    );
  }

  function setupSuper8Search() {
    const input = $("[data-super8-search]");
    input?.addEventListener("input", () => {
      clearTimeout(super8State.searchTimer);
      const query = input.value.trim();
      if (query.length < 2) {
        renderSuper8SearchResults([]);
        return;
      }
      super8State.searchTimer = setTimeout(async () => {
        try {
          const data = await apiRequest(
            `/api/v1/players/search?q=${encodeURIComponent(query)}`,
          );
          renderSuper8SearchResults(data.players || []);
        } catch {
          renderSuper8SearchResults([]);
        }
      }, 250);
    });
  }

  function renderSuper8Pairs() {
    const block = $("[data-super8-pairs-block]");
    const isFixed = super8Mode() === "duplas_fixas";
    block.classList.toggle("hidden", !isFixed);
    if (!isFixed) return;
    const size = super8Size();
    const container = $("[data-super8-pairs]");
    if (super8State.players.length !== size) {
      container.innerHTML = `<p class="profile-data-note">Complete os ${size} jogadores para montar as duplas.</p>`;
      return;
    }
    const options = (selected) =>
      super8State.players
        .map(
          (player, index) =>
            `<option value="${index}"${index === selected ? " selected" : ""}>${escapeHTML(player.name)}</option>`,
        )
        .join("");
    container.innerHTML = Array.from({ length: size / 2 }, (_, pairIndex) => {
      const a = pairIndex * 2;
      const b = pairIndex * 2 + 1;
      return `<div class="super8-pair-row"><span class="result-set-label">Dupla ${pairIndex + 1}</span><select data-super8-pair-slot>${options(a)}</select><span class="result-set-x" aria-hidden="true">+</span><select data-super8-pair-slot>${options(b)}</select></div>`;
    }).join("");
  }

  function shuffleSuper8Pairs() {
    if (super8State.players.length !== super8Size()) {
      showToast("Complete os jogadores antes de sortear as duplas.");
      return;
    }
    const indexes = super8State.players.map((_, index) => index);
    for (let i = indexes.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    renderSuper8Pairs();
    $$("[data-super8-pair-slot]").forEach((select, position) => {
      select.value = String(indexes[position]);
    });
  }

  function readSuper8Pairs() {
    const values = $$("[data-super8-pair-slot]").map((select) =>
      Number(select.value),
    );
    if (new Set(values).size !== values.length) {
      throw new Error(
        "Cada jogador deve aparecer em exatamente uma dupla — revise as duplas.",
      );
    }
    const pairs = [];
    for (let index = 0; index < values.length; index += 2) {
      pairs.push([values[index], values[index + 1]]);
    }
    return pairs;
  }

  function renderSuper8Courts() {
    const container = $("[data-super8-courts]");
    container.innerHTML = state.courts.length
      ? state.courts
          .filter((court) => court.active !== false)
          .map(
            (court) =>
              `<label class="super8-court-option"><input type="checkbox" name="courtIds" value="${escapeHTML(court.id)}" /><span>${escapeHTML(court.name)}</span></label>`,
          )
          .join("")
      : '<p class="profile-data-note">Cadastre ao menos uma quadra na aba "Minhas arenas" para criar um torneio.</p>';
  }

  function openSuper8Create() {
    const form = $("[data-super8-form]");
    form.reset();
    super8State.players = [];
    $("[data-super8-form-note]").textContent = "";
    renderSuper8Players();
    renderSuper8Courts();
    openModal($("[data-super8-create-modal]"));
  }

  async function submitSuper8(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const note = $("[data-super8-form-note]");
    note.textContent = "";
    const size = super8Size();
    const isFixed = super8Mode() === "duplas_fixas";
    if (isFixed && super8State.players.length !== size) {
      note.textContent = `Adicione exatamente ${size} jogadores (faltam ${size - super8State.players.length}).`;
      return;
    }
    if (!isFixed && !super8State.players.length) {
      note.textContent = "Adicione ao menos um jogador.";
      return;
    }
    const courtIds = $$('[data-super8-courts] input:checked', form).map(
      (input) => input.value,
    );
    if (!courtIds.length) {
      note.textContent = "Selecione ao menos uma quadra para o torneio.";
      return;
    }
    let pairs = null;
    if (super8Mode() === "duplas_fixas") {
      try {
        pairs = readSuper8Pairs();
      } catch (error) {
        note.textContent = error.message;
        return;
      }
    }
    const button = $("[data-super8-submit]", form);
    button.disabled = true;
    button.textContent = "Criando…";
    try {
      const { tournament } = await apiRequest("/api/v1/club/super8", {
        method: "POST",
        body: {
          name: form.elements.name.value,
          size,
          mode: super8Mode(),
          players: super8State.players,
          ...(pairs ? { pairs } : {}),
        },
      });
      await apiRequest(
        `/api/v1/club/super8/${encodeURIComponent(tournament.id)}/courts`,
        { method: "PATCH", body: { courtIds } },
      );
      let latest = tournament;
      if (super8State.players.length === size) {
        const generated = await apiRequest(
          `/api/v1/club/super8/${encodeURIComponent(tournament.id)}/generate`,
          { method: "POST" },
        );
        latest = generated.tournament;
        showToast("Confrontos gerados. Revise e publique o torneio.");
      } else {
        showToast(
          "Torneio criado. Abra as inscrições para os jogadores completarem o quadro.",
        );
      }
      closeModal($("[data-super8-create-modal]"));
      await loadSuper8();
      openSuper8Detail(latest.id, latest);
    } catch (error) {
      note.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Criar torneio e gerar tabela";
    }
  }

  /* -------- detalhe / acompanhamento (TASKS-12: TASK-44/45/48) -------- */

  function super8TeamLabel(team) {
    return team.map((player) => player.name).join(" + ");
  }

  // TASK-45 — card de jogo: duplas separadas visualmente, quadra e status.
  function super8GameCard(game, tournament) {
    const finished = game.status === "finalizado";
    const editable = ["gerado", "em_andamento"].includes(tournament.status);
    const action = !finished
      ? editable
        ? `<button class="button button-primary" type="button" data-super8-result="${escapeHTML(game.id)}">Lançar resultado</button>`
        : '<span class="status-badge">Aguardando</span>'
      : `<div class="super8-game-score"><strong>${game.score.team1Games} × ${game.score.team2Games}</strong><span class="status-badge super8-status-finalizado">Finalizado</span>${editable ? `<button class="super8-edit-result" type="button" data-super8-result="${escapeHTML(game.id)}">Editar resultado</button>` : ""}</div>`;
    return `<article class="super8-game-card${finished ? " finished" : ""}">
      <div class="super8-game-head"><span class="super8-court-chip">Jogo ${game.order} · ${escapeHTML(game.court.name)}</span></div>
      <div class="super8-versus"><div class="super8-side"><strong>${escapeHTML(game.team1[0].name)}</strong><strong>${escapeHTML(game.team1[1].name)}</strong></div><span class="super8-x" aria-hidden="true">×</span><div class="super8-side right"><strong>${escapeHTML(game.team2[0].name)}</strong><strong>${escapeHTML(game.team2[1].name)}</strong></div></div>
      <div class="super8-game-action">${action}</div>
    </article>`;
  }

  function super8StandingsTable(tournament) {
    if (!tournament.standings?.length) return "";
    const rows = tournament.standings
      .map(
        (row) =>
          `<tr${row.position === 1 ? ' class="current-band"' : ""}><td>#${row.position}</td><td>${escapeHTML(row.names.join(" + "))}</td><td>${row.wins}</td><td>${row.played}</td><td>${row.balance > 0 ? "+" : ""}${row.balance}</td></tr>`,
      )
      .join("");
    return `<div class="super8-standings"><p class="micro-label">Tabela final</p><div class="super8-grid-scroll"><table class="level-bands-table super8-table"><thead><tr><th scope="col">Pos.</th><th scope="col">${tournament.mode === "duplas_fixas" ? "Dupla" : "Jogador"}</th><th scope="col">Vitórias</th><th scope="col">Jogos</th><th scope="col">Saldo de games</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  function openSuper8Detail(id, fresh = null) {
    const tournament =
      fresh || super8State.tournaments.find((item) => item.id === id) || null;
    if (!tournament) return;
    super8State.current = tournament;
    $("[data-super8-detail-title]").textContent = tournament.name;
    const statusLabel =
      SUPER8_STATUS_LABELS[tournament.status] || tournament.status;
    const modeLabel =
      tournament.mode === "duplas_fixas"
        ? "Duplas fixas"
        : "Cada um por si (rotação)";
    const games = tournament.games || [];
    const waiting = games.filter((game) => game.status !== "finalizado");
    const finished = games.filter((game) => game.status === "finalizado");
    const progressPercent = games.length
      ? Math.round((finished.length / games.length) * 100)
      : 0;

    let primaryAction = "";
    if (tournament.status === "gerado") {
      primaryAction =
        '<button class="button button-primary button-block shine" type="button" data-super8-publish>Publicar torneio</button>';
    } else if (tournament.status === "em_andamento") {
      primaryAction = waiting.length
        ? `<button class="button button-primary button-block" type="button" disabled>Gerar tabela final (faltam ${waiting.length} ${waiting.length === 1 ? "jogo" : "jogos"})</button>`
        : '<button class="button button-primary button-block shine" type="button" data-super8-finalize>Gerar tabela final</button>';
    } else if (
      tournament.status === "em_configuracao" &&
      tournament.mode === "rotacao" &&
      tournament.players.length < tournament.size
    ) {
      primaryAction = `<button class="button button-primary button-block" type="button" data-super8-open-registrations>Abrir inscrições (${tournament.size - tournament.players.length} vagas)</button>`;
    } else if (tournament.status === "inscricoes_abertas") {
      primaryAction = `<p class="profile-data-note">Inscrições abertas — ${tournament.players.length}/${tournament.size} jogadores confirmados. A geração dos confrontos libera quando o quadro completar.</p>`;
    } else if (
      tournament.status === "em_configuracao" &&
      tournament.players.length === tournament.size &&
      !games.length
    ) {
      primaryAction =
        '<button class="button button-primary button-block shine" type="button" data-super8-generate>Gerar confrontos</button>';
    }

    $("[data-super8-detail-content]").innerHTML = `
      <div class="match-detail super8-meta"><div><small>Status</small><strong>${escapeHTML(statusLabel)}</strong></div><div><small>Formato</small><strong>Super ${tournament.size}</strong></div><div><small>Modalidade</small><strong>${escapeHTML(modeLabel)}</strong></div><div><small>Jogadores</small><strong>${tournament.players.length}/${tournament.size}</strong></div></div>
      ${games.length ? `<div class="super8-progress"><div class="super8-progress-head"><span>${finished.length} de ${games.length} jogos finalizados</span><strong>${progressPercent}%</strong></div><div class="confidence-bar" aria-hidden="true"><span style="width:${progressPercent}%"></span></div></div>` : ""}
      ${super8StandingsTable(tournament)}
      ${waiting.length ? `<div class="super8-section"><p class="micro-label">Aguardando resultado (${waiting.length})</p><div class="super8-games">${waiting.map((game) => super8GameCard(game, tournament)).join("")}</div></div>` : ""}
      ${finished.length ? `<div class="super8-section"><p class="micro-label">Finalizados (${finished.length})</p><div class="super8-games">${finished.map((game) => super8GameCard(game, tournament)).join("")}</div></div>` : ""}
      ${primaryAction}`;

    $("[data-super8-publish]")?.addEventListener("click", publishSuper8);
    $("[data-super8-finalize]")?.addEventListener("click", finalizeSuper8);
    $("[data-super8-generate]")?.addEventListener("click", generateSuper8);
    $("[data-super8-open-registrations]")?.addEventListener(
      "click",
      openSuper8Registrations,
    );
    $$("[data-super8-result]").forEach((button) =>
      button.addEventListener("click", () =>
        openSuper8ResultForm(button.dataset.super8Result),
      ),
    );
    openModal($("[data-super8-detail-modal]"));
  }

  async function callSuper8Action(path, successMessage) {
    const { tournament } = await apiRequest(
      `/api/v1/club/super8/${encodeURIComponent(super8State.current.id)}/${path}`,
      { method: "POST" },
    );
    if (successMessage) showToast(successMessage);
    await loadSuper8();
    openSuper8Detail(tournament.id, tournament);
  }

  async function generateSuper8() {
    try {
      await callSuper8Action("generate", "Confrontos gerados.");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function openSuper8Registrations() {
    try {
      await callSuper8Action(
        "open-registrations",
        "Inscrições abertas — os jogadores já podem se inscrever.",
      );
    } catch (error) {
      showToast(error.message);
    }
  }

  async function finalizeSuper8() {
    try {
      await callSuper8Action(
        "finalize",
        "Torneio finalizado. Tabela final publicada.",
      );
    } catch (error) {
      showToast(error.message);
    }
  }

  // TASK-44 — placar em games corridos, editável enquanto o torneio não é
  // finalizado (correções de digitação são comuns em torneios presenciais).
  function openSuper8ResultForm(gameId) {
    const game = (super8State.current?.games || []).find(
      (item) => item.id === gameId,
    );
    if (!game) return;
    super8State.currentGameId = gameId;
    const modal = $("[data-super8-result-modal]");
    const form = $("[data-super8-result-form]", modal);
    form.reset();
    $("[data-super8-result-title]", modal).textContent =
      game.status === "finalizado" ? "Editar resultado." : "Lançar resultado.";
    $("[data-super8-result-team1]", modal).textContent = super8TeamLabel(
      game.team1,
    );
    $("[data-super8-result-team2]", modal).textContent = super8TeamLabel(
      game.team2,
    );
    if (game.score) {
      form.elements.team1Games.value = game.score.team1Games;
      form.elements.team2Games.value = game.score.team2Games;
    }
    openModal(modal);
  }

  async function submitSuper8Result(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $("[data-super8-result-submit]", form);
    button.disabled = true;
    try {
      const { tournament } = await apiRequest(
        `/api/v1/club/super8/${encodeURIComponent(super8State.current.id)}/games/${encodeURIComponent(super8State.currentGameId)}/result`,
        {
          method: "POST",
          body: {
            team1Games: Number(form.elements.team1Games.value),
            team2Games: Number(form.elements.team2Games.value),
          },
        },
      );
      closeModal($("[data-super8-result-modal]"));
      showToast("Placar salvo.");
      await loadSuper8();
      openSuper8Detail(tournament.id, tournament);
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function publishSuper8(event) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Publicando…";
    try {
      const { tournament } = await apiRequest(
        `/api/v1/club/super8/${encodeURIComponent(super8State.current.id)}/publish`,
        { method: "POST" },
      );
      showToast("Torneio publicado para os jogadores.");
      await loadSuper8();
      openSuper8Detail(tournament.id, tournament);
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
      button.textContent = "Publicar torneio";
    }
  }

  function setupSuper8() {
    $("[data-super8-create-open]")?.addEventListener("click", openSuper8Create);
    $("[data-super8-form]")?.addEventListener("submit", submitSuper8);
    $("[data-super8-size]")?.addEventListener("change", renderSuper8Players);
    $("[data-super8-mode]")?.addEventListener("change", renderSuper8Pairs);
    $("[data-super8-shuffle-pairs]")?.addEventListener(
      "click",
      shuffleSuper8Pairs,
    );
    $("[data-super8-add-guest]")?.addEventListener("click", () => {
      const input = $("[data-super8-guest-name]");
      const name = input.value.trim();
      if (name.length < 2) {
        showToast("Informe o nome do convidado.");
        return;
      }
      addSuper8Player({ id: null, name });
      input.value = "";
    });
    setupSuper8Search();
    $("[data-super8-result-form]")?.addEventListener(
      "submit",
      submitSuper8Result,
    );
  }

  function setupTabs() {
    $$("[data-owner-tab]").forEach((button) =>
      button.addEventListener("click", () =>
        switchOwnerView(button.dataset.ownerTab),
      ),
    );
    $$("[data-manage-tab]").forEach((button) =>
      button.addEventListener("click", () =>
        switchManageView(button.dataset.manageTab),
      ),
    );
    $("[data-back-arenas]")?.addEventListener("click", () =>
      switchOwnerView("arenas"),
    );
  }

  function renderDashboardSummary(summary) {
    $("[data-kpi-courts]").textContent = String(summary.activeCourts);
    $("[data-kpi-courts-context]").textContent =
      summary.activeCourts === 1
        ? "1 quadra publicada"
        : `${summary.activeCourts} quadras publicadas`;
    $("[data-kpi-bookings-today]").textContent = String(summary.todayBookings);
    $("[data-kpi-bookings-trend]").textContent = "Dados de hoje";
    $("[data-kpi-occupancy]").textContent = `${summary.occupancyRate}%`;
    $("[data-kpi-occupancy-trend]").textContent = "Com base na grade atual";
    $("[data-kpi-revenue]").textContent = formatCurrency(
      summary.monthlyRevenue,
    );
    $("[data-kpi-revenue-trend]").textContent = "Reservas pagas no mês";
  }

  function arenaCard() {
    const club = state.club;
    const photoUrl = safePhotoUrl(club.photoUrl);
    const artwork = photoUrl
      ? `<img class="owner-arena-photo" src="${escapeHTML(photoUrl)}" alt="${escapeHTML(club.name)}" />`
      : '<div class="club-cover-art"></div>';
    return `<article class="owner-arena-card card-hover" data-owner-arena tabindex="0"><div class="owner-arena-art">${artwork}</div><div class="owner-arena-info"><span class="status-open"><i></i> ${club.status === "active" ? "Arena ativa" : "Arena inativa"}</span><h3>${escapeHTML(club.name)}</h3><p>${state.courts.length ? "Visível para jogadores" : "Cadastre uma quadra para publicar a arena"}</p><div class="arena-mini-stats"><span><small>Quadras</small><strong>${state.courts.length}</strong></span><span><small>Reservas</small><strong>${state.bookings.length}</strong></span><span><small>Receita paga</small><strong>${escapeHTML(formatCurrency(state.session.summary.monthlyRevenue))}</strong></span></div></div></article>`;
  }

  function renderArena() {
    $("[data-owner-arena-grid]").innerHTML = arenaCard();
    const card = $("[data-owner-arena]");
    const open = () => openManagement();
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  }

  function openManagement() {
    $("[data-manage-title]").textContent = state.club.name;
    $("[data-manage-status]").innerHTML = "<i></i> Arena ativa";
    $("[data-manage-code]").textContent =
      `Cód. ${state.club.id.slice(0, 8).toUpperCase()}`;
    $("[data-manage-address]").textContent =
      state.club.address ||
      "Complete o endereço nas configurações para exibi-lo aos jogadores.";
    $("[data-setting-name]").value = state.club.name;
    $("[data-setting-description]").value = state.club.description || "";
    $("[data-setting-phone]").value = state.club.phone || "";
    $("[data-setting-address]").value = state.club.address || "";
    $("[data-setting-email]").value = state.session.user.email;
    $("[data-club-photo-input]").value = "";
    clearClubPhotoObjectUrl();
    setClubPhotoPreview(state.club.photoUrl, state.club.name);
    renderCourts();
    switchOwnerView("manage");
  }

  function courtCard(court) {
    const photoUrl = safePhotoUrl(court.photoUrl);
    const artwork = photoUrl
      ? `<img class="management-court-photo" src="${escapeHTML(photoUrl)}" alt="${escapeHTML(court.name)}" />`
      : '<div class="club-cover-art"></div>';
    return `<article class="management-court card-hover" role="button" tabindex="0" data-edit-court="${escapeHTML(court.id)}" aria-label="Editar ${escapeHTML(court.name)}"><div class="management-court-art">${artwork}<span class="court-state">${court.active ? "Ativa" : "Inativa"}</span></div><div class="management-court-body"><h3>${escapeHTML(court.name)}</h3><p>${court.type === "covered" ? "Coberta" : "Descoberta"} · ${escapeHTML(courtOpenTime(court))}–${escapeHTML(courtCloseTime(court))}</p><div class="court-meta"><span><small>Preço por horário</small><strong>${escapeHTML(formatCurrency(court.price))}</strong></span><span><small>Duração</small><strong>${courtSlotDuration(court)} min</strong></span><span class="court-edit-hint">Editar</span></div></div></article>`;
  }

  function renderCourts() {
    $("[data-management-courts]").innerHTML = state.courts.length
      ? state.courts.map(courtCard).join("")
      : emptyState(
          "Nenhuma quadra cadastrada ainda.",
          "Adicione a primeira quadra para publicar sua arena aos jogadores.",
        );
    $$("[data-edit-court]").forEach((card) => {
      const open = () => openCourtEditor(card.dataset.editCourt);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  async function loadCourts() {
    const data = await apiRequest("/api/v1/club/courts");
    state.courts = data.courts;
    renderCourts();
    renderArena();
    populateFinanceCourtFilter();
    populateRecurringCourts();
  }

  function populateHalfHourSelect(select, selectedValue) {
    if (!select) return;
    select.innerHTML = Array.from({ length: 48 }, (_, index) => {
      const time = minutesToTime(index * 30);
      return `<option value="${time}"${time === selectedValue ? " selected" : ""}>${time}</option>`;
    }).join("");
  }

  function showFormFeedback(selector, message, success = false) {
    const feedback = $(selector);
    if (!feedback) return;
    feedback.textContent = message || "";
    feedback.classList.toggle("hidden", !message);
    feedback.classList.toggle("success", Boolean(message) && success);
  }

  function clearCourtPhotoObjectUrl() {
    if (!state.courtPreviewObjectUrl) return;
    URL.revokeObjectURL(state.courtPreviewObjectUrl);
    state.courtPreviewObjectUrl = null;
  }

  function setCourtPhotoPreview(url, name = "Quadra") {
    const image = $("[data-court-photo-preview]");
    const placeholder = $("[data-court-photo-placeholder]");
    if (!image || !placeholder) return;
    const safeUrl = url?.startsWith("blob:") ? url : safePhotoUrl(url);
    image.hidden = !safeUrl;
    image.src = safeUrl || "";
    placeholder.hidden = Boolean(safeUrl);
    placeholder.textContent = String(name || "QD")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function configureCourtForm(court = null) {
    const form = $("[data-court-form]");
    state.editingCourtId = court?.id || null;
    clearCourtPhotoObjectUrl();
    form.reset();
    form.elements.name.value = court?.name || "";
    form.elements.price.value = court?.price ?? "";
    form.elements.type.value = court?.type || "";
    form.elements.openTime.value = court ? courtOpenTime(court) : "06:00";
    form.elements.closeTime.value = court ? courtCloseTime(court) : "23:00";
    form.elements.slotDuration.value = String(
      court ? courtSlotDuration(court) : 60,
    );
    form.elements.photo.value = "";
    setCourtPhotoPreview(court?.photoUrl, court?.name);
    $("[data-court-eyebrow]").textContent = court
      ? "Editar quadra"
      : "Nova quadra";
    $("#court-modal-title").textContent = court
      ? `Editar ${court.name}.`
      : "Adicione uma quadra.";
    $("[data-court-description]").textContent = court
      ? "Atualize os dados públicos, horários e imagem desta quadra."
      : "Cadastre os dados que serão exibidos aos jogadores.";
    $("[data-court-submit]").textContent = court
      ? "Salvar alterações"
      : "Adicionar quadra";
    $("[data-court-delete-open]").classList.toggle("hidden", !court);
    showFormFeedback("[data-court-feedback]", "");
  }

  function openCourtCreator() {
    configureCourtForm();
    openModal($("[data-court-modal]"));
    requestAnimationFrame(() => $("[data-court-form] [name='name']")?.focus());
  }

  function openCourtEditor(courtId) {
    const court = state.courts.find((item) => item.id === courtId);
    if (!court) return;
    configureCourtForm(court);
    openModal($("[data-court-modal]"));
    requestAnimationFrame(() => $("[data-court-form] [name='name']")?.focus());
  }

  function previewCourtPhoto(event) {
    const [file] = event.currentTarget.files || [];
    clearCourtPhotoObjectUrl();
    const court = state.courts.find(
      (item) => item.id === state.editingCourtId,
    );
    if (!file) {
      setCourtPhotoPreview(court?.photoUrl, court?.name);
      return;
    }
    try {
      validateImageFile(file);
      state.courtPreviewObjectUrl = URL.createObjectURL(file);
      setCourtPhotoPreview(
        state.courtPreviewObjectUrl,
        $("[data-court-form]").elements.name.value,
      );
    } catch (error) {
      event.currentTarget.value = "";
      setCourtPhotoPreview(court?.photoUrl, court?.name);
      showToast(error.message);
    }
  }

  async function saveCourt(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const button = $("[data-court-submit]", form);
    const formData = new FormData(form);
    const photo = formData.get("photo");
    formData.delete("photo");
    const values = Object.fromEntries(formData.entries());
    const body = {
      name: values.name.trim(),
      price: Number(values.price),
      type: values.type,
      openTime: values.openTime,
      closeTime: values.closeTime,
      slotDuration: Number(values.slotDuration),
    };
    if (
      timeToMinutes(body.closeTime) - timeToMinutes(body.openTime) <
      body.slotDuration
    ) {
      showFormFeedback(
        "[data-court-feedback]",
        "O horário de fechamento deve permitir ao menos uma reserva completa.",
      );
      return;
    }
    const existing = state.courts.find(
      (court) => court.id === state.editingCourtId,
    );
    if (existing) body.photoUrl = existing.photoUrl || "";
    showFormFeedback("[data-court-feedback]", "");
    button.disabled = true;
    button.textContent = "Salvando…";
    try {
      let court;
      if (state.editingCourtId) {
        if (photo instanceof File && photo.size > 0) {
          button.textContent = "Enviando imagem…";
          body.photoUrl = (
            await uploadImage(photo, "court", state.editingCourtId)
          ).url;
        }
        ({ court } = await apiRequest(
          `/api/v1/club/courts/${encodeURIComponent(state.editingCourtId)}`,
          { method: "PATCH", body },
        ));
      } else {
        ({ court } = await apiRequest("/api/v1/club/courts", {
          method: "POST",
          body,
        }));
        if (photo instanceof File && photo.size > 0) {
          button.textContent = "Enviando imagem…";
          body.photoUrl = (await uploadImage(photo, "court", court.id)).url;
          ({ court } = await apiRequest(
            `/api/v1/club/courts/${encodeURIComponent(court.id)}`,
            { method: "PATCH", body },
          ));
        }
      }
      const index = state.courts.findIndex((item) => item.id === court.id);
      if (index === -1) state.courts.push(court);
      else state.courts[index] = court;
      renderCourts();
      clearCourtPhotoObjectUrl();
      closeModal($("[data-court-modal]"));
      await refreshDashboard();
      openManagement();
      showToast(
        existing
          ? "Quadra atualizada."
          : "Quadra cadastrada e publicada para os jogadores.",
      );
    } catch (error) {
      showFormFeedback("[data-court-feedback]", error.message);
    } finally {
      button.disabled = false;
      button.textContent = state.editingCourtId
        ? "Salvar alterações"
        : "Adicionar quadra";
    }
  }

  async function requestCourtDeletion() {
    const court = state.courts.find(
      (item) => item.id === state.editingCourtId,
    );
    if (!court) return;
    const button = $("[data-court-delete-open]");
    button.disabled = true;
    try {
      const { futureBookings } = await apiRequest(
        `/api/v1/club/courts/${encodeURIComponent(court.id)}/deletion-impact`,
      );
      const bookingWarning = futureBookings
        ? ` Esta quadra possui ${futureBookings} ${futureBookings === 1 ? "reserva futura que será cancelada" : "reservas futuras que serão canceladas"}.`
        : "";
      $("[data-court-delete-message]").textContent =
        `Tem certeza que deseja excluir ${court.name}? Essa ação não pode ser desfeita.${bookingWarning}`;
      openModal($("[data-court-delete-modal]"));
      requestAnimationFrame(() =>
        $("[data-court-delete-confirm]")?.focus(),
      );
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function confirmCourtDeletion() {
    const courtId = state.editingCourtId;
    if (!courtId) return;
    const button = $("[data-court-delete-confirm]");
    button.disabled = true;
    button.textContent = "Excluindo…";
    try {
      await apiRequest(
        `/api/v1/club/courts/${encodeURIComponent(courtId)}?confirm=true`,
        { method: "DELETE" },
      );
      state.courts = state.courts.filter((court) => court.id !== courtId);
      state.editingCourtId = null;
      closeModal($("[data-court-delete-modal]"));
      closeModal($("[data-court-modal]"));
      await refreshDashboard();
      openManagement();
      showToast("Quadra excluída.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Confirmar exclusão";
    }
  }

  function setupCourtModal() {
    populateHalfHourSelect($("[data-court-open-time]"), "06:00");
    populateHalfHourSelect($("[data-court-close-time]"), "23:00");
    $("[data-add-court]")?.addEventListener("click", openCourtCreator);
    $("[data-court-photo-input]")?.addEventListener(
      "change",
      previewCourtPhoto,
    );
    $("[data-court-form]")?.addEventListener("submit", saveCourt);
    $("[data-court-delete-open]")?.addEventListener(
      "click",
      requestCourtDeletion,
    );
    $("[data-court-delete-confirm]")?.addEventListener(
      "click",
      confirmCourtDeletion,
    );
  }

  function bookingRow(booking) {
    const date = formatDate(booking.startAt, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const payment =
      { pix: "Pix", card: "Cartão", venue: "Na arena" }[
        booking.paymentMethod
      ] || booking.paymentMethod;
    const initials = booking.player?.initials || "—";
    const name = booking.player?.displayName || "Jogador";
    const value = escapeHTML(formatCurrency(booking.price));
    const action =
      booking.paymentStatus === "pending"
        ? `<button class="button button-outline button-small" type="button" data-confirm-payment="${escapeHTML(booking.id)}">Confirmar ${value}</button>`
        : value;
    return `<tr><td><span class="client-cell"><span>${escapeHTML(initials)}</span><strong>${escapeHTML(name)}</strong></span></td><td>${escapeHTML(booking.courtName)}</td><td>${escapeHTML(date)}</td><td class="payment-status">${escapeHTML(payment)}</td><td><span class="status-badge${booking.paymentStatus !== "paid" ? " done" : ""}">${booking.paymentStatus === "paid" ? "Pago" : "Pendente"}</span></td><td>${action}</td></tr>`;
  }

  function renderBookings() {
    const table = $("[data-reservation-table]");
    table.innerHTML = state.bookings.map(bookingRow).join("");
    if (!state.bookings.length) {
      table.innerHTML = `<tr><td colspan="6">${emptyState("Nenhuma reserva ainda.", "As reservas das suas quadras aparecerão aqui.")}</td></tr>`;
    }
    const count = $("[data-reservation-count]");
    count.textContent = String(state.bookings.length);
    count.classList.toggle("hidden", state.bookings.length === 0);
  }

  async function loadBookings() {
    try {
      const data = await apiRequest("/api/v1/club/bookings");
      state.bookings = data.bookings;
      renderBookings();
      renderArena();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function confirmPayment(bookingId, button) {
    const booking = state.bookings.find((item) => item.id === bookingId);
    if (!booking || booking.paymentStatus !== "pending") return;

    button.disabled = true;
    button.textContent = "Confirmando...";
    try {
      await apiRequest(
        `/api/v1/club/bookings/${encodeURIComponent(bookingId)}/payment`,
        {
          method: "PATCH",
          body: { status: "paid" },
        },
      );
      await refreshDashboard();
      await loadFinance();
      showToast("Pagamento confirmado.");
    } catch (error) {
      button.disabled = false;
      button.textContent = `Confirmar ${formatCurrency(booking.price)}`;
      showToast(error.message);
    }
  }

  function setupBookingActions() {
    $("[data-reservation-table]")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-confirm-payment]");
      if (!button) return;
      confirmPayment(button.dataset.confirmPayment, button);
    });
  }

  function clearClubPhotoObjectUrl() {
    if (!state.clubPreviewObjectUrl) return;
    URL.revokeObjectURL(state.clubPreviewObjectUrl);
    state.clubPreviewObjectUrl = null;
  }

  function setClubPhotoPreview(url, name = state.club?.name || "Quadrafy") {
    const image = $("[data-club-photo-preview]");
    const placeholder = $("[data-club-photo-placeholder]");
    if (!image || !placeholder) return;
    const safeUrl = url?.startsWith("blob:") ? url : safePhotoUrl(url);
    image.hidden = !safeUrl;
    image.src = safeUrl || "";
    placeholder.hidden = Boolean(safeUrl);
    placeholder.textContent = String(name || "QF")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function previewClubPhoto(event) {
    const [file] = event.currentTarget.files || [];
    clearClubPhotoObjectUrl();
    if (!file) {
      setClubPhotoPreview(state.club?.photoUrl, state.club?.name);
      return;
    }
    try {
      validateImageFile(file);
      state.clubPreviewObjectUrl = URL.createObjectURL(file);
      setClubPhotoPreview(
        state.clubPreviewObjectUrl,
        $("[data-setting-name]").value,
      );
    } catch (error) {
      event.currentTarget.value = "";
      setClubPhotoPreview(state.club?.photoUrl, state.club?.name);
      showToast(error.message);
    }
  }

  function setupClubSettings() {
    $("[data-club-photo-input]")?.addEventListener(
      "change",
      previewClubPhoto,
    );
    $("[data-club-settings-form]")?.addEventListener(
      "submit",
      async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.checkValidity()) return form.reportValidity();
        const button = $('button[type="submit"]', form);
        const formData = new FormData(form);
        const photo = formData.get("photo");
        formData.delete("photo");
        const values = Object.fromEntries(formData.entries());
        showFormFeedback("[data-club-settings-feedback]", "");
        button.disabled = true;
        try {
          let photoUrl = state.club.photoUrl || "";
          if (photo instanceof File && photo.size > 0) {
            button.textContent = "Enviando imagem…";
            photoUrl = (
              await uploadImage(photo, "club", state.club.id)
            ).url;
          }
          button.textContent = "Salvando…";
          const data = await apiRequest("/api/v1/club/profile", {
            method: "PATCH",
            body: {
              name: values.arenaName,
              description: values.description,
              phone: values.phone,
              address: values.address,
              photoUrl,
            },
          });
          state.club = data.club;
          state.session.club = data.club;
          state.session.identity.arenaName = data.club.name;
          clearClubPhotoObjectUrl();
          renderArena();
          openManagement();
          switchManageView("settings");
          showFormFeedback(
            "[data-club-settings-feedback]",
            "Informações públicas salvas.",
            true,
          );
          showToast("Informações da arena atualizadas.");
        } catch (error) {
          showFormFeedback("[data-club-settings-feedback]", error.message);
        } finally {
          button.disabled = false;
          button.textContent = "Salvar alterações";
        }
      },
    );
  }

  async function loadSchedule() {
    if (!state.club) return;
    state.scheduleDate ||= localDateKey();
    const dateInput = $("[data-schedule-date-input]");
    if (dateInput) dateInput.value = state.scheduleDate;
    $$("[data-schedule-period]").forEach((button) => {
      const active = button.dataset.schedulePeriod === state.schedulePeriod;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $("[data-schedule-date]").textContent =
      state.schedulePeriod === "week"
        ? "os próximos sete dias"
        : formatDate(`${state.scheduleDate}T12:00:00-03:00`, {
            weekday: "long",
            day: "2-digit",
            month: "long",
          });
    $("[data-owner-schedule]").innerHTML = emptyState(
      "Carregando a grade...",
      "Estamos consolidando os horários desta arena.",
    );
    try {
      const data = await apiRequest(
        `/api/v1/club/schedule?date=${encodeURIComponent(state.scheduleDate)}&period=${encodeURIComponent(state.schedulePeriod)}`,
      );
      state.schedule = data;
      if (data.period === "week") {
        const from = formatDate(`${data.from}T12:00:00-03:00`, {
          day: "2-digit",
          month: "short",
        });
        const to = formatDate(`${data.to}T12:00:00-03:00`, {
          day: "2-digit",
          month: "short",
        });
        $("[data-schedule-date]").textContent = `${from} a ${to}`;
      }
      renderSchedule(data);
    } catch (error) {
      state.schedule = null;
      $("[data-owner-schedule]").innerHTML = emptyState(
        "Não foi possível carregar a grade.",
        error.message,
      );
    }
  }

  function slotTime(slot) {
    if (slot.time) return slot.time;
    if (!slot.startAt) return "";
    return formatDate(slot.startAt, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function recurringIdFromSlot(slot) {
    if (typeof slot.recurringBooking === "string") return slot.recurringBooking;
    return slot.recurringBooking?.id || slot.recurringBookingId || "";
  }

  function scheduleCell(slot) {
    if (!slot) {
      return '<span class="schedule-cell blocked" aria-label="Fora da grade"><span>—</span></span>';
    }
    const status = ["available", "booked", "recurring", "blocked"].includes(
      slot.status,
    )
      ? slot.status
      : "blocked";
    const recurring = slot.recurringBooking;
    const clientName =
      typeof recurring === "object" ? recurring.clientName : "";
    const labels = {
      available: "Livre",
      booked: "Reservado",
      recurring: clientName ? `Fixo · ${clientName}` : "Fixo",
      blocked: "Bloqueado",
    };
    const compatibilityClass = {
      available: "",
      booked: "booked",
      recurring: "fixed open-match",
      blocked: "blocked booked",
    }[status];
    const recurringId = recurringIdFromSlot(slot);
    const interaction =
      status === "recurring" && recurringId
        ? ` data-recurring-id="${escapeHTML(recurringId)}" role="button" tabindex="0" aria-label="Ver reserva fixa de ${escapeHTML(clientName || "cliente")}"`
        : "";
    return `<span class="schedule-cell ${compatibilityClass}" data-schedule-status="${status}"${interaction}><span>${escapeHTML(labels[status])}</span></span>`;
  }

  function renderWeeklySchedule(data) {
    const days = Array.isArray(data?.days) ? data.days : [];
    const courtMap = new Map();
    days.forEach((day) =>
      (day.courts || []).forEach((court) =>
        courtMap.set(court.courtId, court.courtName),
      ),
    );
    const courtEntries = [...courtMap.entries()];
    if (!days.length || !courtEntries.length) {
      $("[data-owner-schedule]").innerHTML = emptyState(
        "Nenhuma grade disponível.",
        "Cadastre uma quadra para visualizar a semana.",
      );
      return;
    }
    const columns = `170px repeat(${courtEntries.length}, minmax(150px, 1fr))`;
    let html = `<div class="schedule-week-grid"><span class="head">Dia</span>${courtEntries.map(([, name]) => `<span class="head">${escapeHTML(name)}</span>`).join("")}`;
    days.forEach((day) => {
      const dayLabel = formatDate(`${day.date}T12:00:00-03:00`, {
        weekday: "short",
        day: "2-digit",
        month: "short",
      });
      html += `<button class="week-day-button" type="button" data-week-date="${escapeHTML(day.date)}"><strong>${escapeHTML(dayLabel)}</strong><small>Ver horários</small></button>`;
      courtEntries.forEach(([courtId]) => {
        const court = (day.courts || []).find(
          (item) => item.courtId === courtId,
        );
        const counts = (court?.slots || []).reduce((total, slot) => {
          total[slot.status] = (total[slot.status] || 0) + 1;
          return total;
        }, {});
        html += `<button class="week-summary-cell" type="button" data-week-date="${escapeHTML(day.date)}" aria-label="Abrir grade de ${escapeHTML(dayLabel)}"><strong>${counts.available || 0} livres</strong><span>${counts.booked || 0} reservados · ${counts.recurring || 0} fixos</span></button>`;
      });
    });
    html += "</div>";
    const schedule = $("[data-owner-schedule]");
    schedule.innerHTML = html;
    $(".schedule-week-grid", schedule).style.gridTemplateColumns = columns;
  }

  function renderSchedule(data) {
    if (data?.period === "week") {
      renderWeeklySchedule(data);
      return;
    }
    const courts = Array.isArray(data?.courts) ? data.courts : [];
    if (!courts.length) {
      $("[data-owner-schedule]").innerHTML = emptyState(
        "Nenhuma grade disponível.",
        "Cadastre uma quadra para visualizar os horários.",
      );
      return;
    }
    const times = [
      ...new Set(
        courts.flatMap((court) =>
          (court.slots || []).map(slotTime).filter(Boolean),
        ),
      ),
    ].sort((left, right) => timeToMinutes(left) - timeToMinutes(right));
    if (!times.length) {
      $("[data-owner-schedule]").innerHTML = emptyState(
        "Nenhum horário neste dia.",
        "Confira o funcionamento das quadras ou selecione outra data.",
      );
      return;
    }
    const columns = `100px repeat(${courts.length}, minmax(140px, 1fr))`;
    let html = `<div class="schedule-legend" aria-label="Legenda da grade"><span data-schedule-status="available">Livre</span><span data-schedule-status="booked">Reservado</span><span data-schedule-status="recurring">Fixo</span><span data-schedule-status="blocked">Bloqueado</span></div><div class="schedule-grid"><span class="head">Horário</span>${courts.map((court) => `<span class="head court-name">${escapeHTML(court.courtName)}</span>`).join("")}`;
    times.forEach((time) => {
      html += `<span class="head schedule-time">${escapeHTML(time)}</span>`;
      courts.forEach((court) => {
        const slot = (court.slots || []).find(
          (item) => slotTime(item) === time,
        );
        html += scheduleCell(slot);
      });
    });
    html += "</div>";
    const schedule = $("[data-owner-schedule]");
    schedule.innerHTML = html;
    $(".schedule-grid", schedule).style.gridTemplateColumns = columns;
  }

  function financeQuery() {
    const period = $("[data-finance-period]").value;
    const courtId = $("[data-finance-court]").value;
    const params = new URLSearchParams();
    if (courtId) params.set("courtId", courtId);
    if (period === "custom") {
      const from = $("[data-finance-date-from]").value;
      const to = $("[data-finance-date-to]").value;
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    } else {
      params.set("period", period);
    }
    return params.toString();
  }

  function pendingTotal(bookings) {
    return bookings
      .filter((booking) => booking.paymentStatus === "pending")
      .reduce((total, booking) => total + booking.price, 0);
  }

  function renderFinanceComparison(selector, current, previous) {
    const element = $(selector);
    if (!element) return;
    const currentValue = Number(current || 0);
    const previousValue = Number(previous || 0);
    const percentage = previousValue
      ? ((currentValue - previousValue) / previousValue) * 100
      : currentValue
        ? 100
        : 0;
    const rounded = Math.round(percentage * 10) / 10;
    const sign = rounded > 0 ? "+" : "";
    element.textContent =
      sign +
      rounded.toLocaleString("pt-BR") +
      "% vs. período anterior";
    element.classList.toggle("positive", rounded > 0);
    element.classList.toggle("negative", rounded < 0);
  }

  function renderFinanceCharts(data) {
    const charts = window.QuadrafyCharts;
    if (!charts) return;
    charts.renderLine(
      $("[data-chart-revenue]"),
      data.revenueByDay.map((day) => ({
        label: formatDate(day.date + "T12:00:00-03:00", {
          day: "2-digit",
          month: "short",
        }),
        shortLabel: day.date.slice(8),
        value: day.paidRevenue,
      })),
      {
        label: "Receita paga por dia",
        formatValue: (value) => formatCurrency(value),
      },
    );
    charts.renderBars(
      $("[data-chart-courts]"),
      data.byCourt.map((court) => ({
        label: court.courtName,
        value: court.paidRevenue,
      })),
      {
        label: "Receita paga por quadra",
        formatValue: (value) => formatCurrency(value),
      },
    );
    charts.renderBars(
      $("[data-chart-occupancy]"),
      data.occupancyByCourt.map((court) => ({
        label: court.courtName,
        value: court.occupancyRate,
      })),
      {
        label: "Percentual de ocupação por quadra",
        formatValue: (value) =>
          Number(value).toLocaleString("pt-BR", {
            maximumFractionDigits: 1,
          }) + "%",
      },
    );
    charts.renderDonut(
      $("[data-chart-payments]"),
      data.byPaymentMethod.map((method) => ({
        label: method.label,
        value: method.paidRevenue,
      })),
      {
        label: "Receita por forma de pagamento",
        formatValue: (value) => formatCurrency(value),
      },
    );
  }

  function renderFinance() {
    const data = state.finance;
    $("[data-finance-kpi-revenue]").textContent = formatCurrency(
      data.summary.paidRevenue,
    );
    $("[data-finance-kpi-paid-bookings]").textContent = String(
      data.summary.paidBookings,
    );
    $("[data-finance-kpi-average]").textContent = formatCurrency(
      data.summary.averageTicket,
    );
    $("[data-finance-kpi-pending]").textContent = formatCurrency(
      pendingTotal(data.bookings),
    );
    const previousAverage = data.previousPeriod.paidBookings
      ? data.previousPeriod.paidRevenue / data.previousPeriod.paidBookings
      : 0;
    renderFinanceComparison(
      "[data-finance-compare-revenue]",
      data.summary.paidRevenue,
      data.previousPeriod.paidRevenue,
    );
    renderFinanceComparison(
      "[data-finance-compare-bookings]",
      data.summary.paidBookings,
      data.previousPeriod.paidBookings,
    );
    renderFinanceComparison(
      "[data-finance-compare-average]",
      data.summary.averageTicket,
      previousAverage,
    );
    renderFinanceCharts(data);
    $("[data-finance-by-court]").innerHTML = data.byCourt.length
      ? data.byCourt
          .map(
            (court) =>
              `<article class="finance-court-card"><header><div><h3>${escapeHTML(court.courtName)}</h3><p>${court.paidBookings} ${court.paidBookings === 1 ? "reserva paga" : "reservas pagas"}</p></div><strong>${escapeHTML(formatCurrency(court.paidRevenue))}</strong></header><footer><small>Receita confirmada</small></footer></article>`,
          )
          .join("")
      : emptyState(
          "Nenhuma quadra cadastrada.",
          "Cadastre quadras para acompanhar a receita por espaço.",
        );
    $("[data-finance-table]").innerHTML = data.bookings
      .map(financeRow)
      .join("");
    $("[data-finance-empty]").classList.toggle(
      "hidden",
      data.bookings.length > 0,
    );
  }

  function financeRow(booking) {
    const date = formatDate(booking.startAt, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const method =
      { pix: "Pix", card: "Cartão", venue: "Na arena" }[
        booking.paymentMethod
      ] || booking.paymentMethod;
    return `<tr><td>${escapeHTML(date)}</td><td>${escapeHTML(booking.courtName)}</td><td>${escapeHTML(booking.player?.displayName || "Jogador")}</td><td>${escapeHTML(method)}</td><td>${booking.paymentStatus === "paid" ? "Pago" : "Pendente"}</td><td>${escapeHTML(formatCurrency(booking.price))}</td></tr>`;
  }

  async function loadFinance() {
    try {
      state.finance = await apiRequest(
        `/api/v1/club/finance?${financeQuery()}`,
      );
      renderFinance();
    } catch (error) {
      showToast(error.message);
    }
  }

  function populateFinanceCourtFilter() {
    const select = $("[data-finance-court]");
    const current = select.value;
    select.innerHTML =
      '<option value="">Todas as quadras</option>' +
      state.courts
        .map(
          (court) =>
            `<option value="${escapeHTML(court.id)}">${escapeHTML(court.name)}</option>`,
        )
        .join("");
    if (state.courts.some((court) => court.id === current))
      select.value = current;
  }

  function setupFinance() {
    $("[data-finance-filters]")?.addEventListener("change", () => {
      const custom = $("[data-finance-period]").value === "custom";
      $$("[data-finance-date-field]").forEach((field) =>
        field.classList.toggle("hidden", !custom),
      );
      if (
        !custom ||
        ($("[data-finance-date-from]").value &&
          $("[data-finance-date-to]").value)
      ) {
        loadFinance();
      }
    });
  }

  function populateRecurringCourts() {
    const select = $("[data-recurring-court]");
    if (!select) return;
    const current = select.value;
    const activeCourts = state.courts.filter((court) => court.active);
    select.innerHTML = activeCourts.length
      ? activeCourts
          .map(
            (court) =>
              `<option value="${escapeHTML(court.id)}">${escapeHTML(court.name)}</option>`,
          )
          .join("")
      : '<option value="">Nenhuma quadra ativa</option>';
    if (activeCourts.some((court) => court.id === current))
      select.value = current;
    populateRecurringTimes();
  }

  function populateRecurringTimes() {
    const courtSelect = $("[data-recurring-court]");
    const timeSelect = $("[data-recurring-time]");
    if (!courtSelect || !timeSelect) return;
    const court = state.courts.find(
      (item) => item.id === courtSelect.value && item.active,
    );
    if (!court) {
      timeSelect.innerHTML = '<option value="">Sem horários</option>';
      return;
    }
    const current = timeSelect.value;
    const start = timeToMinutes(courtOpenTime(court));
    const close = timeToMinutes(courtCloseTime(court));
    const duration = courtSlotDuration(court);
    const times = [];
    for (let minute = start; minute + duration <= close; minute += duration) {
      times.push(minutesToTime(minute));
    }
    timeSelect.innerHTML = times.length
      ? times
          .map(
            (time) =>
              `<option value="${time}"${time === current ? " selected" : ""}>${time}</option>`,
          )
          .join("")
      : '<option value="">Sem horários</option>';
  }

  function syncRecurringFrequency() {
    const weekly = $("[data-recurring-frequency]").value === "weekly";
    const weeklyField = $("[data-weekly-day-field]");
    const monthlyField = $("[data-monthly-day-field]");
    const weekday = $("[data-recurring-weekday]");
    const monthday = $("[data-recurring-monthday]");
    weeklyField.classList.toggle("hidden", !weekly);
    monthlyField.classList.toggle("hidden", weekly);
    weekday.disabled = !weekly;
    weekday.required = weekly;
    monthday.disabled = weekly;
    monthday.required = !weekly;
  }

  function openRecurringModal(booking = null) {
    if (!state.courts.some((court) => court.active)) {
      showToast(
        "Ative ou cadastre uma quadra antes de criar uma reserva fixa.",
      );
      return;
    }
    const form = $("[data-recurring-form]");
    state.editingRecurringId = booking?.id || null;
    form.reset();
    populateRecurringCourts();
    const title = $("[data-recurring-modal-title]");
    const description = $("[data-recurring-modal-description]");
    const submit = $("[data-recurring-submit]");
    if (booking) {
      form.elements.clientName.value = booking.clientName || "";
      form.elements.courtId.value = booking.courtId || "";
      populateRecurringTimes();
      form.elements.startTime.value = booking.startTime || "";
      form.elements.frequency.value = booking.recurrence?.frequency || "weekly";
      if (booking.recurrence?.frequency === "monthly") {
        form.elements.dayOfMonth.value = String(
          booking.recurrence.dayOfMonth || 1,
        );
      } else {
        form.elements.dayOfWeek.value = String(
          booking.recurrence?.dayOfWeek ?? 1,
        );
      }
      title.textContent = "Editar reserva fixa.";
      description.textContent =
        "Atualize cliente, quadra, horário ou recorrência. A grade será recalculada ao salvar.";
      submit.textContent = "Salvar alterações";
    } else {
      const referenceDate = new Date(
        `${state.scheduleDate || localDateKey()}T12:00:00`,
      );
      $("[data-recurring-weekday]").value = String(referenceDate.getDay());
      $("[data-recurring-monthday]").value = String(referenceDate.getDate());
      title.textContent = "Nova reserva fixa.";
      description.textContent =
        "O horário ficará indisponível para novas reservas até esta recorrência ser removida.";
      submit.textContent = "Criar reserva fixa";
    }
    syncRecurringFrequency();
    showFormFeedback("[data-recurring-feedback]", "");
    openModal($("[data-recurring-modal]"));
  }

  function recurrenceLabel(recurringBooking) {
    const recurrence = recurringBooking?.recurrence || {};
    const weekdays = [
      "domingo",
      "segunda-feira",
      "terça-feira",
      "quarta-feira",
      "quinta-feira",
      "sexta-feira",
      "sábado",
    ];
    if (recurrence.frequency === "weekly") {
      return `Toda ${weekdays[Number(recurrence.dayOfWeek)] || "semana"}`;
    }
    if (recurrence.frequency === "monthly") {
      return `Todo dia ${Number(recurrence.dayOfMonth)}`;
    }
    return "Recorrência fixa";
  }

  function findRecurringBooking(recurringId) {
    const fromList = (state.schedule?.recurringBookings || []).find(
      (item) => item.id === recurringId,
    );
    if (fromList) return fromList;
    for (const court of state.schedule?.courts || []) {
      for (const slot of court.slots || []) {
        if (recurringIdFromSlot(slot) !== recurringId) continue;
        if (typeof slot.recurringBooking === "object") {
          return {
            ...slot.recurringBooking,
            courtId: slot.recurringBooking.courtId || court.courtId,
            courtName: slot.recurringBooking.courtName || court.courtName,
            startTime: slot.recurringBooking.startTime || slotTime(slot),
          };
        }
      }
    }
    return null;
  }

  function openRecurringDetail(recurringId) {
    const booking = findRecurringBooking(recurringId);
    if (!booking) {
      showToast("Não foi possível localizar esta reserva fixa.");
      return;
    }
    const court = state.courts.find((item) => item.id === booking.courtId);
    state.selectedRecurringId = recurringId;
    $("[data-recurring-detail]").innerHTML =
      `<p class="eyebrow dark">Reserva fixa</p><h2 id="recurring-detail-title">${escapeHTML(booking.clientName)}</h2><div class="match-detail-summary"><div><small>Quadra</small><strong>${escapeHTML(booking.courtName || court?.name || "Quadra")}</strong></div><div><small>Horário</small><strong>${escapeHTML(booking.startTime)}</strong></div><div><small>Recorrência</small><strong>${escapeHTML(recurrenceLabel(booking))}</strong></div></div><p class="modal-description">Edite os dados ou remova a recorrência para liberar os próximos horários.</p>`;
    openModal($("[data-recurring-detail-modal]"));
  }

  function editSelectedRecurringBooking() {
    const booking = findRecurringBooking(state.selectedRecurringId);
    if (!booking) {
      showToast("Não foi possível localizar esta reserva fixa.");
      return;
    }
    closeModal($("[data-recurring-detail-modal]"));
    openRecurringModal(booking);
  }

  async function removeRecurringBooking() {
    const recurringId = state.selectedRecurringId;
    if (!recurringId) return;
    if (!window.confirm("Remover esta reserva fixa da grade?")) return;
    const button = $("[data-remove-recurring]");
    button.disabled = true;
    button.textContent = "Removendo...";
    try {
      await apiRequest(
        `/api/v1/club/recurring-bookings/${encodeURIComponent(recurringId)}`,
        { method: "DELETE" },
      );
      closeModal($("[data-recurring-detail-modal]"));
      state.selectedRecurringId = null;
      await loadSchedule();
      showToast("Reserva fixa removida. O horário voltou a ficar disponível.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Remover reserva fixa";
    }
  }

  function setupRecurringBookings() {
    $("[data-recurring-monthday]").innerHTML = Array.from(
      { length: 31 },
      (_, index) => `<option value="${index + 1}">${index + 1}</option>`,
    ).join("");
    $("[data-recurring-court]")?.addEventListener(
      "change",
      populateRecurringTimes,
    );
    $("[data-recurring-frequency]")?.addEventListener(
      "change",
      syncRecurringFrequency,
    );
    $("[data-add-recurring]")?.addEventListener("click", () =>
      openRecurringModal(),
    );
    $("[data-new-booking]")?.addEventListener("click", () =>
      openRecurringModal(),
    );
    $("[data-recurring-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.checkValidity()) return form.reportValidity();
      const values = Object.fromEntries(new FormData(form).entries());
      const recurrence =
        values.frequency === "weekly"
          ? {
              frequency: "weekly",
              dayOfWeek: Number(values.dayOfWeek),
            }
          : {
              frequency: "monthly",
              dayOfMonth: Number(values.dayOfMonth),
            };
      const button = $("[data-recurring-submit]");
      const editingId = state.editingRecurringId;
      button.disabled = true;
      showFormFeedback("[data-recurring-feedback]", "");
      try {
        await apiRequest(
          editingId
            ? `/api/v1/club/recurring-bookings/${encodeURIComponent(editingId)}`
            : `/api/v1/club/courts/${encodeURIComponent(values.courtId)}/recurring-bookings`,
          {
            method: editingId ? "PATCH" : "POST",
            body: {
              ...(editingId ? { courtId: values.courtId } : {}),
              clientName: values.clientName,
              startTime: values.startTime,
              recurrence,
            },
          },
        );
        closeModal($("[data-recurring-modal]"));
        state.editingRecurringId = null;
        state.selectedRecurringId = null;
        await loadSchedule();
        showToast(
          editingId
            ? "Reserva fixa atualizada e grade recalculada."
            : "Reserva fixa criada e horário bloqueado na grade.",
        );
      } catch (error) {
        showFormFeedback("[data-recurring-feedback]", error.message);
      } finally {
        button.disabled = false;
      }
    });
    $("[data-remove-recurring]")?.addEventListener(
      "click",
      removeRecurringBooking,
    );
    $("[data-edit-recurring]")?.addEventListener(
      "click",
      editSelectedRecurringBooking,
    );
    $("[data-owner-schedule]")?.addEventListener("click", (event) => {
      const cell = event.target.closest("[data-recurring-id]");
      if (cell) openRecurringDetail(cell.dataset.recurringId);
    });
    $("[data-owner-schedule]")?.addEventListener("keydown", (event) => {
      const cell = event.target.closest("[data-recurring-id]");
      if (!cell || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      openRecurringDetail(cell.dataset.recurringId);
    });
  }

  function setupSecondaryActions() {
    $("[data-preview-arena]")?.addEventListener("click", () =>
      showGenericModal({
        eyebrow: "Arena publicada",
        title: state.club?.name || "Sua arena",
        text: state.courts.length
          ? "Sua arena já aparece para os jogadores com as quadras ativas."
          : "Cadastre uma quadra para que a arena apareça aos jogadores.",
      }),
    );
    $("[data-schedule-today]")?.addEventListener("click", () => {
      state.scheduleDate = localDateKey();
      loadSchedule();
    });
    $$("[data-schedule-period]").forEach((button) =>
      button.addEventListener("click", () => {
        state.schedulePeriod = button.dataset.schedulePeriod;
        loadSchedule();
      }),
    );
    $("[data-owner-schedule]")?.addEventListener("click", (event) => {
      const target = event.target.closest("[data-week-date]");
      if (!target) return;
      state.scheduleDate = target.dataset.weekDate;
      state.schedulePeriod = "day";
      loadSchedule();
    });
    $("[data-schedule-previous]")?.addEventListener("click", () =>
      moveScheduleDate(-1),
    );
    $("[data-schedule-next]")?.addEventListener("click", () =>
      moveScheduleDate(1),
    );
    $("[data-schedule-date-input]")?.addEventListener("change", (event) => {
      if (!event.currentTarget.value) return;
      state.scheduleDate = event.currentTarget.value;
      loadSchedule();
    });
  }

  function moveScheduleDate(days) {
    const date = state.scheduleDate
      ? new Date(`${state.scheduleDate}T12:00:00`)
      : new Date();
    date.setDate(
      date.getDate() + days * (state.schedulePeriod === "week" ? 7 : 1),
    );
    state.scheduleDate = localDateKey(date);
    loadSchedule();
  }

  async function refreshDashboard() {
    state.session = await loadDashboard("club");
    if (!state.session) return false;
    state.club = state.session.club;
    state.courts = state.session.courts || [];
    await loadBookings();
    renderDashboardSummary(state.session.summary);
    renderArena();
    populateFinanceCourtFilter();
    return true;
  }

  async function initialize() {
    setupTabs();
    setupSuper8();
    setupCourtModal();
    setupBookingActions();
    setupClubSettings();
    setupFinance();
    setupRecurringBookings();
    setupSecondaryActions();
    if (!(await refreshDashboard())) return;
    if (state.courts.length === 0) openManagement();
    hydrateIcons();
  }

  initialize();
})();
