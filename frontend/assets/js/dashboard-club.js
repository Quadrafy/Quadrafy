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
    openCropModal,
    openModal,
    showGenericModal,
    showToast,
    uploadImage,
    validateImageFile,
  } = window.Padelfy;

  const state = {
    session: null,
    club: null,
    arenas: [],
    courts: [],
    bookings: [],
    finance: null,
    scheduleDate: null,
    schedulePeriod: "day",
    schedule: null,
    editingCourtId: null,
    editingDurationWindows: [],
    editingBlockedWindows: [],
    clubPreviewObjectUrl: null,
    clubCroppedFile: null,
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

  function courtSlotDurations(court) {
    if (Array.isArray(court.durationWindows) && court.durationWindows.length) {
      return [...new Set(court.durationWindows.map((w) => Number(w.duration)))].sort(
        (a, b) => a - b,
      );
    }
    return Array.isArray(court.slotDurations) && court.slotDurations.length
      ? court.slotDurations.map(Number).sort((a, b) => a - b)
      : [Number(court.slotDuration || court.slotDurationMinutes || 90)];
  }

  function courtSlotDuration(court) {
    return Math.min(...courtSlotDurations(court));
  }

  function safePhotoUrl(value) {
    const url = String(value || "").trim();
    if (!url) return "";
    const uploadedImage =
      /^\/uploads\/(?:players|clubs|courts)\/[a-f0-9-]+\.(?:jpe?g|png|webp)$/i;
    if (/^\/assets\/[a-z0-9/_\-.]+$/i.test(url)) return url;
    try {
      const parsed = new URL(url, location.origin);
      if (
        parsed.origin === location.origin &&
        uploadedImage.test(parsed.pathname)
      ) {
        return `${parsed.pathname}${parsed.search}`;
      }
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
    cancelado: "Cancelado",
  };

  // TASK-95 — data + horário do torneio, formatados para exibição.
  const SUPER8_GENDER_LABELS = {
    women_only: "Só mulheres",
    men_only: "Só homens",
    mixed: "Misto obrigatório",
  };

  const LEVEL_CATEGORY_SHORT = {
    "Iniciante": "7ª",
    "Iniciante Intermediário": "6ª",
    "Intermediário": "5ª",
    "Intermediário Avançado": "4ª",
    "Avançado": "3ª",
    "Avançado Elevado": "2ª",
    "Elite": "Open",
  };

  function super8DateTimeLabel(tournament) {
    const parts = [];
    if (tournament.date) {
      const iso = `${tournament.date}T12:00:00-03:00`;
      const dateStr = formatDate(iso, { day: "numeric", month: "numeric" });
      const weekdayRaw = formatDate(iso, { weekday: "short" });
      const weekday = weekdayRaw.replace(/\.$/, "");
      const weekdayCap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
      parts.push(`${dateStr} · ${weekdayCap}`);
    }
    if (tournament.startTime) parts.push(tournament.startTime);
    return parts.length ? parts.join(" · ") : "Data a definir";
  }

  function super8CourtsSummary(tournament) {
    const count = tournament.courts?.length || 0;
    if (!count) return "Quadra a definir";
    return count === 1 ? tournament.courts[0].name : `${count} quadras`;
  }

  // TASK-94 — hierarquia visual clara: contador de jogadores em destaque no
  // canto superior direito, corpo com nome/modalidade/categorias, rodapé
  // com data/horário e quadras (mesmo padrão de qualidade do .match-card).
  const SUPER8_GENDER_CHIP_LABELS = {
    women_only: "Só mulheres",
    men_only: "Só homens",
    mixed: "Misto",
  };

  function super8Card(tournament) {
    const modeLabel =
      tournament.mode === "duplas_fixas" ? "Duplas Fixas" : "Rotação";
    const statusLabel =
      SUPER8_STATUS_LABELS[tournament.status] || tournament.status;
    const levelShort = tournament.levelCategories?.length
      ? tournament.levelCategories.map((c) => LEVEL_CATEGORY_SHORT[c] ?? c).join(", ")
      : "Todas";
    const levelChip = `<span class="super8-level-chip">Cat. ${escapeHTML(levelShort)}</span>`;
    const genderLabel = SUPER8_GENDER_CHIP_LABELS[tournament.genderCategory];
    const genderChip = genderLabel
      ? `<span class="super8-level-chip gender-chip gender-${escapeHTML(tournament.genderCategory)}">${escapeHTML(genderLabel)}</span>`
      : "";
    const players = tournament.players || [];
    const visiblePlayers = players.slice(0, 4);
    const overflow = players.length - 4;
    const playerBubbles = visiblePlayers.map((p) => {
      const url = safePhotoUrl(p.photoUrl);
      const pname = p.name || "Jogador";
      const initials = String(pname).trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 2);
      return url
        ? `<span class="super8-player-bubble" style="background-image:url('${escapeHTML(url)}')" aria-label="${escapeHTML(pname)}"></span>`
        : `<span class="super8-player-bubble super8-player-bubble-initials" aria-label="${escapeHTML(pname)}">${escapeHTML(initials)}</span>`;
    }).join("");
    const overflowBubble = overflow > 0 ? `<span class="super8-player-overflow">+${overflow}</span>` : "";
    return `<article class="super8-card card-hover" data-super8-open="${escapeHTML(tournament.id)}" tabindex="0" role="button" aria-label="Abrir torneio ${escapeHTML(tournament.name)}">
      <div class="super8-card-header">
        <span class="super8-card-datetime">${escapeHTML(super8DateTimeLabel(tournament))}</span>
        <span class="status-badge super8-status-${escapeHTML(tournament.status)}">${escapeHTML(statusLabel)}</span>
      </div>
      <p class="super8-card-format">Super ${tournament.size} · ${escapeHTML(modeLabel)}</p>
      <h3>${escapeHTML(tournament.name)}</h3>
      <div class="super8-card-meta">
        <div class="super8-level-chips">${levelChip}${genderChip}</div>
        <div class="super8-card-players">${playerBubbles}${overflowBubble}<span class="super8-players-count">${players.length}/${tournament.size}</span></div>
      </div>
      <div class="super8-card-footer">
        <span>${escapeHTML(super8CourtsSummary(tournament))}</span>
        <span class="super8-card-cta">Gerenciar →</span>
      </div>
    </article>`;
  }

  // TASK-51 — arenas adicionais do clube.
  async function loadArenas() {
    try {
      const data = await apiRequest("/api/v1/club/arenas");
      state.arenas = data.arenas || [];
    } catch {
      state.arenas = [];
    }
    renderArenaSelect();
  }

  // seletor de arena no formulário de quadra (aparece só com arenas extras)
  function renderArenaSelect() {
    const wrapper = $("[data-court-arena-wrapper]");
    const select = $("[data-court-arena-select]");
    if (!wrapper || !select) return;
    if (!state.arenas.length) {
      wrapper.classList.add("hidden");
      select.innerHTML = "";
      return;
    }
    wrapper.classList.remove("hidden");
    select.innerHTML =
      `<option value="">${escapeHTML(state.club?.name || "Arena principal")}</option>` +
      state.arenas
        .map(
          (arena) =>
            `<option value="${escapeHTML(arena.id)}">${escapeHTML(arena.name)}</option>`,
        )
        .join("");
  }

  function openArenaModal() {
    const form = $("[data-arena-form]");
    form.reset();
    openModal($("[data-arena-modal]"));
    requestAnimationFrame(() => form.elements.name.focus());
  }

  async function saveArena(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const button = $("[data-arena-submit]", form);
    button.disabled = true;
    try {
      await apiRequest("/api/v1/club/arenas", {
        method: "POST",
        body: {
          name: form.elements.name.value.trim(),
          address: form.elements.address.value.trim(),
        },
      });
      closeModal($("[data-arena-modal]"));
      showToast("Arena criada. Cadastre quadras vinculadas a ela.");
      await loadArenas();
      renderArena();
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function switchSuper8Tab(tab) {
    $$("[data-s8tab]").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.s8tab === tab),
    );
    $$("[data-s8view]").forEach((view) =>
      view.classList.toggle("hidden", view.dataset.s8view !== tab),
    );
  }

  function wireSuper8Cards(container) {
    $$("[data-super8-open]", container).forEach((card) => {
      const open = () => openSuper8Detail(card.dataset.super8Open);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  async function loadSuper8() {
    const openGrid = $("[data-super8-grid]");
    const confirmedGrid = $("[data-super8-confirmed-grid]");
    const historyGrid = $("[data-super8-history-grid]");
    if (!openGrid) return;
    try {
      const data = await apiRequest("/api/v1/club/super8");
      super8State.tournaments = data.tournaments;
      const openList = data.tournaments.filter((t) => {
        if (t.status === "inscricoes_abertas") return true;
        if (t.status === "em_configuracao") return t.players.length < t.size;
        return false;
      });
      const confirmedList = data.tournaments.filter((t) => {
        if (["gerado", "em_andamento"].includes(t.status)) return true;
        if (t.status === "em_configuracao") return t.players.length >= t.size;
        return false;
      });
      const historyList = data.tournaments.filter((t) =>
        ["finalizado", "cancelado"].includes(t.status),
      );
      const navBadge = $("[data-super8-nav-count]");
      const totalActive = openList.length + confirmedList.length;
      if (navBadge) {
        navBadge.textContent = String(totalActive);
        navBadge.classList.toggle("hidden", totalActive === 0);
      }
      const openCount = $("[data-s8-open-count]");
      if (openCount) {
        openCount.textContent = String(openList.length);
        openCount.classList.toggle("hidden", openList.length === 0);
      }
      const confirmedCount = $("[data-s8-confirmed-count]");
      if (confirmedCount) {
        confirmedCount.textContent = String(confirmedList.length);
        confirmedCount.classList.toggle("hidden", confirmedList.length === 0);
      }
      openGrid.innerHTML = openList.length
        ? openList.map(super8Card).join("")
        : `<p class="profile-data-note">Nenhum Super 8 em aberto. Clique em "Criar novo Super 8" para montar o primeiro torneio.</p>`;
      confirmedGrid.innerHTML = confirmedList.length
        ? confirmedList.map(super8Card).join("")
        : `<p class="profile-data-note">Nenhum Super 8 confirmado ainda.</p>`;
      historyGrid.innerHTML = historyList.length
        ? historyList.map(super8Card).join("")
        : `<p class="profile-data-note">Nenhum torneio finalizado ainda.</p>`;
      wireSuper8Cards(openGrid);
      wireSuper8Cards(confirmedGrid);
      wireSuper8Cards(historyGrid);
    } catch (error) {
      openGrid.innerHTML = `<p class="profile-data-note">${escapeHTML(error.message)}</p>`;
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
    const playerCount = super8State.players.length;
    const container = $("[data-super8-pairs]");
    if (playerCount < 2) {
      container.innerHTML = `<p class="profile-data-note">Adicione ao menos 2 jogadores para montar as duplas.</p>`;
      return;
    }
    // Preserve existing pair selections before re-rendering.
    const prevValues = $$("[data-super8-pair-slot]").map((s) => Number(s.value));
    const pairCount = Math.floor(playerCount / 2);
    const options = (selected) =>
      super8State.players
        .map(
          (player, index) =>
            `<option value="${index}"${index === selected ? " selected" : ""}>${escapeHTML(player.name)}</option>`,
        )
        .join("");
    let html = Array.from({ length: pairCount }, (_, pairIndex) => {
      const defaultA = pairIndex * 2;
      const defaultB = pairIndex * 2 + 1;
      const prevA = prevValues[pairIndex * 2];
      const prevB = prevValues[pairIndex * 2 + 1];
      const selA = prevA !== undefined && prevA < playerCount ? prevA : defaultA;
      const selB = prevB !== undefined && prevB < playerCount ? prevB : defaultB;
      return `<div class="super8-pair-row"><span class="result-set-label">Dupla ${pairIndex + 1}</span><select data-super8-pair-slot>${options(selA)}</select><span class="result-set-x" aria-hidden="true">+</span><select data-super8-pair-slot>${options(selB)}</select></div>`;
    }).join("");
    if (playerCount % 2 !== 0) {
      html += `<p class="profile-data-note">Adicione mais 1 jogador para completar a próxima dupla.</p>`;
    }
    if (playerCount < size) {
      const remaining = size - playerCount;
      html += `<p class="profile-data-note">Faltam ${remaining} jogador${remaining !== 1 ? "es" : ""} — as duplas restantes serão definidas depois.</p>`;
    }
    container.innerHTML = html;
  }

  function shuffleSuper8Pairs() {
    const playerCount = super8State.players.length;
    if (playerCount < 2) {
      showToast("Adicione ao menos 2 jogadores para sortear duplas.");
      return;
    }
    const usable = playerCount % 2 === 0 ? playerCount : playerCount - 1;
    const indexes = Array.from({ length: usable }, (_, i) => i);
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
    $("[data-super8-categories-grid]").classList.add("hidden");
    $("[data-super8-date]").min = localDateKey();
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
    // TASK-74: o quadro é totalmente opcional na criação — pode ficar 100%
    // em aberto, parcial (misturando manual + inscrição espontânea depois)
    // ou completo, em qualquer modalidade.
    const isFull = super8State.players.length === size;
    const courtIds = $$('[data-super8-courts] input:checked', form).map(
      (input) => input.value,
    );
    if (!courtIds.length) {
      note.textContent = "Selecione ao menos uma quadra para o torneio.";
      return;
    }
    let pairs = null;
    if (isFixed && isFull) {
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
          // TASK-95: data do evento (dia dos jogos)
          date: form.elements.date.value || null,
          // TASK-59: horário de início do EVENTO (convocação)
          startTime: form.elements.startTime.value || null,
          // TASK-77: categorias de nível permitidas (null = todas)
          levelCategories: readSuper8LevelCategories(form),
          genderCategory: form.elements.genderCategory?.value || "all",
        },
      });
      await apiRequest(
        `/api/v1/club/super8/${encodeURIComponent(tournament.id)}/courts`,
        { method: "PATCH", body: { courtIds } },
      );
      let latest = tournament;
      if (isFull) {
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
      button.textContent = "Criar torneio";
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
    const tabForStatus =
      ["finalizado", "cancelado"].includes(tournament.status)
        ? "history"
        : ["gerado", "em_andamento"].includes(tournament.status) ||
            (tournament.status === "em_configuracao" &&
              tournament.players.length >= tournament.size)
          ? "confirmed"
          : "open";
    switchSuper8Tab(tabForStatus);
    const isHistory = ["finalizado", "cancelado"].includes(tournament.status);
    $("[data-super8-detail-title]").textContent = tournament.name;
    // Editar: visível fora do histórico. Cancelar: idem.
    $("[data-super8-edit-open]").classList.toggle("hidden", isHistory);
    const statusLabel =
      SUPER8_STATUS_LABELS[tournament.status] || tournament.status;
    const modeLabel =
      tournament.mode === "duplas_fixas" ? "Duplas fixas" : "Rotação";
    const games = tournament.games || [];
    const waiting = games.filter((game) => game.status !== "finalizado");
    const finished = games.filter((game) => game.status === "finalizado");
    const progressPercent = games.length
      ? Math.round((finished.length / games.length) * 100)
      : 0;

    // TASK-74: quadro completo, duplas fixas ainda não definidas (vagas
    // preenchidas via inscrição espontânea/manual depois da criação).
    const needsPairs =
      tournament.mode === "duplas_fixas" &&
      tournament.status === "em_configuracao" &&
      tournament.players.length === tournament.size &&
      !tournament.pairs &&
      !games.length;

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
      tournament.players.length < tournament.size
    ) {
      primaryAction = `<button class="button button-primary button-block" type="button" data-super8-open-registrations>Abrir inscrições (${tournament.size - tournament.players.length} vagas)</button>`;
    } else if (tournament.status === "inscricoes_abertas") {
      primaryAction = `<p class="profile-data-note">Inscrições abertas — ${tournament.players.length}/${tournament.size} jogadores. As inscrições fecham e o bracket é gerado automaticamente quando o quadro completar.</p>`;
    } else if (
      tournament.status === "em_configuracao" &&
      tournament.players.length === tournament.size &&
      !needsPairs &&
      !games.length
    ) {
      primaryAction =
        '<button class="button button-primary button-block shine" type="button" data-super8-generate>Gerar confrontos</button>';
    }
    const rosterPanel = ["em_configuracao", "inscricoes_abertas"].includes(
      tournament.status,
    )
      ? `<div class="super8-section"><p class="micro-label">Jogadores (${tournament.players.length}/${tournament.size})</p>${
          tournament.players.length
            ? `<div class="super8-player-chips">${tournament.players.map((player) => `<span class="super8-chip">${escapeHTML(player.name)}${player.id ? "" : ' <em title="Convidado sem conta">convidado</em>'}</span>`).join("")}</div>`
            : '<p class="profile-data-note">Nenhum jogador ainda.</p>'
        }</div>`
      : "";
    const pairsPanel = needsPairs
      ? `<div class="super8-section"><p class="micro-label">Definir duplas</p><p class="profile-data-note">O quadro completou — defina as duplas fixas antes de gerar os confrontos.</p><div class="super8-pairs" data-super8-detail-pairs></div><div class="super8-pairs-actions"><button class="button button-outline" type="button" data-super8-detail-shuffle>Sortear duplas</button><button class="button button-primary shine" type="button" data-super8-detail-pairs-save>Salvar duplas e gerar confrontos</button></div><p class="auth-feedback hidden" role="alert" aria-live="polite" data-super8-detail-pairs-note></p></div>`
      : "";

    // TASK-77 — categorias permitidas (null = todas).
    const categoriesLabel = tournament.levelCategories
      ? tournament.levelCategories.map((c) => LEVEL_CATEGORY_SHORT[c] ?? c).join(", ")
      : "Todas as categorias";
    const genderLabel = SUPER8_GENDER_LABELS[tournament.genderCategory] ?? "Todos";
    // TASK-76 — quadras do torneio, visíveis também para o clube conferir
    // o que os jogadores estão vendo.
    const courtsLabel = tournament.courts?.length
      ? tournament.courts.map((court) => escapeHTML(court.name)).join(", ")
      : "A definir";
    const dateLabel = tournament.date
      ? escapeHTML(super8DateTimeLabel({ date: tournament.date, startTime: null }))
      : "A definir";

    $("[data-super8-detail-content]").innerHTML = `
      <div class="super8-datetime-highlight"><div><small>Data</small><strong>${dateLabel}</strong></div><div><small>Horário de início</small><strong>${tournament.startTime ? escapeHTML(tournament.startTime) : "A definir"}</strong></div></div>
      <div class="match-detail super8-meta"><div><small>Status</small><strong>${escapeHTML(statusLabel)}</strong></div><div><small>Formato</small><strong>Super ${tournament.size}</strong></div><div><small>Modalidade</small><strong>${escapeHTML(modeLabel)}</strong></div><div><small>Gênero</small><strong>${escapeHTML(genderLabel)}</strong></div><div><small>Jogadores</small><strong>${tournament.players.length}/${tournament.size}</strong></div><div><small>Categorias</small><strong>${escapeHTML(categoriesLabel)}</strong></div><div><small>Quadras</small><strong>${courtsLabel}</strong></div></div>
      ${rosterPanel}
      ${pairsPanel}
      ${games.length ? `<div class="super8-progress"><div class="super8-progress-head"><span>${finished.length} de ${games.length} jogos finalizados</span><strong>${progressPercent}%</strong></div><div class="confidence-bar" aria-hidden="true"><span style="width:${progressPercent}%"></span></div></div>` : ""}
      ${super8StandingsTable(tournament)}
      ${waiting.length ? `<div class="super8-section"><p class="micro-label">Aguardando resultado (${waiting.length})</p><div class="super8-games">${waiting.map((game) => super8GameCard(game, tournament)).join("")}</div></div>` : ""}
      ${finished.length ? `<div class="super8-section"><p class="micro-label">Finalizados (${finished.length})</p><div class="super8-games">${finished.map((game) => super8GameCard(game, tournament)).join("")}</div></div>` : ""}
      ${primaryAction}
      ${!isHistory ? `<button class="button button-danger button-block" style="margin-top:8px" type="button" data-super8-cancel>Cancelar torneio</button>` : ""}`;

    $("[data-super8-publish]")?.addEventListener("click", publishSuper8);
    $("[data-super8-finalize]")?.addEventListener("click", finalizeSuper8);
    $("[data-super8-generate]")?.addEventListener("click", generateSuper8);
    $("[data-super8-open-registrations]")?.addEventListener(
      "click",
      openSuper8Registrations,
    );
    $("[data-super8-cancel]")?.addEventListener("click", cancelSuper8);
    $$("[data-super8-result]").forEach((button) =>
      button.addEventListener("click", () =>
        openSuper8ResultForm(button.dataset.super8Result),
      ),
    );
    if (needsPairs) setupDetailPairsForm(tournament);
    openModal($("[data-super8-detail-modal]"));
  }

  // TASK-74 — monta o formulário de duplas fixas dentro da tela de detalhe,
  // usado quando o quadro completou depois da criação (vagas abertas).
  function renderDetailPairsOptions(players, selected) {
    return players
      .map(
        (player, index) =>
          `<option value="${index}"${index === selected ? " selected" : ""}>${escapeHTML(player.name)}</option>`,
      )
      .join("");
  }

  function setupDetailPairsForm(tournament) {
    const container = $("[data-super8-detail-pairs]");
    const players = tournament.players;
    const size = tournament.size;
    const renderRows = () => {
      container.innerHTML = Array.from({ length: size / 2 }, (_, pairIndex) => {
        const a = pairIndex * 2;
        const b = pairIndex * 2 + 1;
        return `<div class="super8-pair-row"><span class="result-set-label">Dupla ${pairIndex + 1}</span><select data-super8-detail-pair-slot>${renderDetailPairsOptions(players, a)}</select><span class="super8-x" aria-hidden="true">+</span><select data-super8-detail-pair-slot>${renderDetailPairsOptions(players, b)}</select></div>`;
      }).join("");
    };
    renderRows();
    $("[data-super8-detail-shuffle]")?.addEventListener("click", () => {
      const indexes = players.map((_, index) => index);
      for (let i = indexes.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
      }
      $$("[data-super8-detail-pair-slot]").forEach((select, position) => {
        select.value = String(indexes[position]);
      });
    });
    $("[data-super8-detail-pairs-save]")?.addEventListener("click", async () => {
      const note = $("[data-super8-detail-pairs-note]");
      note.classList.add("hidden");
      note.textContent = "";
      const values = $$("[data-super8-detail-pair-slot]").map((select) =>
        Number(select.value),
      );
      if (new Set(values).size !== values.length) {
        note.textContent =
          "Cada jogador deve aparecer em exatamente uma dupla — revise as duplas.";
        note.classList.remove("hidden");
        return;
      }
      const pairs = [];
      for (let index = 0; index < values.length; index += 2) {
        pairs.push([values[index], values[index + 1]]);
      }
      const button = $("[data-super8-detail-pairs-save]");
      button.disabled = true;
      try {
        await apiRequest(
          `/api/v1/club/super8/${encodeURIComponent(tournament.id)}/pairs`,
          { method: "PATCH", body: { pairs } },
        );
        await callSuper8Action("generate", "Duplas salvas e confrontos gerados.");
      } catch (error) {
        note.textContent = error.message;
        note.classList.remove("hidden");
      } finally {
        button.disabled = false;
      }
    });
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

  // TASK-63 — fecha inscrições a qualquer momento (volta a configuração).
  async function closeSuper8Registrations() {
    try {
      await callSuper8Action(
        "close-registrations",
        "Inscrições fechadas.",
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

  async function cancelSuper8() {
    if (!confirm("Tem certeza que deseja cancelar este torneio? Ele irá para o histórico como cancelado.")) return;
    try {
      await apiRequest(
        `/api/v1/club/super8/${encodeURIComponent(super8State.current.id)}/cancel`,
        { method: "POST" },
      );
      showToast("Torneio cancelado.");
      closeModal($("[data-super8-detail-modal]"));
      await loadSuper8();
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
    $$("[data-s8tab]").forEach((btn) =>
      btn.addEventListener("click", () => switchSuper8Tab(btn.dataset.s8tab)),
    );
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
    // TASK-77 — mostra as categorias específicas só quando "todas" é
    // desmarcada.
    $("[data-super8-categories-all]")?.addEventListener("change", (event) => {
      $("[data-super8-categories-grid]").classList.toggle(
        "hidden",
        event.currentTarget.checked,
      );
    });
    setupSuper8EditModal();
  }

  function readSuper8LevelCategories(form) {
    if ($("[data-super8-categories-all]", form).checked) return null;
    const selected = $$('[name="levelCategories"]:checked', form).map(
      (input) => input.value,
    );
    return selected.length ? selected : null;
  }

  // TASK-90 — edição do torneio já publicado/com inscrições abertas.
  const SUPER8_LOCKED_STATUSES = ["gerado", "em_andamento", "finalizado"];
  // Confirmado = bracket gerado (ou quadro completo): só data e hora editáveis.
  function isSuper8Confirmed(tournament) {
    return (
      ["gerado", "em_andamento"].includes(tournament.status) ||
      (tournament.status === "em_configuracao" &&
        tournament.players.length >= tournament.size)
    );
  }

  function populateSuper8EditTimeOptions() {
    const select = $("[data-super8-edit-start-time]");
    if (!select) return;
    const options = Array.from({ length: 48 }, (_, index) =>
      minutesToTime(index * 30),
    )
      .map((time) => `<option value="${time}">${time}</option>`)
      .join("");
    select.innerHTML = `<option value="">Sem horário definido</option>${options}`;
  }

  function readSuper8EditLevelCategories() {
    if ($("[data-super8-edit-categories-all]").checked) return null;
    const selected = $$(
      '[data-super8-edit-categories-grid] input[name="editLevelCategories"]:checked',
    ).map((input) => input.value);
    return selected.length ? selected : null;
  }

  function setSuper8EditLevelCategories(levelCategories) {
    const hasRestriction = Boolean(levelCategories?.length);
    $("[data-super8-edit-categories-all]").checked = !hasRestriction;
    $("[data-super8-edit-categories-grid]").classList.toggle(
      "hidden",
      !hasRestriction,
    );
    $$(
      '[data-super8-edit-categories-grid] input[name="editLevelCategories"]',
    ).forEach((input) => {
      input.checked =
        hasRestriction && levelCategories.includes(input.value);
    });
  }

  // TASK-93 — jogadores adicionados aqui entram direto no torneio (uma
  // chamada por adição); remoção continua fora do escopo (regra da TASK-90).
  function renderSuper8EditPlayers() {
    const tournament = super8State.current;
    if (!tournament) return;
    $("[data-super8-edit-player-count]").textContent =
      `${tournament.players.length}/${tournament.size}`;
    const container = $("[data-super8-edit-players]");
    container.innerHTML = tournament.players.length
      ? tournament.players
          .map(
            (player) =>
              `<span class="super8-chip">${escapeHTML(player.name)}${player.id ? "" : ' <em title="Convidado sem conta">convidado</em>'}</span>`,
          )
          .join("")
      : '<p class="profile-data-note">Nenhum jogador adicionado ainda.</p>';
  }

  async function addSuper8EditPlayer(player) {
    const tournament = super8State.current;
    if (!tournament) return;
    if (tournament.players.length >= tournament.size) {
      showToast(`O torneio comporta ${tournament.size} jogadores.`);
      return;
    }
    try {
      const { tournament: updated } = await apiRequest(
        `/api/v1/club/super8/${encodeURIComponent(tournament.id)}/players`,
        { method: "POST", body: { players: [player] } },
      );
      super8State.current = updated;
      const index = super8State.tournaments.findIndex(
        (item) => item.id === updated.id,
      );
      if (index >= 0) super8State.tournaments[index] = updated;
      renderSuper8EditPlayers();
      showToast("Jogador adicionado.");
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderSuper8EditSearchResults(players) {
    const box = $("[data-super8-edit-search-results]");
    if (!players.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = players
      .map(
        (player) =>
          `<button type="button" data-super8-edit-pick="${escapeHTML(player.id)}" data-player-name="${escapeHTML(player.displayName)}"><strong>${escapeHTML(player.displayName)}</strong><small>${player.level !== null ? `Nível ${Number(player.level).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "Sem nível"}${player.city ? ` · ${escapeHTML(player.city)}` : ""}</small></button>`,
      )
      .join("");
    $$("[data-super8-edit-pick]", box).forEach((button) =>
      button.addEventListener("click", () => {
        addSuper8EditPlayer({
          id: button.dataset.super8EditPick,
          name: button.dataset.playerName,
        });
        $("[data-super8-edit-search]").value = "";
        box.classList.add("hidden");
      }),
    );
  }

  function setupSuper8EditSearch() {
    const input = $("[data-super8-edit-search]");
    input?.addEventListener("input", () => {
      clearTimeout(super8State.editSearchTimer);
      const query = input.value.trim();
      if (query.length < 2) {
        renderSuper8EditSearchResults([]);
        return;
      }
      super8State.editSearchTimer = setTimeout(async () => {
        try {
          const data = await apiRequest(
            `/api/v1/players/search?q=${encodeURIComponent(query)}`,
          );
          renderSuper8EditSearchResults(data.players || []);
        } catch {
          renderSuper8EditSearchResults([]);
        }
      }, 250);
    });
    $("[data-super8-edit-add-guest]")?.addEventListener("click", () => {
      const input = $("[data-super8-edit-guest-name]");
      const name = input.value.trim();
      if (name.length < 2) {
        showToast("Digite o nome do convidado.");
        return;
      }
      addSuper8EditPlayer({ id: null, name });
      input.value = "";
    });
  }

  function openSuper8EditModal() {
    const tournament = super8State.current;
    if (!tournament) return;
    const form = $("[data-super8-edit-form]");
    form.reset();
    form.elements.name.value = tournament.name;
    $("[data-super8-edit-date]").min = localDateKey();
    $("[data-super8-edit-date]").value = tournament.date || "";
    $("[data-super8-edit-start-time]").value = tournament.startTime || "";
    const editGender = $("[data-super8-edit-gender]");
    if (editGender) editGender.value = tournament.genderCategory ?? "all";
    setSuper8EditLevelCategories(tournament.levelCategories);
    showFormFeedback("[data-super8-edit-feedback]", "");
    $("[data-super8-edit-confirm]").classList.add("hidden");

    const confirmed = isSuper8Confirmed(tournament);
    const locked = confirmed || SUPER8_LOCKED_STATUSES.includes(tournament.status);
    const nameInput = $("[data-super8-edit-form] [name='name']");
    const nameField = nameInput?.closest(".input-group");
    const genderField = $("[data-super8-edit-gender]")?.closest(".input-group");
    if (nameField) nameField.classList.toggle("hidden", confirmed);
    if (genderField) genderField.classList.toggle("hidden", locked);
    $("[data-super8-edit-locked-note]").hidden = !confirmed;
    $("[data-super8-edit-locked-note]").textContent = confirmed
      ? "Torneio confirmado — apenas data e horário de início podem ser alterados."
      : "";
    $("[data-super8-edit-size]").value = String(tournament.size);
    $("[data-super8-edit-size]").disabled = locked;
    $("[data-super8-edit-categories-field]").classList.toggle("hidden", locked);
    $("[data-super8-edit-players-field]").classList.toggle("hidden", locked);
    renderSuper8EditSearchResults([]);
    $("[data-super8-edit-search]").value = "";
    $("[data-super8-edit-guest-name]").value = "";
    renderSuper8EditPlayers();
    openModal($("[data-super8-edit-modal]"));
  }

  async function submitSuper8Edit(onIneligiblePlayers) {
    const tournament = super8State.current;
    if (!tournament) return;
    const form = $("[data-super8-edit-form]");
    const button = $("[data-super8-edit-save]");
    const confirmed = isSuper8Confirmed(tournament);
    const locked = confirmed || SUPER8_LOCKED_STATUSES.includes(tournament.status);
    const body = {
      date: $("[data-super8-edit-date]").value || null,
      startTime: $("[data-super8-edit-start-time]").value || null,
    };
    if (!confirmed) body.name = form.elements.name.value.trim();
    if (!locked) {
      body.size = Number($("[data-super8-edit-size]").value);
      body.levelCategories = readSuper8EditLevelCategories();
      body.genderCategory = $("[data-super8-edit-gender]")?.value || "all";
    }
    if (onIneligiblePlayers) body.onIneligiblePlayers = onIneligiblePlayers;
    button.disabled = true;
    button.textContent = "Salvando…";
    showFormFeedback("[data-super8-edit-feedback]", "");
    try {
      const { tournament: updated } = await apiRequest(
        `/api/v1/club/super8/${encodeURIComponent(tournament.id)}`,
        { method: "PATCH", body },
      );
      $("[data-super8-edit-confirm]").classList.add("hidden");
      closeModal($("[data-super8-edit-modal]"));
      const index = super8State.tournaments.findIndex(
        (item) => item.id === updated.id,
      );
      if (index >= 0) super8State.tournaments[index] = updated;
      openSuper8Detail(updated.id, updated);
      loadSuper8();
      showToast("Torneio atualizado.");
    } catch (error) {
      if (error.code === "super8_category_change_needs_confirmation") {
        const names = error.details?.affectedPlayers
          ?.map((player) => player.name)
          .join(", ");
        $("[data-super8-edit-confirm-message]").textContent =
          `${error.message}${names ? ` (${names})` : ""}`;
        $("[data-super8-edit-confirm]").classList.remove("hidden");
      } else {
        showFormFeedback("[data-super8-edit-feedback]", error.message);
      }
    } finally {
      button.disabled = false;
      button.textContent = "Salvar alterações";
    }
  }

  function setupSuper8EditModal() {
    populateSuper8EditTimeOptions();
    setupSuper8EditSearch();
    $("[data-super8-edit-open]")?.addEventListener("click", openSuper8EditModal);
    $("[data-super8-edit-categories-all]")?.addEventListener(
      "change",
      (event) => {
        $("[data-super8-edit-categories-grid]").classList.toggle(
          "hidden",
          event.currentTarget.checked,
        );
      },
    );
    $("[data-super8-edit-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitSuper8Edit();
    });
    $("[data-super8-edit-confirm-remove]")?.addEventListener("click", () =>
      submitSuper8Edit("remove"),
    );
    $("[data-super8-edit-confirm-keep]")?.addEventListener("click", () =>
      submitSuper8Edit("keep"),
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
    $("[data-kpi-revenue]").textContent = String(summary.monthlyGames);
    $("[data-kpi-revenue-trend]").textContent = "Jogos criados no mês";
  }

  function arenaCard() {
    const club = state.club;
    const photoUrl = safePhotoUrl(club.photoUrl);
    const artwork = photoUrl
      ? `<img class="owner-arena-photo" src="${escapeHTML(photoUrl)}" alt="${escapeHTML(club.name)}" />`
      : '<div class="club-cover-art"></div>';
    return `<article class="owner-arena-card card-hover" data-owner-arena tabindex="0"><div class="owner-arena-art">${artwork}</div><div class="owner-arena-info"><span class="status-open"><i></i> ${club.status === "active" ? "Arena ativa" : "Arena inativa"}</span><h3>${escapeHTML(club.name)}</h3><p>${state.courts.length ? "Visível para jogadores" : "Cadastre uma quadra para publicar a arena"}</p><div class="arena-mini-stats"><span><small>Quadras</small><strong>${state.courts.length}</strong></span><span><small>Jogos</small><strong>${state.bookings.length}</strong></span><span><small>Jogos no mês</small><strong>${escapeHTML(String(state.session.summary.monthlyGames))}</strong></span></div></div></article>`;
  }

  // TASK-51: card das arenas adicionais (unidades extras do clube).
  function extraArenaCard(arena) {
    const courtsCount = state.courts.filter(
      (court) => court.arenaId === arena.id,
    ).length;
    return `<article class="owner-arena-card card-hover" data-owner-arena data-arena-id="${escapeHTML(arena.id)}" tabindex="0"><div class="owner-arena-art"><div class="club-cover-art"></div></div><div class="owner-arena-info"><span class="status-open"><i></i> Arena ativa</span><h3>${escapeHTML(arena.name)}</h3><p>${escapeHTML(arena.address)}</p><div class="arena-mini-stats"><span><small>Quadras</small><strong>${courtsCount}</strong></span></div></div></article>`;
  }

  function renderArena() {
    $("[data-owner-arena-grid]").innerHTML =
      arenaCard() + state.arenas.map(extraArenaCard).join("");
    $$("[data-owner-arena][data-arena-id]").forEach((extraCard) => {
      const open = () => openManagement();
      extraCard.addEventListener("click", open);
      extraCard.addEventListener("keydown", (event) => {
        if (event.key === "Enter") open();
      });
    });
    const card = $("[data-owner-arena]:not([data-arena-id])");
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
    return `<article class="management-court card-hover" role="button" tabindex="0" data-edit-court="${escapeHTML(court.id)}" aria-label="Editar ${escapeHTML(court.name)}"><div class="management-court-art">${artwork}<span class="court-state">${court.active ? "Ativa" : "Inativa"}</span></div><div class="management-court-body"><h3>${escapeHTML(court.name)}</h3><p>${escapeHTML(courtOpenTime(court))}–${escapeHTML(courtCloseTime(court))}</p><div class="court-meta"><span><small>Preço por horário</small><strong>${escapeHTML(formatCurrency(court.price))}</strong></span><span><small>Duração</small><strong>${courtSlotDurations(court).join(" / ")} min</strong></span><span class="court-edit-hint">Editar</span></div></div></article>`;
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
  }

  function populateHalfHourSelect(select, selectedValue) {
    if (!select) return;
    select.innerHTML = Array.from({ length: 48 }, (_, index) => {
      const time = minutesToTime(index * 30);
      return `<option value="${time}"${time === selectedValue ? " selected" : ""}>${time}</option>`;
    }).join("");
  }

  function durationLabel(minutes) {
    return minutes === 60 ? "1 hora" : minutes === 90 ? "1h 30 min" : `${minutes} min`;
  }

  function renderDurationWindowsList() {
    const list = $("[data-duration-windows-list]");
    if (!list) return;
    if (!state.editingDurationWindows.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = state.editingDurationWindows
      .map(
        (w, i) =>
          `<div class="blocked-window-item"><span>${escapeHTML(w.from)} – ${escapeHTML(w.to)}: <strong>${escapeHTML(durationLabel(w.duration))}</strong></span><button class="blocked-window-item-remove" type="button" aria-label="Remover" data-remove-dw="${i}">×</button></div>`,
      )
      .join("");
    list.querySelectorAll("[data-remove-dw]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.editingDurationWindows.splice(Number(btn.dataset.removeDw), 1);
        renderDurationWindowsList();
      });
    });
  }

  function renderBlockedWindowsList() {
    const list = $("[data-blocked-windows-list]");
    if (!list) return;
    if (!state.editingBlockedWindows.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = state.editingBlockedWindows
      .map(
        (w, i) =>
          `<div class="blocked-window-item"><span>${escapeHTML(w.from)} – ${escapeHTML(w.to)}</span><button class="blocked-window-item-remove" type="button" aria-label="Remover" data-remove-bw="${i}">×</button></div>`,
      )
      .join("");
    list.querySelectorAll("[data-remove-bw]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.editingBlockedWindows.splice(Number(btn.dataset.removeBw), 1);
        renderBlockedWindowsList();
      });
    });
  }

  function showFormFeedback(selector, message, success = false) {
    const feedback = $(selector);
    if (!feedback) return;
    feedback.textContent = message || "";
    feedback.classList.toggle("hidden", !message);
    feedback.classList.toggle("success", Boolean(message) && success);
  }

  function configureCourtForm(court = null) {
    const form = $("[data-court-form]");
    state.editingCourtId = court?.id || null;
    form.reset();
    form.elements.name.value = court?.name || "";
    form.elements.price.value = court?.price ?? "";
    form.elements.openTime.value = court ? courtOpenTime(court) : "06:00";
    form.elements.closeTime.value = court ? courtCloseTime(court) : "23:00";
    // Duration windows: se a quadra não tem nenhuma, derivamos uma do slotDuration
    // para que o formulário nunca fique vazio.
    if (Array.isArray(court?.durationWindows) && court.durationWindows.length) {
      state.editingDurationWindows = [...court.durationWindows];
    } else if (court) {
      const dur = courtSlotDuration(court);
      state.editingDurationWindows = [
        { from: courtOpenTime(court), to: courtCloseTime(court), duration: dur },
      ];
    } else {
      state.editingDurationWindows = [];
    }
    renderDurationWindowsList();
    state.editingBlockedWindows = Array.isArray(court?.blockedWindows)
      ? [...court.blockedWindows]
      : [];
    renderBlockedWindowsList();
    // Oculta o botão "Confirmar" do bloqueio até o usuário escolher os horários.
    $("[data-blocked-window-add]")?.classList.add("hidden");
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
    setUploadFeedback("court");
    openModal($("[data-court-modal]"));
    requestAnimationFrame(() => $("[data-court-form] [name='name']")?.focus());
  }

  function openCourtEditor(courtId) {
    const court = state.courts.find((item) => item.id === courtId);
    if (!court) return;
    configureCourtForm(court);
    setUploadFeedback("court");
    openModal($("[data-court-modal]"));
    requestAnimationFrame(() => $("[data-court-form] [name='name']")?.focus());
  }

  // TASKS-15 / TASK-65 — feedback padrão das áreas de upload do clube.
  function setUploadFeedback(kind, { error = "", selected = false } = {}) {
    const note = $(`[data-${kind}-photo-error]`);
    if (note) {
      note.textContent = error;
      note.classList.toggle("hidden", !error);
    }
    $(`[data-${kind}-photo-clear]`)?.classList.toggle("hidden", !selected);
  }

  function clearSelectedClubPhoto() {
    const input = $("[data-club-photo-input]");
    if (input) input.value = "";
    clearClubPhotoObjectUrl();
    state.clubCroppedFile = null;
    setClubPhotoPreview(state.club?.photoUrl, state.club?.name);
    setUploadFeedback("club");
  }

  async function saveCourt(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const button = $("[data-court-submit]", form);
    const formData = new FormData(form);
    const values = Object.fromEntries(formData.entries());
    if (!state.editingDurationWindows.length) {
      showFormFeedback(
        "[data-court-feedback]",
        "Adicione ao menos uma faixa de horário com duração.",
      );
      return;
    }
    const body = {
      name: values.name.trim(),
      price: Number(values.price),
      openTime: values.openTime,
      closeTime: values.closeTime,
      durationWindows: state.editingDurationWindows,
      // TASK-51: vazio = arena principal
      arenaId: values.arenaId || "",
    };
    // TASK-96: funcionamento pode atravessar a meia-noite (ex.: abre 06:00,
    // fecha 01:00 do dia seguinte) — nesse caso o fechamento é numericamente
    // menor/igual à abertura e pertence ao dia seguinte.
    const opensAtMinutes = timeToMinutes(body.openTime);
    const closesAtMinutes = timeToMinutes(body.closeTime);
    const closesAtMinutesNextDay =
      closesAtMinutes <= opensAtMinutes
        ? closesAtMinutes + 24 * 60
        : closesAtMinutes;
    const minDuration = Math.min(
      ...state.editingDurationWindows.map((w) => w.duration),
    );
    if (closesAtMinutesNextDay - opensAtMinutes < minDuration) {
      showFormFeedback(
        "[data-court-feedback]",
        "O horário de fechamento deve permitir ao menos um horário completo.",
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
        ({ court } = await apiRequest(
          `/api/v1/club/courts/${encodeURIComponent(state.editingCourtId)}`,
          { method: "PATCH", body },
        ));
      } else {
        ({ court } = await apiRequest("/api/v1/club/courts", {
          method: "POST",
          body,
        }));
      }
      ({ court } = await apiRequest(
        `/api/v1/club/courts/${encodeURIComponent(court.id)}/blocked-windows`,
        { method: "PATCH", body: { windows: state.editingBlockedWindows } },
      ));
      const index = state.courts.findIndex((item) => item.id === court.id);
      if (index === -1) state.courts.push(court);
      else state.courts[index] = court;
      renderCourts();
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
        ? ` Esta quadra possui ${futureBookings} ${futureBookings === 1 ? "jogo futuro que será cancelado" : "jogos futuros que serão cancelados"}.`
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
    // Selects de faixa de duração
    populateHalfHourSelect($("[data-dw-from]"), "06:00");
    populateHalfHourSelect($("[data-dw-to]"), "18:00");
    // Selects de bloqueio recorrente
    populateHalfHourSelect($("[data-blocked-window-from]"), "08:00");
    populateHalfHourSelect($("[data-blocked-window-to]"), "09:00");

    // Botão "Confirmar" do bloqueio aparece quando ambos os selects são alterados
    const bwConfirmBtn = $("[data-blocked-window-add]");
    const showBwConfirm = () => {
      bwConfirmBtn?.classList.remove("hidden");
    };
    $("[data-blocked-window-from]")?.addEventListener("change", showBwConfirm);
    $("[data-blocked-window-to]")?.addEventListener("change", showBwConfirm);

    $("[data-blocked-window-add]")?.addEventListener("click", () => {
      const from = $("[data-blocked-window-from]")?.value;
      const to = $("[data-blocked-window-to]")?.value;
      if (!from || !to || from >= to) {
        showToast("O horário de início deve ser anterior ao de fim.");
        return;
      }
      if (state.editingBlockedWindows.some((w) => w.from === from && w.to === to)) return;
      state.editingBlockedWindows.push({ from, to });
      renderBlockedWindowsList();
    });

    // Botão de adicionar faixa de duração
    $("[data-dw-add]")?.addEventListener("click", () => {
      const from = $("[data-dw-from]")?.value;
      const to = $("[data-dw-to]")?.value;
      const duration = Number($("[data-dw-duration]")?.value ?? 60);
      if (!from || !to || from >= to) {
        showToast("O horário de início deve ser anterior ao de fim.");
        return;
      }
      if (state.editingDurationWindows.some((w) => w.from === from && w.to === to)) return;
      state.editingDurationWindows.push({ from, to, duration });
      renderDurationWindowsList();
    });

    $("[data-add-court]")?.addEventListener("click", openCourtCreator);
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
    const initials = booking.player?.initials || "—";
    const name = booking.player?.displayName || "Jogador";
    const statusLabels = { confirmed: "Confirmado", cancelled: "Cancelado" };
    const spots = booking.openSpots > 0 ? `${booking.openSpots} vagas` : "Completo";
    return `<tr><td><span class="client-cell"><span>${escapeHTML(initials)}</span><strong>${escapeHTML(name)}</strong></span></td><td>${escapeHTML(booking.courtName)}</td><td>${escapeHTML(date)}</td><td>${escapeHTML(spots)}</td><td><span class="status-badge${booking.status !== "confirmed" ? " done" : ""}">${escapeHTML(statusLabels[booking.status] || booking.status)}</span></td></tr>`;
  }

  function renderBookings() {
    const table = $("[data-reservation-table]");
    table.innerHTML = state.bookings.map(bookingRow).join("");
    if (!state.bookings.length) {
      table.innerHTML = `<tr><td colspan="5">${emptyState("Nenhum jogo ainda.", "Os jogos criados nas suas quadras aparecerão aqui.")}</td></tr>`;
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

  function clearClubPhotoObjectUrl() {
    if (!state.clubPreviewObjectUrl) return;
    URL.revokeObjectURL(state.clubPreviewObjectUrl);
    state.clubPreviewObjectUrl = null;
  }

  function setClubPhotoPreview(url, name = state.club?.name || "Padelfy") {
    const image = $("[data-club-photo-preview]");
    const placeholder = $("[data-club-photo-placeholder]");
    if (!image || !placeholder) return;
    const safeUrl = url?.startsWith("blob:") ? url : safePhotoUrl(url);
    image.style.display = safeUrl ? "block" : "none";
    image.src = safeUrl || "";
    placeholder.style.display = safeUrl ? "none" : "";
    placeholder.textContent = String(name || "QF")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function previewClubPhoto(event) {
    const input = event.currentTarget;
    const [file] = input.files || [];
    if (!file) {
      clearClubPhotoObjectUrl();
      state.clubCroppedFile = null;
      setClubPhotoPreview(state.club?.photoUrl, state.club?.name);
      setUploadFeedback("club");
      return;
    }
    try {
      validateImageFile(file);
      input.value = "";
      openCropModal(file, (blob) => {
        clearClubPhotoObjectUrl();
        state.clubCroppedFile = blob;
        state.clubPreviewObjectUrl = URL.createObjectURL(blob);
        setClubPhotoPreview(
          state.clubPreviewObjectUrl,
          $("[data-setting-name]").value,
        );
        setUploadFeedback("club", { selected: true });
      }, { shape: "rect", aspectRatio: 2 });
    } catch (error) {
      input.value = "";
      clearClubPhotoObjectUrl();
      state.clubCroppedFile = null;
      setClubPhotoPreview(state.club?.photoUrl, state.club?.name);
      setUploadFeedback("club", { error: error.message });
      showToast(error.message);
    }
  }

  const BIZ_DAYS = [
    { key: "mon", label: "Segunda" },
    { key: "tue", label: "Terça" },
    { key: "wed", label: "Quarta" },
    { key: "thu", label: "Quinta" },
    { key: "fri", label: "Sexta" },
    { key: "sat", label: "Sábado" },
    { key: "sun", label: "Domingo" },
  ];

  function switchSettingsTab(tab) {
    $$("[data-settings-tab]").forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.settingsTab === tab),
    );
    $$("[data-settings-view]").forEach((view) =>
      view.classList.toggle("hidden", view.dataset.settingsView !== tab),
    );
  }

  function buildBizHoursGrid() {
    const grid = $("[data-biz-hours-grid]");
    if (!grid || grid.children.length > 0) return;
    for (const { key, label } of BIZ_DAYS) {
      const row = document.createElement("div");
      row.className = "biz-hours-row closed";
      row.dataset.bizDay = key;

      const dayLabel = document.createElement("span");
      dayLabel.className = "biz-hours-day-label";
      dayLabel.textContent = label;

      const toggle = document.createElement("label");
      toggle.className = "biz-open-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = `${key}-open`;
      const toggleText = document.createElement("span");
      toggleText.textContent = "Aberto";
      toggle.append(checkbox, toggleText);

      const times = document.createElement("div");
      times.className = "biz-hours-times";

      const startSel = document.createElement("select");
      startSel.name = `${key}-start`;
      startSel.setAttribute("aria-label", `Abertura ${label}`);
      populateHalfHourSelect(startSel, "06:00");

      const dash = document.createElement("span");
      dash.textContent = "até";

      const endSel = document.createElement("select");
      endSel.name = `${key}-end`;
      endSel.setAttribute("aria-label", `Fechamento ${label}`);
      populateHalfHourSelect(endSel, "23:00");

      times.append(startSel, dash, endSel);
      row.append(dayLabel, toggle, times);
      grid.appendChild(row);

      checkbox.addEventListener("change", () => {
        row.classList.toggle("closed", !checkbox.checked);
      });
    }
  }

  function populateBizHours(businessHours) {
    buildBizHoursGrid();
    const bh = businessHours ?? {};
    for (const { key } of BIZ_DAYS) {
      const row = $(`[data-biz-day="${key}"]`);
      if (!row) continue;
      const entry = bh[key] ?? { open: false, start: "06:00", end: "23:00" };
      const checkbox = row.querySelector(`[name="${key}-open"]`);
      const startSel = row.querySelector(`[name="${key}-start"]`);
      const endSel = row.querySelector(`[name="${key}-end"]`);
      if (checkbox) checkbox.checked = Boolean(entry.open);
      if (startSel) startSel.value = entry.start ?? "06:00";
      if (endSel) endSel.value = entry.end ?? "23:00";
      row.classList.toggle("closed", !entry.open);
    }
  }

  function setupClubSettings() {
    $("[data-club-photo-input]")?.addEventListener(
      "change",
      previewClubPhoto,
    );
    $("[data-club-photo-clear]")?.addEventListener(
      "click",
      clearSelectedClubPhoto,
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
          const photoFile = state.clubCroppedFile || (photo instanceof File && photo.size > 0 ? photo : null);
          if (photoFile) {
            button.textContent = "Enviando imagem…";
            photoUrl = (await uploadImage(photoFile, "club", state.club.id)).url;
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
              businessHours: state.club?.businessHours ?? null,
            },
          });
          state.club = photoFile && data.club.photoUrl
            ? { ...data.club, photoUrl: data.club.photoUrl + "?v=" + Date.now() }
            : data.club;
          state.session.club = state.club;
          state.session.identity.arenaName = state.club.name;
          state.clubCroppedFile = null;
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

    $$("[data-settings-tab]").forEach((btn) =>
      btn.addEventListener("click", () => {
        switchSettingsTab(btn.dataset.settingsTab);
        if (btn.dataset.settingsTab === "hours") {
          buildBizHoursGrid();
          populateBizHours(state.club?.businessHours ?? null);
        }
      }),
    );

    $("[data-business-hours-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = $('button[type="submit"]', form);
      const businessHours = {};
      for (const { key } of BIZ_DAYS) {
        const checkbox = form.elements[`${key}-open`];
        const startSel = form.elements[`${key}-start`];
        const endSel = form.elements[`${key}-end`];
        businessHours[key] = {
          open: checkbox?.checked ?? false,
          start: startSel?.value ?? "06:00",
          end: endSel?.value ?? "23:00",
        };
      }
      showFormFeedback("[data-hours-feedback]", "");
      button.disabled = true;
      button.textContent = "Salvando…";
      try {
        const club = state.club;
        const data = await apiRequest("/api/v1/club/profile", {
          method: "PATCH",
          body: {
            name: club.name,
            description: club.description ?? "",
            phone: club.phone ?? "",
            address: club.address,
            photoUrl: club.photoUrl ?? "",
            businessHours,
          },
        });
        state.club = data.club;
        state.session.club = data.club;
        showFormFeedback("[data-hours-feedback]", "Horários salvos.", true);
        showToast("Horários de funcionamento atualizados.");
      } catch (error) {
        showFormFeedback("[data-hours-feedback]", error.message);
      } finally {
        button.disabled = false;
        button.textContent = "Salvar horários";
      }
    });
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

  function scheduleCell(court, slot) {
    if (!slot) {
      return '<span class="schedule-cell blocked" aria-label="Fora da grade"><span>—</span></span>';
    }
    const status = ["available", "booked", "blocked"].includes(slot.status)
      ? slot.status
      : "blocked";
    const labels = {
      available: "Livre",
      booked: "Jogo criado",
      blocked: "Bloqueado",
    };
    const compatibilityClass = {
      available: "",
      booked: "booked",
      blocked: "blocked booked",
    }[status];
    const canToggle =
      status === "available" || (status === "blocked" && slot.blocked);
    if (canToggle) {
      const nextBlocked = status === "available";
      const action = nextBlocked ? "Bloquear" : "Liberar";
      return `<button class="schedule-cell schedule-cell-action ${compatibilityClass}" type="button" data-schedule-status="${status}" data-schedule-toggle data-schedule-court-id="${escapeHTML(court.courtId)}" data-schedule-start-at="${escapeHTML(slot.startAt)}" data-schedule-blocked="${String(nextBlocked)}" aria-label="${action} ${escapeHTML(slot.time)} da ${escapeHTML(court.courtName)}"><span>${escapeHTML(labels[status])}<small>${action}</small></span></button>`;
    }
    return `<span class="schedule-cell ${compatibilityClass}" data-schedule-status="${status}"><span>${escapeHTML(labels[status])}</span></span>`;
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
        html += `<button class="week-summary-cell" type="button" data-week-date="${escapeHTML(day.date)}" aria-label="Abrir grade de ${escapeHTML(dayLabel)}"><strong>${counts.available || 0} livres</strong><span>${counts.booked || 0} jogos</span></button>`;
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
    // TASK-96: horários que cruzam a meia-noite (ex.: 23:30, 00:00, 00:30)
    // não podem ser ordenados pelo valor numérico do horário em si — isso
    // colocaria "00:00" antes de "06:00" mesmo quando ele vem depois no
    // funcionamento real da quadra. Ordenamos pelo `startAt` real do slot.
    const timeOrder = new Map();
    courts.forEach((court) => {
      (court.slots || []).forEach((slot) => {
        const time = slotTime(slot);
        if (!time || timeOrder.has(time) || !slot.startAt) return;
        timeOrder.set(time, new Date(slot.startAt).getTime());
      });
    });
    const times = [...timeOrder.keys()].sort(
      (left, right) => timeOrder.get(left) - timeOrder.get(right),
    );
    if (!times.length) {
      $("[data-owner-schedule]").innerHTML = emptyState(
        "Nenhum horário neste dia.",
        "Confira o funcionamento das quadras ou selecione outra data.",
      );
      return;
    }
    const columns = `100px repeat(${courts.length}, minmax(140px, 1fr))`;
    let html = `<div class="schedule-legend" aria-label="Legenda da grade"><span data-schedule-status="available">Livre</span><span data-schedule-status="booked">Jogo criado</span><span data-schedule-status="blocked">Bloqueado</span></div><div class="schedule-grid"><span class="head">Horário</span>${courts.map((court) => `<span class="head court-name">${escapeHTML(court.courtName)}</span>`).join("")}`;
    times.forEach((time) => {
      html += `<span class="head schedule-time">${escapeHTML(time)}</span>`;
      courts.forEach((court) => {
        const slot = (court.slots || []).find(
          (item) => slotTime(item) === time,
        );
        html += scheduleCell(court, slot);
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

  // TASK-78/81 — sem pagamento processado pelo Padelfy, os gráficos viram
  // ocupação: jogos criados, não receita.
  function renderFinanceCharts(data) {
    const charts = window.PadelfyCharts;
    if (!charts) return;
    charts.renderLine(
      $("[data-chart-revenue]"),
      data.gamesByDay.map((day) => ({
        label: formatDate(day.date + "T12:00:00-03:00", {
          day: "2-digit",
          month: "short",
        }),
        shortLabel: day.date.slice(8),
        value: day.games,
      })),
      {
        label: "Jogos criados por dia",
        formatValue: (value) => String(value),
      },
    );
    charts.renderBars(
      $("[data-chart-courts]"),
      data.byCourt.map((court) => ({
        label: court.courtName,
        value: court.games,
      })),
      {
        label: "Jogos criados por quadra",
        formatValue: (value) => String(value),
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
  }

  function renderFinance() {
    const data = state.finance;
    $("[data-finance-kpi-games]").textContent = String(data.summary.totalGames);
    const averageOccupancy = data.occupancyByCourt.length
      ? data.occupancyByCourt.reduce(
          (total, court) => total + court.occupancyRate,
          0,
        ) / data.occupancyByCourt.length
      : 0;
    $("[data-finance-kpi-occupancy]").textContent = `${Math.round(averageOccupancy)}%`;
    renderFinanceComparison(
      "[data-finance-compare-games]",
      data.summary.totalGames,
      data.previousPeriod.games,
    );
    renderFinanceCharts(data);
    $("[data-finance-by-court]").innerHTML = data.byCourt.length
      ? data.byCourt
          .map(
            (court) =>
              `<article class="finance-court-card"><header><div><h3>${escapeHTML(court.courtName)}</h3><p>${court.games} ${court.games === 1 ? "jogo criado" : "jogos criados"}</p></div></header></article>`,
          )
          .join("")
      : emptyState(
          "Nenhuma quadra cadastrada.",
          "Cadastre quadras para acompanhar a ocupação por espaço.",
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
    const statusLabels = { confirmed: "Confirmado", cancelled: "Cancelado" };
    const spots = booking.openSpots > 0 ? `${booking.openSpots} vagas` : "Completo";
    return `<tr><td>${escapeHTML(date)}</td><td>${escapeHTML(booking.courtName)}</td><td>${escapeHTML(booking.player?.displayName || "Jogador")}</td><td>${escapeHTML(spots)}</td><td>${escapeHTML(statusLabels[booking.status] || booking.status)}</td></tr>`;
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

  async function toggleScheduleSlot(target) {
    const blocked = target.dataset.scheduleBlocked === "true";
    target.disabled = true;
    try {
      await apiRequest(
        `/api/v1/club/courts/${encodeURIComponent(target.dataset.scheduleCourtId)}/blocks`,
        {
          method: "PATCH",
          body: { startAt: target.dataset.scheduleStartAt, blocked },
        },
      );
      showToast(blocked ? "Horário bloqueado." : "Horário liberado.");
      await loadSchedule();
    } catch (error) {
      showToast(error.message);
      target.disabled = false;
    }
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
      const slot = event.target.closest("[data-schedule-toggle]");
      if (slot) {
        toggleScheduleSlot(slot);
        return;
      }
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
    loadArenas();
    setupCourtModal();
    setupClubSettings();
    setupFinance();
    setupSecondaryActions();
    if (!(await refreshDashboard())) return;
    if (state.courts.length === 0) openManagement();
    hydrateIcons();
  }

  initialize();
})();
