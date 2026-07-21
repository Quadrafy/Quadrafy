(() => {
  "use strict";

  if (document.documentElement.dataset.page !== "player") return;

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

  const LEVEL_MIN = 0.5;
  const LEVEL_MAX = 7;
  const CHAT_POLL_INTERVAL = 5000;
  const UNREAD_POLL_INTERVAL = 20000;

  const state = {
    session: null,
    clubs: [],
    bookings: [],
    matches: [],
    selectedClub: null,
    selectedDate: null,
    selectedCourt: null,
    selectedSlot: null,
    activeClubFilter: "all",
    bookingSegment: "upcoming",
    currentBooking: null,
    currentMatch: null,
    chatMessages: [],
    chatPollTimer: null,
    unreadPollTimer: null,
    unreadByMatch: new Map(),
    refreshingUnread: false,
    levelTestRequired: false,
    lastFocusedElement: null,
    profilePreviewObjectUrl: null,
    achievements: [],
    achievementCatalog: [],
    super8Open: [],
  };

  const emptyState = (title, text) =>
    `<div class="data-empty-state"><span>${icon("court")}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(text)}</p></div>`;

  const clampLevel = (value) =>
    Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Number(value) || LEVEL_MIN));

  const formatLevel = (value) =>
    clampLevel(value).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent.trim();
    }
    button.disabled = busy;
    button.textContent = busy
      ? busyLabel
      : button.dataset.originalLabel || "Continuar";
  }

  function openAccessibleModal(modal, focusSelector) {
    state.lastFocusedElement = document.activeElement;
    openModal(modal);
    requestAnimationFrame(() => {
      $(focusSelector, modal)?.focus();
    });
  }

  // Confirmação no padrão visual do app (substitui window.confirm).
  function confirmAction({
    eyebrow = "Confirmação",
    title = "Tem certeza?",
    message = "",
    confirmLabel = "Confirmar",
    cancelLabel = "Cancelar",
  } = {}) {
    const modal = $("[data-confirm-modal]");
    if (!modal) return Promise.resolve(false);
    $("[data-confirm-eyebrow]", modal).textContent = eyebrow;
    $("[data-confirm-title]", modal).textContent = title;
    $("[data-confirm-message]", modal).textContent = message;
    const acceptButton = $("[data-confirm-accept]", modal);
    const cancelButton = $("[data-confirm-cancel]", modal);
    acceptButton.textContent = confirmLabel;
    cancelButton.textContent = cancelLabel;
    openAccessibleModal(modal, "[data-confirm-cancel]");
    return new Promise((resolve) => {
      const finish = (result) => {
        acceptButton.removeEventListener("click", onAccept);
        cancelButton.removeEventListener("click", onCancel);
        modal.removeEventListener("transitionend", noop);
        observer.disconnect();
        if (modal.classList.contains("open")) closeModal(modal);
        restoreModalFocus();
        resolve(result);
      };
      const noop = () => {};
      const onAccept = () => finish(true);
      const onCancel = () => finish(false);
      acceptButton.addEventListener("click", onAccept);
      cancelButton.addEventListener("click", onCancel);
      // Fechamento por Escape, backdrop ou botão "×" conta como cancelar.
      const observer = new MutationObserver(() => {
        if (!modal.classList.contains("open")) finish(false);
      });
      observer.observe(modal, {
        attributes: true,
        attributeFilter: ["class"],
      });
    });
  }

  function restoreModalFocus() {
    const element = state.lastFocusedElement;
    if (element instanceof HTMLElement && element.isConnected) element.focus();
    state.lastFocusedElement = null;
  }

  function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dateOptions() {
    return Array.from({ length: 6 }, (_, index) => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() + index);
      return date;
    });
  }

  function formatDuration(minutes) {
    const total = Number(minutes) || 0;
    const hours = Math.floor(total / 60);
    const remainder = total % 60;
    if (!hours) return `${remainder}min`;
    return remainder ? `${hours}h${String(remainder).padStart(2, "0")}` : `${hours}h`;
  }

  function courtSlotDuration(court) {
    return Number(court?.slotDuration || court?.slotDurationMinutes || 90);
  }

  function initialsFor(name) {
    return String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function playerName(user = state.session?.user) {
    const profile = user?.profile || {};
    return (
      `${profile.firstName || ""} ${profile.lastName || ""}`.trim() ||
      user?.email?.split("@")[0] ||
      "Jogador"
    );
  }

  function safePhotoUrl(value) {
    const url = String(value || "").trim();
    if (!url) return "";
    if (/^\/assets\/[a-z0-9/_\-.]+$/i.test(url)) return url;
    if (
      /^\/uploads\/(?:players|clubs|courts)\/[a-f0-9-]+\.(?:jpg|png|webp)$/i.test(
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

  function applyPlayerIdentity() {
    if (!state.session?.user) return;
    const profile = state.session.user.profile || {};
    const name = playerName();
    const initials = initialsFor(name) || "—";
    const photoUrl = safePhotoUrl(profile.photoUrl);
    $$("[data-user-name]").forEach((element) => {
      element.textContent = name;
    });
    $$("[data-user-city]").forEach((element) => {
      element.textContent = profile.city || "Brasil";
    });
    const locationLabel = $("[data-player-location]");
    if (locationLabel) locationLabel.textContent = profile.city || "Brasil";
    $$("[data-user-subtitle]").forEach((element) => {
      element.textContent =
        profile.levelCategory ||
        (profile.levelAssessmentCompleted
          ? `Nível ${formatLevel(profile.level)}`
          : "Nível em formação");
    });
    $$("[data-user-initials]").forEach((element) => {
      element.style.backgroundImage = photoUrl ? `url("${photoUrl}")` : "";
      element.style.backgroundPosition = photoUrl ? "center" : "";
      element.style.backgroundSize = photoUrl ? "cover" : "";
      element.textContent = photoUrl ? "" : initials;
      element.setAttribute("aria-label", `Foto de ${name}`);
    });
  }

  function switchView(name) {
    $$("[data-player-view]").forEach((view) =>
      view.classList.toggle("active", view.dataset.playerView === name),
    );
    $$("[data-player-tab]").forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.playerTab === name ||
          (name === "club-detail" && button.dataset.playerTab === "clubs"),
      ),
    );
    $(".app-nav")?.classList.remove("menu-open");
    scrollTo({ top: 0, behavior: "smooth" });
    if (name === "bookings") {
      loadBookings();
      if (state.bookingSegment === "history") loadHistory();
    }
    if (name === "matches") loadMatches();
    if (name === "ranking") loadRanking();
    if (name === "super8") openSuper8Screen();
    if (name === "profile") loadProfileExtras();
  }

  function setupTabs() {
    $$("[data-player-tab]").forEach((button) =>
      button.addEventListener("click", () =>
        switchView(button.dataset.playerTab),
      ),
    );
    $$("[data-player-tab-link]").forEach((link) =>
      link.addEventListener("click", (event) => {
        event.preventDefault();
        switchView(link.dataset.playerTabLink);
      }),
    );
    $("[data-back-clubs]")?.addEventListener("click", () =>
      switchView("clubs"),
    );
  }

  function clubCard(club) {
    const minimum =
      club.minimumPrice == null
        ? "Preço não informado"
        : `A partir de ${formatCurrency(club.minimumPrice)}`;
    const photoUrl = safePhotoUrl(club.photoUrl);
    const artwork = photoUrl
      ? `<img class="club-cover-photo" src="${escapeHTML(photoUrl)}" alt="${escapeHTML(club.name)}" />`
      : '<div class="club-cover-art"></div>';
    return `<article class="club-card card-hover" data-club-id="${escapeHTML(club.id)}" tabindex="0" role="button" aria-label="Ver horários de ${escapeHTML(club.name)}">
      <div class="club-cover" data-tone="blue">${artwork}<span class="club-badge">Clube cadastrado</span></div>
      <div class="club-card-body">
        <div class="club-card-title"><div><h3>${escapeHTML(club.name)}</h3><p class="club-location">${escapeHTML(club.address || "Endereço ainda não informado")}</p></div></div>
        <div class="club-features"><span>${icon("court")} ${club.courtCount} ${club.courtCount === 1 ? "quadra" : "quadras"}</span></div>
        <div class="club-card-footer"><div><small>Referência</small><strong>${escapeHTML(minimum)}</strong></div><button type="button" tabindex="-1">Ver horários →</button></div>
      </div>
    </article>`;
  }

  function renderClubs() {
    const query = ($("[data-club-search]")?.value || "").trim().toLowerCase();
    const sort = $("[data-club-sort]")?.value || "recommended";
    let clubs = state.clubs.filter((club) =>
      club.name.toLowerCase().includes(query),
    );
    if (sort === "price") {
      clubs.sort(
        (a, b) =>
          (a.minimumPrice ?? Number.MAX_SAFE_INTEGER) -
          (b.minimumPrice ?? Number.MAX_SAFE_INTEGER),
      );
    }
    const grid = $("[data-club-grid]");
    grid.innerHTML = clubs.length
      ? clubs.map(clubCard).join("")
      : emptyState(
          "Nenhum clube disponível ainda.",
          "As arenas aparecerão aqui quando cadastrarem sua primeira quadra.",
        );
    $("[data-club-count]").textContent = String(clubs.length);
    $$("[data-club-id]", grid).forEach((card) => {
      const open = () => openClub(card.dataset.clubId);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  async function loadClubs() {
    try {
      const data = await apiRequest("/api/v1/clubs");
      state.clubs = data.clubs;
      renderClubs();
    } catch (error) {
      $("[data-club-grid]").innerHTML = emptyState(
        "Não foi possível carregar os clubes.",
        error.message,
      );
    }
  }

  function setupClubFilters() {
    $("[data-club-search]")?.addEventListener("input", renderClubs);
    $("[data-club-sort]")?.addEventListener("change", renderClubs);
    $$("[data-filter]").forEach((button) =>
      button.addEventListener("click", () => {
        state.activeClubFilter = button.dataset.filter;
        $$("[data-filter]").forEach((item) =>
          item.classList.toggle("active", item === button),
        );
        renderClubs();
      }),
    );
    $(".filter-more")?.addEventListener("click", () =>
      showToast(
        "Novos filtros serão liberados conforme as arenas completarem seus dados.",
      ),
    );
  }

  function renderDateStrip() {
    const dates = dateOptions();
    if (!state.selectedDate) state.selectedDate = localDateKey(dates[0]);
    const strip = $("[data-date-strip]");
    strip.innerHTML = dates
      .map((date) => {
        const key = localDateKey(date);
        const weekday = formatDate(date, { weekday: "short" }).replace(".", "");
        return `<button class="${key === state.selectedDate ? "active" : ""}" type="button" data-booking-date="${key}"><small>${escapeHTML(weekday.toUpperCase())}</small><strong>${date.getDate()}</strong></button>`;
      })
      .join("");
    $$("[data-booking-date]", strip).forEach((button) =>
      button.addEventListener("click", async () => {
        state.selectedDate = button.dataset.bookingDate;
        state.selectedSlot = null;
        await fetchClubDetail();
      }),
    );
  }

  function renderClubDetail() {
    const { club, availability } = state.selectedClub;
    if (!club.courts.some((court) => court.id === state.selectedCourt)) {
      state.selectedCourt = club.courts[0]?.id || null;
    }
    const featuredCourt =
      club.courts.find((court) => court.id === state.selectedCourt) ||
      club.courts[0];
    const featuredPhoto =
      safePhotoUrl(club.photoUrl) || safePhotoUrl(featuredCourt?.photoUrl);
    const detailArtwork = featuredPhoto
      ? `<img class="court-detail-photo" src="${escapeHTML(featuredPhoto)}" alt="${escapeHTML(club.photoUrl ? club.name : featuredCourt.name)}" />`
      : '<div class="club-cover-art"></div>';
    $("[data-club-detail]").innerHTML =
      `<div class="detail-art">${detailArtwork}</div><div class="detail-info"><span>${club.courtCount} ${club.courtCount === 1 ? "quadra cadastrada" : "quadras cadastradas"}</span><h1>${escapeHTML(club.name)}</h1><p>${escapeHTML(club.address || "Endereço ainda não informado")}</p><div class="detail-tags">${club.courts
        .map((court) => {
          const photoUrl = safePhotoUrl(court.photoUrl);
          return `<span>${photoUrl ? `<img src="${escapeHTML(photoUrl)}" alt="" />` : ""}${escapeHTML(court.name)}</span>`;
        })
        .join("")}</div></div>`;
    renderDateStrip();
    // TASK-98 — a escolha da quadra é a decisão mais importante desta tela
    // (não existe opção "Todas"), então o seletor ganha um ícone em destaque.
    const selector = $("[data-court-selector]");
    selector.innerHTML = club.courts
      .map(
        (court) =>
          `<button class="${court.id === state.selectedCourt ? "active" : ""}" type="button" data-court="${escapeHTML(court.id)}"><span class="court-selector-icon" data-icon="court"></span>${escapeHTML(court.name)}</button>`,
      )
      .join("");
    hydrateIcons(selector);
    $$("[data-court]", selector).forEach((button) =>
      button.addEventListener("click", () => {
        state.selectedCourt = button.dataset.court;
        $$("[data-court]", selector).forEach((item) =>
          item.classList.toggle("active", item === button),
        );
        renderSlots();
      }),
    );
    if (!availability.length) {
      $("[data-time-grid]").innerHTML = emptyState(
        "Nenhum horário disponível.",
        "Esta arena ainda não configurou quadras ativas.",
      );
    } else renderSlots();
    updateSelection();
  }

  function renderSlots() {
    const grid = $("[data-time-grid]");
    const availability = state.selectedClub.availability.filter(
      (court) => court.courtId === state.selectedCourt,
    );
    // TASK-15: exibir apenas horários realmente disponíveis (ocultar os já
    // reservados e os que já passaram, em vez de mostrá-los desabilitados).
    const slots = availability
      .flatMap((court) =>
        court.slots.map((slot) => ({
          ...slot,
          courtId: court.courtId,
          courtName: court.courtName,
          slotDuration: court.slotDurationMinutes,
        })),
      )
      .filter(
        (slot) =>
          slot.available && new Date(slot.startAt).getTime() > Date.now(),
      );
    // Se o horário selecionado sumiu da lista (ex.: reservado por outro
    // jogador), limpar a seleção para não confirmar um horário inválido.
    if (
      state.selectedSlot &&
      !slots.some(
        (slot) =>
          slot.startAt === state.selectedSlot.startAt &&
          slot.courtId === state.selectedSlot.courtId,
      )
    ) {
      state.selectedSlot = null;
      updateSelection();
    }
    grid.innerHTML = slots.length
      ? slots
          .map((slot) => {
            const selected =
              state.selectedSlot?.startAt === slot.startAt &&
              state.selectedSlot?.courtId === slot.courtId;
            return `<button class="time-slot${selected ? " selected" : ""}" type="button" data-slot-start="${slot.startAt}" data-slot-court="${escapeHTML(slot.courtId)}"><strong>${escapeHTML(slot.time)} · ${escapeHTML(formatDuration(slot.slotDuration))}</strong><small>${escapeHTML(slot.courtName)}</small></button>`;
          })
          .join("")
      : emptyState(
          "Nenhum horário disponível para esta quadra nesta data.",
          "Tente outra data ou quadra.",
        );
    $$(".time-slot:not(:disabled)", grid).forEach((button) =>
      button.addEventListener("click", () => {
        const court = state.selectedClub.club.courts.find(
          (item) => item.id === button.dataset.slotCourt,
        );
        state.selectedSlot = {
          startAt: button.dataset.slotStart,
          courtId: court.id,
          courtName: court.name,
          price: court.price,
          slotDuration: courtSlotDuration(court),
        };
        renderSlots();
        updateSelection();
      }),
    );
  }

  function updateSelection() {
    const selected = state.selectedSlot;
    $("[data-empty-selection]").classList.toggle("hidden", Boolean(selected));
    $("[data-selection-content]").classList.toggle("hidden", !selected);
    if (!selected) return;
    const dateLabel = formatDate(selected.startAt, {
      weekday: "short",
      day: "2-digit",
      month: "short",
    });
    const timeLabel = formatDate(selected.startAt, {
      hour: "2-digit",
      minute: "2-digit",
    });
    $("[data-summary-club]").textContent = state.selectedClub.club.name;
    $("[data-summary-date]").textContent = dateLabel;
    $("[data-summary-time]").textContent = timeLabel;
    $("[data-summary-court]").textContent = selected.courtName;
    $("[data-summary-price]").textContent = formatCurrency(selected.price);
    $("[data-modal-club]").textContent = state.selectedClub.club.name;
    $("[data-modal-court]").textContent = selected.courtName;
    $("[data-modal-date]").textContent = dateLabel;
    $("[data-modal-time]").textContent = timeLabel;
    $("[data-modal-price]").textContent = formatCurrency(selected.price);
  }

  async function fetchClubDetail() {
    if (!state.selectedClub?.club?.id) return;
    const data = await apiRequest(
      `/api/v1/clubs/${encodeURIComponent(state.selectedClub.club.id)}?date=${state.selectedDate}`,
    );
    state.selectedClub = data;
    renderClubDetail();
  }

  async function openClub(id) {
    try {
      state.selectedDate = localDateKey(dateOptions()[0]);
      const data = await apiRequest(
        `/api/v1/clubs/${encodeURIComponent(id)}?date=${state.selectedDate}`,
      );
      state.selectedClub = data;
      state.selectedCourt = data.club.courts[0]?.id || null;
      state.selectedSlot = null;
      renderClubDetail();
      switchView("club-detail");
    } catch (error) {
      showToast(error.message);
    }
  }

  // TASK-92 — seleção de categorias oficiais no lugar da faixa numérica de
  // nível (mesmo componente/padrão já usado no Super 8, TASK-77).
  function readLevelCategories(allCheckbox, groupSelector) {
    if (!allCheckbox || allCheckbox.checked) return null;
    const selected = $$(`${groupSelector} input:checked`).map(
      (input) => input.value,
    );
    return selected.length ? selected : null;
  }

  function setLevelCategories(allCheckbox, groupSelector, levelCategories) {
    if (!allCheckbox) return;
    const hasRestriction = Boolean(levelCategories?.length);
    allCheckbox.checked = !hasRestriction;
    $(groupSelector)?.classList.toggle("hidden", !hasRestriction);
    $$(`${groupSelector} input`).forEach((input) => {
      input.checked = hasRestriction && levelCategories.includes(input.value);
    });
  }

  function setupCategorySelector(allSelector, groupSelector) {
    const allCheckbox = $(allSelector);
    allCheckbox?.addEventListener("change", (event) => {
      $(groupSelector)?.classList.toggle("hidden", event.currentTarget.checked);
    });
  }

  function setupBookingModal() {
    $("[data-open-booking]")?.addEventListener("click", () => {
      // TASK-60: limpa convidados de aberturas anteriores do modal
      resetInvitePlayers();
      openAccessibleModal(
        $("[data-booking-modal]"),
        "[data-booking-categories-all]",
      );
    });
    // TASK-60: busca de jogadores para preencher vagas na criação
    setupInviteSearch();
    setupCategorySelector(
      "[data-booking-categories-all]",
      "[data-booking-categories-grid]",
    );
    $("[data-confirm-booking]")?.addEventListener("click", confirmBooking);
  }

  /* TASKS-14 / TASK-60 — convidar jogadores já na criação do jogo aberto */
  const inviteState = { players: [], timer: null };

  function renderInviteChips() {
    const chips = $("[data-invite-chips]");
    if (!chips) return;
    chips.innerHTML = inviteState.players.length
      ? inviteState.players
          .map(
            (player, index) =>
              `<span class="super8-chip">${escapeHTML(player.name)}<button type="button" data-invite-remove="${index}" aria-label="Remover ${escapeHTML(player.name)}">×</button></span>`,
          )
          .join("")
      : "";
    $$("[data-invite-remove]", chips).forEach((button) =>
      button.addEventListener("click", () => {
        inviteState.players.splice(Number(button.dataset.inviteRemove), 1);
        renderInviteChips();
      }),
    );
  }

  function resetInvitePlayers() {
    inviteState.players = [];
    const search = $("[data-invite-search]");
    if (search) search.value = "";
    $("[data-invite-search-results]")?.classList.add("hidden");
    renderInviteChips();
  }

  function setupInviteSearch() {
    const input = $("[data-invite-search]");
    const results = $("[data-invite-search-results]");
    if (!input || !results) return;
    input.addEventListener("input", () => {
      clearTimeout(inviteState.timer);
      const query = input.value.trim();
      if (query.length < 2) {
        results.classList.add("hidden");
        return;
      }
      inviteState.timer = setTimeout(async () => {
        try {
          const data = await apiRequest(
            `/api/v1/players/search?q=${encodeURIComponent(query)}`,
          );
          const myId = state.session?.user?.id;
          const players = (data.players || []).filter(
            (player) =>
              player.id !== myId &&
              !inviteState.players.some((item) => item.id === player.id),
          );
          results.classList.toggle("hidden", !players.length);
          results.innerHTML = players
            .map(
              (player) =>
                `<button type="button" data-invite-pick="${escapeHTML(player.id)}" data-player-name="${escapeHTML(player.displayName)}"><strong>${escapeHTML(player.displayName)}</strong><small>${player.level !== null ? `Nível ${Number(player.level).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "Sem nível"}</small></button>`,
            )
            .join("");
          $$("[data-invite-pick]", results).forEach((pick) =>
            pick.addEventListener("click", () => {
              if (inviteState.players.length >= 3) {
                showToast("Você pode adicionar no máximo 3 jogadores.");
                return;
              }
              inviteState.players.push({
                id: pick.dataset.invitePick,
                name: pick.dataset.playerName,
              });
              input.value = "";
              results.classList.add("hidden");
              renderInviteChips();
            }),
          );
        } catch {
          results.classList.add("hidden");
        }
      }, 250);
    });
  }

  // TASK-79 — cria o jogo direto; se já existir outro jogo/compromisso na
  // mesma quadra/horário, o backend responde "booking_conflict" (aviso, não
  // bloqueio) e perguntamos se o jogador quer criar mesmo assim.
  async function confirmBooking(event, allowConflict = false) {
    if (!state.selectedSlot || !state.selectedClub) return;
    const button = event.currentTarget;
    const levelCategories = readLevelCategories(
      $("[data-booking-categories-all]"),
      "[data-booking-categories-grid]",
    );
    setBusy(button, true, "Criando…");
    try {
      await apiRequest("/api/v1/player/bookings", {
        method: "POST",
        body: {
          clubId: state.selectedClub.club.id,
          courtId: state.selectedSlot.courtId,
          startAt: state.selectedSlot.startAt,
          allowConflict,
          levelCategories,
          genderCategory: $("[data-booking-gender-category]")?.value || "all",
          // TASK-60: convidados confirmados desde a criação
          ...(inviteState.players.length
            ? {
                invitedPlayerIds: inviteState.players.map(
                  (player) => player.id,
                ),
              }
            : {}),
        },
      });
      closeModal($("[data-booking-modal]"));
      state.selectedSlot = null;
      await Promise.all([loadBookings(), loadMatches(), fetchClubDetail()]);
      showToast("Jogo criado e publicado em aberto com três vagas.");
      switchView("bookings");
    } catch (error) {
      if (error.code === "booking_conflict" && !allowConflict) {
        setBusy(button, false);
        const confirmed = await confirmAction({
          eyebrow: "Já existe um jogo aqui",
          title: "Criar mesmo assim?",
          message: error.message,
          confirmLabel: "Criar mesmo assim",
          cancelLabel: "Cancelar",
        });
        if (confirmed) await confirmBooking(event, true);
        return;
      }
      showToast(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function bookingStatusLabel(status) {
    return (
      {
        confirmed: "Confirmada",
        cancelled: "Cancelada",
        completed: "Concluída",
        pending: "Pendente",
      }[status] ||
      status ||
      "Jogo"
    );
  }

  function renderBookings() {
    const now = Date.now();
    const upcoming = state.bookings.filter(
      (booking) =>
        booking.status !== "cancelled" &&
        new Date(booking.startAt).getTime() >= now,
    );
    const counter = $("[data-booking-upcoming-count]");
    counter.textContent = String(upcoming.length);
    counter.classList.toggle("hidden", upcoming.length === 0);
    const navCounter = $("[data-booking-count]");
    navCounter.textContent = String(upcoming.length);
    navCounter.classList.toggle("hidden", upcoming.length === 0);
    $("[data-booking-list]").innerHTML = upcoming.length
      ? upcoming
          .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
          .map((booking) => {
            const day = formatDate(booking.startAt, { day: "2-digit" });
            const month = formatDate(booking.startAt, { month: "short" })
              .replace(".", "")
              .toUpperCase();
            const time = formatDate(booking.startAt, {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            });
            const status = bookingStatusLabel(booking.status);
            const spotsLabel =
              booking.openSpots > 0
                ? `${booking.openSpots} vagas abertas`
                : "Completo";
            return `<article class="booking-item card-hover" data-booking-id="${escapeHTML(booking.id)}" tabindex="0" role="button" aria-label="Ver detalhes do jogo em ${escapeHTML(booking.clubName)}"><div class="booking-date"><small>${escapeHTML(month)}</small><strong>${escapeHTML(day)}</strong></div><div class="booking-info"><h3>${escapeHTML(booking.clubName)}</h3><p>${escapeHTML(booking.courtName)} · ${escapeHTML(time)} · ${escapeHTML(spotsLabel)}</p></div><div class="booking-actions"><span class="status-badge">${escapeHTML(status)}</span><span aria-hidden="true">→</span></div></article>`;
          })
          .join("")
      : emptyState(
          "Nenhum jogo futuro.",
          "Escolha um clube e crie seu primeiro jogo.",
        );
    $$("[data-booking-id]", $("[data-booking-list]")).forEach((item) => {
      const open = () => openBookingDetail(item.dataset.bookingId);
      item.addEventListener("click", open);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  async function loadBookings() {
    try {
      const data = await apiRequest("/api/v1/player/bookings");
      state.bookings = data.bookings;
      renderBookings();
      renderProfile();
    } catch (error) {
      $("[data-booking-list]").innerHTML = emptyState(
        "Não foi possível carregar os jogos.",
        error.message,
      );
    }
  }

  // TASK-89 — "Histórico" deixa de ser aba própria e passa a viver como
  // sub-aba dentro de "Meus jogos", preservando lançamento de resultado,
  // badge de pendência e variação de nível (antes na TASK-33 do TASKS-08).
  function setupBookingSegments() {
    $$("[data-segment]").forEach((button) =>
      button.addEventListener("click", () => {
        state.bookingSegment = button.dataset.segment;
        $$("[data-segment]").forEach((item) =>
          item.classList.toggle("active", item === button),
        );
        const isHistory = state.bookingSegment === "history";
        $("[data-booking-list]").classList.toggle("hidden", isHistory);
        $("[data-history-grid]").classList.toggle("hidden", !isHistory);
        if (isHistory) loadHistory();
        else renderBookings();
      }),
    );
  }

  function formatLevelCategories(record) {
    return record.levelCategories?.length
      ? record.levelCategories.join(", ")
      : "Todas as categorias";
  }

  function renderBookingDetail(booking) {
    const modal = $("[data-booking-detail-modal]");
    const startTime = new Date(booking.startAt).getTime();
    const isOwner = booking.playerId === state.session?.user?.id;
    const editable =
      isOwner && booking.status !== "cancelled" && startTime > Date.now();
    // TASK-79 — cancelar é simples, sem prazo/reembolso: só depende de o
    // jogo ainda estar confirmado (o backend não impõe mais janela alguma).
    const canCancel = editable && booking.canCancel;
    state.currentBooking = booking;
    $("[data-booking-detail-title]").textContent = booking.clubName;
    $("[data-booking-detail-summary]").innerHTML = `
      <div><small>Quadra</small><strong>${escapeHTML(booking.courtName)}</strong></div>
      <div><small>Data e hora</small><strong>${escapeHTML(formatDate(booking.startAt, { day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }))}</strong></div>
      <div><small>Preço de referência</small><strong>${escapeHTML(formatCurrency(booking.referencePrice))}</strong></div>
      <div><small>Status</small><strong>${escapeHTML(bookingStatusLabel(booking.status))}</strong></div>`;

    setLevelCategories(
      $("[data-booking-detail-categories-all]"),
      "[data-booking-detail-categories-grid]",
      booking.levelCategories,
    );
    $$("[data-booking-detail-open-fields] input").forEach((input) => {
      input.disabled = !editable;
    });

    const warning = $("[data-booking-detail-warning]");
    let warningText = "";
    if (!isOwner) {
      warningText =
        "Você participa deste jogo, mas somente quem criou o jogo pode alterar ou cancelá-lo.";
    } else if (!editable) {
      warningText =
        booking.status === "cancelled"
          ? "Este jogo foi cancelado e não pode mais ser alterado."
          : "Este jogo já começou e não pode mais ser alterado.";
    }
    warning.textContent = warningText;
    warning.classList.toggle("hidden", !warningText);
    $("[data-booking-detail-save]").disabled = !editable;
    $("[data-booking-cancel]").disabled = !canCancel;
    openAccessibleModal(modal, "[data-booking-detail-categories-all]");
  }

  async function openBookingDetail(id) {
    try {
      const { booking } = await apiRequest(
        `/api/v1/player/bookings/${encodeURIComponent(id)}`,
      );
      renderBookingDetail(booking);
    } catch (error) {
      showToast(error.message);
    }
  }

  async function saveBookingDetail(event) {
    event.preventDefault();
    if (!state.currentBooking) return;
    const form = event.currentTarget;
    const button = $("[data-booking-detail-save]", form);
    const body = {
      levelCategories: readLevelCategories(
        $("[data-booking-detail-categories-all]"),
        "[data-booking-detail-categories-grid]",
      ),
    };
    setBusy(button, true, "Salvando…");
    try {
      const { booking } = await apiRequest(
        `/api/v1/player/bookings/${encodeURIComponent(state.currentBooking.id)}`,
        { method: "PATCH", body },
      );
      state.currentBooking = booking;
      closeModal($("[data-booking-detail-modal]"));
      await Promise.all([loadBookings(), loadMatches()]);
      showToast("Jogo atualizado.");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  async function cancelCurrentBooking(event) {
    if (!state.currentBooking) return;
    const button = event.currentTarget;
    const participantCount =
      state.currentBooking.participantIds?.length ||
      state.currentBooking.players?.length ||
      1;
    const openWithOthers = participantCount > 1;
    const confirmed = await confirmAction({
      eyebrow: "Cancelar jogo",
      title: openWithOthers
        ? "Cancelar o jogo para todos?"
        : "Cancelar este jogo?",
      message: openWithOthers
        ? `Esta partida tem ${participantCount} jogadores confirmados. Cancelar remove o jogo para todos os participantes. Esta ação não pode ser desfeita.`
        : "Tem certeza que deseja cancelar este jogo? Esta ação não pode ser desfeita.",
      confirmLabel: "Confirmar cancelamento",
      cancelLabel: "Voltar",
    });
    if (!confirmed) return;
    setBusy(button, true, "Cancelando…");
    try {
      await apiRequest(
        `/api/v1/player/bookings/${encodeURIComponent(state.currentBooking.id)}`,
        { method: "PATCH", body: { status: "cancelled" } },
      );
      closeModal($("[data-booking-detail-modal]"));
      await Promise.all([loadBookings(), loadMatches()]);
      showToast("Jogo cancelado.");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function setupBookingDetail() {
    setupCategorySelector(
      "[data-booking-detail-categories-all]",
      "[data-booking-detail-categories-grid]",
    );
    $("[data-booking-detail-form]")?.addEventListener(
      "submit",
      saveBookingDetail,
    );
    $("[data-booking-cancel]")?.addEventListener("click", cancelCurrentBooking);
  }

  function matchParticipant(match) {
    if (typeof match.isParticipant === "boolean") return match.isParticipant;
    return match.participantIds?.includes(state.session?.user?.id) || false;
  }

  function matchPlayerLevel(player) {
    if (Number.isFinite(Number(player?.level))) {
      return `Nível ${formatLevel(player.level)}`;
    }
    return player?.levelCategory || player?.level || "Nível não informado";
  }

  function normalizedMatchTeams(match) {
    if (
      match.teams &&
      ["team1", "team2"].every(
        (team) =>
          Array.isArray(match.teams[team]) && match.teams[team].length === 2,
      )
    ) {
      return match.teams;
    }
    const players = Array.isArray(match.players)
      ? match.players.slice(0, 4)
      : [];
    return {
      team1: [players[0] || null, players[1] || null],
      team2: [players[2] || null, players[3] || null],
    };
  }

  function teamPositionOptions(selectedTeam, selectedSlot) {
    return ["team1", "team2"]
      .flatMap((team, teamIndex) =>
        [0, 1].map((slot) => {
          const value = `${team}:${slot}`;
          const selected = team === selectedTeam && slot === selectedSlot;
          return `<option value="${value}"${selected ? " selected" : ""}>Dupla ${teamIndex + 1}, posição ${slot + 1}</option>`;
        }),
      )
      .join("");
  }

  function matchPosition(match, team, slot, player, { interactive }) {
    const participant = matchParticipant(match);
    if (!player) {
      // TASK-12: quem já participa também pode clicar numa vaga vazia para
      // se mover para lá (o backend garante que só move a própria posição).
      const canJoin =
        interactive &&
        !participant &&
        !match.isFull &&
        Number(match.availableSpots) > 0;
      const canMove = interactive && participant;
      const canChoose = canJoin || canMove;
      const tag = canChoose ? "button" : "div";
      const actionLabel = canMove
        ? `Mover para a dupla ${team === "team1" ? 1 : 2}, posição ${slot + 1}`
        : `Entrar na dupla ${team === "team1" ? 1 : 2}, posição ${slot + 1}`;
      const attributes = canChoose
        ? ` type="button" data-join-position data-team="${team}" data-slot="${slot}"${canMove ? ' data-move-self="true"' : ""} aria-label="${actionLabel}"`
        : "";
      return `<${tag} class="match-player-row match-position-empty"${attributes}><span class="empty" aria-hidden="true">+</span><div><strong>Vaga livre</strong><small>${canMove ? "Mover-me para esta vaga" : canJoin ? "Escolher esta vaga" : "Disponível"}</small></div></${tag}>`;
    }
    const name = player.displayName || player.name || "Jogador";
    const level = matchPlayerLevel(player);
    const initials = player.initials || initialsFor(name) || "—";
    const photoUrl = safePhotoUrl(player.photoUrl);
    const avatar = photoUrl
      ? `<span class="match-player-avatar"><img src="${escapeHTML(photoUrl)}" alt="" /></span>`
      : `<span aria-hidden="true">${escapeHTML(initials)}</span>`;
    const playerTag = interactive && player.id ? "button" : "div";
    const playerAttributes =
      interactive && player.id
        ? ` type="button" data-public-player="${escapeHTML(player.id)}" aria-label="Ver perfil de ${escapeHTML(name)}"`
        : "";
    // TASK-32: o organizador pode remover qualquer outro jogador
    // posicionado (nunca a si mesmo — para isso existe o cancelamento).
    const canRemove =
      interactive &&
      match.isOrganizer &&
      player.id &&
      player.id !== state.session?.user?.id;
    const removeControl = canRemove
      ? `<button class="match-remove-player" type="button" data-remove-player="${escapeHTML(player.id)}" data-player-name="${escapeHTML(name)}" aria-label="Remover ${escapeHTML(name)} desta partida">×</button>`
      : "";
    const organizerControl =
      interactive && match.isOrganizer
        ? `<label class="match-position-control"><span>Posição</span><select data-reorganize-player data-source-team="${team}" data-source-slot="${slot}" aria-label="Mover ${escapeHTML(name)}">${teamPositionOptions(team, slot)}</select></label>`
        : "";
    return `<div class="match-position"><${playerTag} class="match-player-row"${playerAttributes}>${avatar}<div><strong>${escapeHTML(name)}</strong><small>${escapeHTML(level)}</small></div></${playerTag}>${removeControl}${organizerControl}</div>`;
  }

  function matchPlayerSlots(match, { interactive = false } = {}) {
    const teams = normalizedMatchTeams(match);
    return ["team1", "team2"]
      .map((team, teamIndex) => {
        const positions = teams[team]
          .map((player, slot) =>
            matchPosition(match, team, slot, player, { interactive }),
          )
          .join("");
        return `${teamIndex ? '<span class="match-versus" aria-hidden="true">x</span>' : ""}<div class="match-team"><span class="match-team-label">Dupla ${teamIndex + 1}</span>${positions}</div>`;
      })
      .join("");
  }

  function matchDateLabel(startAt) {
    const date = new Date(startAt);
    const today = localDateKey(new Date());
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const key = localDateKey(date);
    const dayLabel =
      key === today
        ? "Hoje"
        : key === localDateKey(tomorrowDate)
          ? "Amanhã"
          : formatDate(date, {
              weekday: "short",
              day: "2-digit",
              month: "short",
            });
    return `${dayLabel} | ${formatDate(date, { hour: "2-digit", minute: "2-digit" })}`;
  }

  function matchStatus(match) {
    if (match.isFull || Number(match.availableSpots) === 0) return "Confirmado";
    if (Number(match.availableSpots) === 1) return "Falta 1 jogador";
    return `Aberto · ${Number(match.availableSpots) || 0} vagas`;
  }

  function matchLocation(match) {
    const details = [];
    if (
      match.distanceKm !== null &&
      match.distanceKm !== undefined &&
      Number.isFinite(Number(match.distanceKm))
    ) {
      details.push(`${Number(match.distanceKm).toLocaleString("pt-BR")} km`);
    }
    if (match.address) details.push(match.address);
    else if (match.clubAddress) details.push(match.clubAddress);
    if (!details.length && match.courtName) details.push(match.courtName);
    return details.join(" · ");
  }

  // TASKS-11 — rótulos da categoria de gênero.
  const GENDER_CATEGORY_LABELS = {
    women_only: "Só mulheres",
    men_only: "Só homens",
    mixed: "Misto",
  };

  function genderCategoryBadge(match) {
    const label = GENDER_CATEGORY_LABELS[match.genderCategory];
    return label
      ? `<span class="status-badge gender-badge gender-${escapeHTML(match.genderCategory)}">${label}</span>`
      : "";
  }

  function matchCard(match) {
    const unread = state.unreadByMatch.get(match.id) || 0;
    const status = matchStatus(match);
    const gameType = match.gameType || match.type || "Jogo aberto";
    return `<article class="match-card card-hover" data-match-id="${escapeHTML(match.id)}" tabindex="0" role="button" aria-label="Ver detalhes do jogo em ${escapeHTML(match.clubName)}">
      <div class="match-top"><span class="match-date">${escapeHTML(matchDateLabel(match.startAt))} · ${escapeHTML(formatDuration(match.slotDuration))}</span><span class="match-card-badges">${genderCategoryBadge(match)}<span class="status-badge">Quadra reservada</span></span></div>
      <h3>${escapeHTML(match.clubName)}</h3>
      <span class="match-location">${escapeHTML(matchLocation(match))}</span>
      <div class="match-player-list" aria-label="Jogadores e vagas">${matchPlayerSlots(match)}</div>
      <div class="match-detail"><div><small>${escapeHTML(gameType)}</small><strong>Categorias: ${escapeHTML(formatLevelCategories(match))}</strong></div><div><small>Status</small><strong>${escapeHTML(status)}</strong></div></div>
      <div class="match-players"><span>Ver detalhes antes de entrar</span>${unread ? `<span class="nav-count" aria-label="${unread} mensagens não lidas">${unread}</span>` : ""}</div>
      <span class="button button-outline button-block" aria-hidden="true">Ver detalhes</span>
    </article>`;
  }

  function wireMatchCards(grid) {
    $$("[data-match-id]", grid).forEach((card) => {
      const open = () => openMatch(card.dataset.matchId);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  // TASKS-14 / TASK-62 — "Meus jogos" sempre no topo (inclui partidas
  // cheias, que a TASK-61 esconde da listagem pública), e abaixo a
  // listagem normal de jogos disponíveis, sem duplicar.
  function renderMatches() {
    const myId = state.session?.user?.id;
    const mine = state.matches.filter((match) =>
      (match.participantIds ?? []).includes(myId),
    );
    const available = state.matches.filter(
      (match) => !(match.participantIds ?? []).includes(myId),
    );
    const mySection = $("[data-my-matches-section]");
    const myGrid = $("[data-my-matches-grid]");
    if (mySection && myGrid) {
      mySection.classList.toggle("hidden", !mine.length);
      myGrid.innerHTML = mine.map(matchCard).join("");
      wireMatchCards(myGrid);
    }
    const grid = $("[data-match-grid]");
    grid.innerHTML = available.length
      ? available.map(matchCard).join("")
      : emptyState(
          "Nenhum jogo aberto agora.",
          "Crie um jogo em aberto para convidar outros jogadores.",
        );
    wireMatchCards(grid);
  }

  async function loadMatches() {
    try {
      // TASK-50 — filtro por categoria de gênero.
      const filter = $("[data-match-gender-filter]")?.value || "";
      const data = await apiRequest(
        `/api/v1/matches${filter ? `?genderCategory=${encodeURIComponent(filter)}` : ""}`,
      );
      state.matches = data.matches;
      renderPendingResultsBadge(data.pendingResults);
      renderMatches();
      renderProfile();
      refreshUnreadCounts();
    } catch (error) {
      $("[data-match-grid]").innerHTML = emptyState(
        "Não foi possível carregar os jogos.",
        error.message,
      );
    }
  }

  // TASK-33 — partidas cujo horário de início já passou.
  async function loadHistory() {
    const grid = $("[data-history-grid]");
    if (!grid) return;
    try {
      const data = await apiRequest("/api/v1/matches?scope=history");
      state.historyMatches = data.matches;
      renderPendingResultsBadge(data.pendingResults);
      grid.innerHTML = data.matches.length
        ? data.matches.map(matchCard).join("")
        : emptyState(
            "Nenhuma partida no histórico ainda.",
            "Quando o horário de início de um jogo passar, ele aparece aqui.",
          );
      $$("[data-match-id]", grid).forEach((card) => {
        const open = () => openMatch(card.dataset.matchId);
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
      });
    } catch (error) {
      grid.innerHTML = emptyState(
        "Não foi possível carregar o histórico.",
        error.message,
      );
    }
  }

  // TASKS-12 / TASK-46-47 — tela dedicada de Super 8 do jogador.
  // Decisão de produto (mantida do TASKS-09, documentada no backend): os
  // jogos de Super 8 NÃO alteram o nível oficial do jogador.
  function super8MyGameCard(game, myId) {
    const teams = [game.team1, game.team2];
    const myTeamIndex = teams.findIndex((team) =>
      team.some((player) => player.id === myId),
    );
    const finished = game.status === "finalizado";
    const score = finished
      ? `<strong class="super8-my-score">${game.score.team1Games} × ${game.score.team2Games}</strong>`
      : '<span class="status-badge">Aguardando</span>';
    return `<article class="super8-game-card${finished ? " finished" : ""}">
      <div class="super8-game-head"><span class="super8-court-chip">Jogo ${game.order} · ${escapeHTML(game.court.name)}</span></div>
      <div class="super8-versus"><div class="super8-side">${game.team1.map((player) => `<strong${player.id === myId ? ' class="me"' : ""}>${escapeHTML(player.name)}</strong>`).join("")}</div><span class="super8-x" aria-hidden="true">×</span><div class="super8-side right">${game.team2.map((player) => `<strong${player.id === myId ? ' class="me"' : ""}>${escapeHTML(player.name)}</strong>`).join("")}</div></div>
      <div class="super8-game-action">${score}</div>
      ${myTeamIndex >= 0 ? "" : ""}
    </article>`;
  }

  // TASK-95 — data + horário do torneio, formatados para exibição.
  function super8DateTimeLabel(tournament) {
    const parts = [];
    if (tournament.date) {
      parts.push(
        formatDate(`${tournament.date}T12:00:00-03:00`, {
          day: "2-digit",
          month: "short",
        }),
      );
    }
    if (tournament.startTime) parts.push(tournament.startTime);
    return parts.length ? parts.join(" · ") : "Data a definir";
  }

  function super8CourtsSummary(tournament) {
    const count = tournament.courts?.length || 0;
    if (!count) return "Quadra a definir";
    return count === 1 ? tournament.courts[0].name : `${count} quadras`;
  }

  // TASK-94 — mesma hierarquia visual do card do clube: contador de vagas
  // em destaque no canto superior direito, corpo com nome/clube/categorias,
  // rodapé com data/horário e quadras.
  function super8OpenCard(tournament) {
    const modeLabel =
      tournament.mode === "duplas_fixas"
        ? "Duplas fixas"
        : "Cada um por si (rotação)";
    const categoriesLabel = tournament.levelCategories
      ? tournament.levelCategories.join(", ")
      : "Todas as categorias";
    return `<article class="super8-card card-hover" data-super8-open-row="${escapeHTML(tournament.id)}" tabindex="0" role="button" aria-label="Ver detalhes de ${escapeHTML(tournament.name)}">
      <div class="super8-card-top">
        <div><span class="status-badge">${tournament.alreadyJoined ? "Inscrito" : "Inscrições abertas"}</span><span class="super8-card-mode">${escapeHTML(modeLabel)}</span></div>
        <span class="super8-players-badge">${tournament.enrolled}/${tournament.size}</span>
      </div>
      <h3>${escapeHTML(tournament.name)}</h3>
      <p class="super8-card-categories">${escapeHTML(tournament.clubName)} · ${escapeHTML(categoriesLabel)}</p>
      <div class="super8-card-footer"><span>${escapeHTML(super8DateTimeLabel(tournament))}</span><span>${escapeHTML(super8CourtsSummary(tournament))}</span></div>
    </article>`;
  }

  function super8StandingsTable(tournament) {
    if (!tournament.standings?.length) return "";
    const myId = state.session?.user?.id;
    const rows = tournament.standings
      .map(
        (row) =>
          `<tr${row.key === myId ? ' class="current-band"' : ""}><td>#${row.position}</td><td>${escapeHTML(row.names.join(" + "))}${row.key === myId ? " (você)" : ""}</td><td>${row.wins}</td><td>${row.played}</td><td>${row.balance > 0 ? "+" : ""}${row.balance}</td></tr>`,
      )
      .join("");
    return `<div class="super8-standings"><p class="micro-label">Tabela final</p><div class="super8-grid-scroll"><table class="level-bands-table super8-table"><thead><tr><th scope="col">Pos.</th><th scope="col">${tournament.mode === "duplas_fixas" ? "Dupla" : "Jogador"}</th><th scope="col">Vitórias</th><th scope="col">Jogos</th><th scope="col">Saldo</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  async function openSuper8Screen() {
    const myId = state.session?.user?.id;
    const mineList = $("[data-super8-mine-list]");
    const openList = $("[data-super8-open-list]");
    try {
      const { tournaments } = await apiRequest("/api/v1/players/super8/mine");
      mineList.innerHTML = tournaments?.length
        ? tournaments
            .map((tournament, index) => {
              const myGames = tournament.games.filter((game) =>
                [...game.team1, ...game.team2].some(
                  (player) => player.id === myId,
                ),
              );
              return `<details class="ranking-category super8-player-card"${index === 0 ? " open" : ""}><summary><span class="ranking-category-title">${escapeHTML(tournament.name)}</span><span class="ranking-category-meta">${escapeHTML(tournament.clubName)} · ${escapeHTML(super8DateTimeLabel(tournament))} · ${tournament.gamesFinished}/${tournament.gamesTotal} jogos · ${tournament.status === "finalizado" ? "Finalizado" : "Em andamento"}</span></summary>${super8StandingsTable(tournament)}<div class="super8-games">${myGames.map((game) => super8MyGameCard(game, myId)).join("")}</div></details>`;
            })
            .join("")
        : '<p class="profile-data-note">Você ainda não participa de nenhum Super 8.</p>';
    } catch (error) {
      mineList.innerHTML = `<p class="profile-data-note">${escapeHTML(error.message)}</p>`;
    }
    // TASK-76: o botão de inscrição só aparece dentro da tela de detalhe —
    // a listagem é só um resumo clicável.
    try {
      const { tournaments } = await apiRequest("/api/v1/players/super8/open");
      state.super8Open = tournaments || [];
      openList.innerHTML = state.super8Open.length
        ? state.super8Open.map(super8OpenCard).join("")
        : '<p class="profile-data-note">Nenhum Super 8 com inscrições abertas no momento.</p>';
      $$("[data-super8-open-row]", openList).forEach((row) => {
        const open = () => {
          const tournament = state.super8Open.find(
            (item) => item.id === row.dataset.super8OpenRow,
          );
          if (tournament) openSuper8PlayerDetail(tournament);
        };
        row.addEventListener("click", open);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
      });
    } catch (error) {
      openList.innerHTML = `<p class="profile-data-note">${escapeHTML(error.message)}</p>`;
    }
  }

  // TASK-76 — tela de detalhe completo do Super 8, mostrada antes de
  // qualquer inscrição (clube/endereço, data/horário, vagas, modalidade,
  // categorias, jogadores confirmados com foto/nível e quadras).
  function super8RosterRow(player) {
    const name = player.name || "Jogador";
    const photoUrl = safePhotoUrl(player.photoUrl);
    const avatar = photoUrl
      ? `<span class="match-player-avatar"><img src="${escapeHTML(photoUrl)}" alt="" /></span>`
      : `<span aria-hidden="true">${escapeHTML(initialsFor(name))}</span>`;
    return `<div class="match-player-row">${avatar}<div><strong>${escapeHTML(name)}</strong><small>${escapeHTML(matchPlayerLevel(player))}</small></div></div>`;
  }

  function openSuper8PlayerDetail(tournament) {
    const modal = $("[data-super8-player-detail-modal]");
    $("[data-super8-player-detail-title]").textContent = tournament.name;
    const modeLabel =
      tournament.mode === "duplas_fixas"
        ? "Duplas fixas"
        : "Cada um por si (rotação)";
    const categoriesLabel = tournament.levelCategories
      ? tournament.levelCategories.join(", ")
      : "Todas as categorias";
    const courtsLabel = tournament.courts?.length
      ? tournament.courts.map((court) => escapeHTML(court.name)).join(", ")
      : "A definir";
    $("[data-super8-player-detail-content]").innerHTML = `
      <p class="super8-start-time">${escapeHTML(tournament.clubName)}${tournament.clubAddress ? ` · ${escapeHTML(tournament.clubAddress)}` : ""}</p>
      <div class="super8-datetime-highlight"><div><small>Data</small><strong>${tournament.date ? escapeHTML(formatDate(`${tournament.date}T12:00:00-03:00`, { weekday: "short", day: "2-digit", month: "short" })) : "A definir"}</strong></div><div><small>Horário de início</small><strong>${tournament.startTime ? escapeHTML(tournament.startTime) : "A definir"}</strong></div></div>
      <div class="match-detail super8-meta">
        <div><small>Vagas</small><strong>${tournament.enrolled}/${tournament.size}</strong></div>
        <div><small>Modalidade</small><strong>${escapeHTML(modeLabel)}</strong></div>
        <div><small>Categorias permitidas</small><strong>${escapeHTML(categoriesLabel)}</strong></div>
        <div><small>Quadras</small><strong>${courtsLabel}</strong></div>
      </div>
      <div class="super8-section"><p class="micro-label">Jogadores confirmados (${tournament.players.length}/${tournament.size})</p>${
        tournament.players.length
          ? tournament.players.map(super8RosterRow).join("")
          : '<p class="profile-data-note">Nenhum jogador confirmado ainda.</p>'
      }</div>`;
    const joinButton = $("[data-super8-player-detail-join]");
    joinButton.classList.toggle("hidden", Boolean(tournament.alreadyJoined));
    joinButton.disabled = false;
    joinButton.textContent = "Inscrever-se";
    joinButton.onclick = () => joinSuper8(joinButton, tournament.id);
    openModal(modal);
  }

  async function joinSuper8(button, tournamentId) {
    setBusy(button, true, "Inscrevendo…");
    try {
      const { tournament } = await apiRequest(
        `/api/v1/players/super8/${encodeURIComponent(tournamentId)}/join`,
        { method: "POST" },
      );
      showToast(
        `Inscrição confirmada em ${tournament.name} (${tournament.players}/${tournament.size}).`,
      );
      closeModal($("[data-super8-player-detail-modal]"));
      openSuper8Screen();
    } catch (error) {
      showToast(error.message);
      if (button.isConnected) setBusy(button, false);
    }
  }

  // TASK-35 — badge coral de partidas aguardando lançamento/confirmação.
  function renderPendingResultsBadge(count) {
    const badge = $("[data-history-count]");
    if (!badge || count === undefined || count === null) return;
    const pending = Number(count) || 0;
    badge.textContent = pending ? String(pending) : "";
    badge.classList.toggle("hidden", pending === 0);
  }

  function renderMatchDetail(match) {
    const content = $("[data-match-detail-content]");
    const participant = matchParticipant(match);
    content.innerHTML = `
      <div class="match-top"><p class="eyebrow dark">${escapeHTML(matchDateLabel(match.startAt))}</p><span class="match-card-badges">${genderCategoryBadge(match)}<span class="status-badge">Quadra reservada</span></span></div>
      <h2>${escapeHTML(match.clubName)}</h2>
      <p class="match-location">${escapeHTML(matchLocation(match))}</p>
      <div class="match-detail-summary">
        <div><small>Quadra</small><strong>${escapeHTML(match.courtName)}</strong></div>
        <div><small>Preço de referência</small><strong>${escapeHTML(formatCurrency(match.referencePrice))}</strong></div>
        <div><small>Categorias</small><strong>${escapeHTML(formatLevelCategories(match))}</strong></div>
        <div><small>Duração</small><strong>${escapeHTML(formatDuration(match.slotDuration))}</strong></div>
        <div><small>Data e hora</small><strong>${escapeHTML(formatDate(match.startAt, { day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }))}</strong></div>
        <div><small>Jogadores</small><strong>${Math.min(match.participantIds?.length || match.players?.length || 0, 4)}/4 confirmados</strong></div>
        <div><small>Status</small><strong>${escapeHTML(matchStatus(match))}</strong></div>
      </div>
      <h3>Jogadores confirmados</h3>
      ${match.isOrganizer ? '<p class="match-organizer-note">Como organizador, use o seletor de cada jogador para trocar as posições.</p>' : ""}
      <div class="match-player-list">${matchPlayerSlots(match, { interactive: true })}</div>
      ${participant ? matchResultSection(match) : ""}
      ${participant ? `<section class="info-card" aria-labelledby="match-chat-title"><div class="panel-heading"><div><p class="micro-label">Somente participantes</p><h3 id="match-chat-title">Chat da partida</h3></div><span class="status-badge" data-chat-status>Atualizando</span></div><div class="match-chat-list" data-match-messages role="log" aria-live="polite" aria-relevant="additions" tabindex="0"><p class="profile-data-note">Carregando mensagens…</p></div><form data-match-chat-form><label class="input-group"><span>Mensagem</span><textarea name="content" rows="2" maxlength="500" placeholder="Escreva para os jogadores" required></textarea></label><button class="button button-primary button-block" type="submit" data-chat-send>Enviar mensagem</button></form></section>` : ""}
      ${participant && !match.isOrganizer ? '<button class="button button-outline button-block" type="button" data-match-leave>Sair do jogo</button>' : ""}`;

    const joinButton = $("[data-match-detail-join]");
    joinButton.classList.add("hidden");
    joinButton.disabled = true;
    if (participant) {
      $("[data-match-chat-form]")?.addEventListener("submit", sendChatMessage);
      $("[data-match-leave]")?.addEventListener("click", leaveCurrentMatch);
      $("[data-open-result-form]")?.addEventListener("click", openResultForm);
      $("[data-confirm-result]")?.addEventListener(
        "click",
        confirmMatchResult,
      );
    }
  }

  function matchStarted(match) {
    return new Date(match.startAt).getTime() <= Date.now();
  }

  // TASK-17B/TASK-34 — bloco de resultado no detalhe da partida. O
  // lançamento só fica disponível quando a partida já está no Histórico
  // (horário de início passou) e com as duas duplas completas.
  function matchResultSection(match) {
    if (!match.isFull || !matchStarted(match)) return "";
    const result = state.currentMatchResult;
    const setsLine = (sets) =>
      sets
        .map((set) => `${set.team1}–${set.team2}`)
        .join(" · ");
    if (!result) {
      return `<section class="info-card match-result-card"><div class="panel-heading"><div><p class="micro-label">Partida completa</p><h3>Resultado</h3></div></div><p class="profile-data-note">As duas duplas estão completas. Lance o placar para atualizar o nível dos jogadores.</p><button class="button button-primary button-block" type="button" data-open-result-form>Fechar jogo e lançar resultado</button></section>`;
    }
    const winnerLabel = result.winningTeam === "team1" ? "Dupla 1" : "Dupla 2";
    if (result.status === "confirmed") {
      return `<section class="info-card match-result-card"><div class="panel-heading"><div><p class="micro-label">Resultado confirmado</p><h3>${escapeHTML(winnerLabel)} venceu</h3></div><span class="status-badge">Confirmado</span></div><p class="match-result-sets">${escapeHTML(setsLine(result.sets))}</p>${levelChangesPanel(result)}</section>`;
    }
    if (result.canConfirm) {
      return `<section class="info-card match-result-card"><div class="panel-heading"><div><p class="micro-label">Aguardando você</p><h3>Confirmar resultado</h3></div><span class="status-badge">Pendente</span></div><p class="match-result-sets">${escapeHTML(setsLine(result.sets))} · vitória da ${escapeHTML(winnerLabel)}</p><p class="profile-data-note">Lançado por ${escapeHTML(result.reporterName || "um jogador")}. Confirme para efetivar o resultado e atualizar os níveis.</p><button class="button button-primary button-block" type="button" data-confirm-result>Confirmar resultado</button><button class="button button-outline button-block" type="button" data-open-result-form>Corrigir placar</button></section>`;
    }
    return `<section class="info-card match-result-card"><div class="panel-heading"><div><p class="micro-label">Resultado lançado</p><h3>Aguardando confirmação</h3></div><span class="status-badge">Pendente</span></div><p class="match-result-sets">${escapeHTML(setsLine(result.sets))} · vitória da ${escapeHTML(winnerLabel)}</p><p class="profile-data-note">Um jogador da dupla adversária precisa confirmar para o resultado valer.</p><button class="button button-outline button-block" type="button" data-open-result-form>Corrigir placar</button></section>`;
  }

  // TASK-36 — variação de nível dos 4 jogadores, persistida junto ao
  // resultado e visível sempre que a partida for revisitada no Histórico.
  function levelChangesPanel(result) {
    const changes = result.levelChanges;
    if (!changes || !Object.keys(changes).length) {
      return '<p class="profile-data-note">O nível dos 4 jogadores foi recalculado com este resultado.</p>';
    }
    const rows = Object.entries(changes)
      .sort(([, a], [, b]) => (a.team === b.team ? 0 : a.team === "team1" ? -1 : 1))
      .map(([playerId, change]) => {
        const name = change.displayName || "Jogador";
        const photoUrl = safePhotoUrl(change.photoUrl);
        const avatar = photoUrl
          ? `<span class="ranking-avatar"><img src="${escapeHTML(photoUrl)}" alt="" /></span>`
          : `<span class="ranking-avatar" aria-hidden="true">${escapeHTML(initialsFor(name) || "—")}</span>`;
        const delta = Number(change.delta) || 0;
        const gained = delta >= 0;
        const deltaLabel = `${gained ? "+" : "−"}${Math.abs(delta).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
        return `<div class="level-change-row">${avatar}<span class="connection-info"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(formatLevel(change.previousLevel))} → ${escapeHTML(formatLevel(change.level))} · ${change.team === "team1" ? "Dupla 1" : "Dupla 2"}</small></span><span class="level-delta ${gained ? "delta-up" : "delta-down"}">${escapeHTML(deltaLabel)}</span></div>`;
      })
      .join("");
    return `<div class="level-changes"><p class="micro-label">Variação de nível</p>${rows}</div>`;
  }

  async function loadCurrentMatchResult(match) {
    state.currentMatchResult = null;
    if (!match?.isFull || !matchParticipant(match)) return;
    try {
      const { result } = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(match.id)}/result`,
      );
      state.currentMatchResult = result;
    } catch {
      state.currentMatchResult = null;
    }
  }

  function openResultForm() {
    const modal = $("[data-match-result-modal]");
    const form = $("[data-match-result-form]", modal);
    form.reset();
    const existing = state.currentMatchResult;
    if (existing?.sets?.length === 3) {
      existing.sets.forEach((set, index) => {
        form.elements[`set${index + 1}_team1`].value = set.team1;
        form.elements[`set${index + 1}_team2`].value = set.team2;
      });
    }
    updateResultPreview();
    openAccessibleModal(modal, '[name="set1_team1"]');
  }

  function readResultSets(form) {
    const sets = [];
    for (let index = 1; index <= 3; index += 1) {
      const team1 = form.elements[`set${index}_team1`].value;
      const team2 = form.elements[`set${index}_team2`].value;
      if (team1 === "" || team2 === "") return null;
      const parsed = { team1: Number(team1), team2: Number(team2) };
      if (
        !Number.isInteger(parsed.team1) ||
        !Number.isInteger(parsed.team2) ||
        parsed.team1 < 0 ||
        parsed.team1 > 7 ||
        parsed.team2 < 0 ||
        parsed.team2 > 7 ||
        parsed.team1 === parsed.team2
      ) {
        return null;
      }
      sets.push(parsed);
    }
    return sets;
  }

  function updateResultPreview() {
    const form = $("[data-match-result-form]");
    if (!form) return;
    const sets = readResultSets(form);
    const preview = $("[data-result-winner-preview]");
    const submit = $("[data-result-submit]", form);
    if (!sets) {
      preview.textContent =
        "Preencha os 3 sets (games de 0 a 7, sem empate) para habilitar o envio.";
      submit.disabled = true;
      return;
    }
    const team1Sets = sets.filter((set) => set.team1 > set.team2).length;
    const winner = team1Sets >= 2 ? "Dupla 1" : "Dupla 2";
    preview.textContent = `Vitória da ${winner} (${team1Sets >= 2 ? team1Sets : 3 - team1Sets} sets a ${team1Sets >= 2 ? 3 - team1Sets : team1Sets}).`;
    submit.disabled = false;
  }

  async function submitMatchResult(event) {
    event.preventDefault();
    if (!state.currentMatch?.id) return;
    const form = event.currentTarget;
    const sets = readResultSets(form);
    if (!sets) return;
    const button = $("[data-result-submit]", form);
    setBusy(button, true, "Enviando…");
    try {
      const team1Sets = sets.filter((set) => set.team1 > set.team2).length;
      const { result } = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/result`,
        {
          method: "POST",
          body: {
            sets,
            winningTeam: team1Sets >= 2 ? "team1" : "team2",
          },
        },
      );
      state.currentMatchResult = result;
      closeModal($("[data-match-result-modal]"));
      renderMatchDetail(state.currentMatch);
      if (matchParticipant(state.currentMatch)) await loadChatMessages(false);
      loadHistory();
      showToast(
        "Resultado lançado. Um jogador da dupla adversária precisa confirmar.",
      );
    } catch (error) {
      showToast(error.message);
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  async function confirmMatchResult(event) {
    if (!state.currentMatch?.id) return;
    const button = event.currentTarget;
    const confirmed = await confirmAction({
      eyebrow: "Confirmação cruzada",
      title: "Confirmar este resultado?",
      message:
        "Ao confirmar, o resultado vira definitivo e o nível dos 4 jogadores é recalculado. Esta ação não pode ser desfeita.",
      confirmLabel: "Confirmar resultado",
      cancelLabel: "Voltar",
    });
    if (!confirmed) return;
    setBusy(button, true, "Confirmando…");
    try {
      const { result, levelChanges, achievementsUnlocked = [] } = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/result/confirm`,
        { method: "POST" },
      );
      state.currentMatchResult = result;
      renderMatchDetail(state.currentMatch);
      loadHistory();
      const myChange = levelChanges?.[state.session?.user?.id];
      if (achievementsUnlocked.length) {
        showToast(`🏆 Nova conquista desbloqueada: ${achievementsUnlocked[0].name}!`);
      } else if (myChange) {
        const direction = myChange.delta >= 0 ? "+" : "";
        showToast(
          `Resultado confirmado. Seu nível: ${formatLevel(myChange.previousLevel)} → ${formatLevel(myChange.level)} (${direction}${myChange.delta.toLocaleString("pt-BR")}).`,
        );
      } else {
        showToast("Resultado confirmado. Os níveis foram atualizados.");
      }
      await refreshSessionProfile();
    } catch (error) {
      showToast(error.message);
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  async function refreshSessionProfile() {
    try {
      const data = await apiRequest("/api/v1/player/profile");
      if (data?.user && state.session) {
        state.session.user = data.user;
        renderProfile();
        loadProfileExtras();
      }
    } catch {
      /* silencioso: o perfil é atualizado na próxima navegação */
    }
  }

  // TASK-13: participante (não organizador) pode sair do jogo, liberando a
  // vaga. O organizador não vê este botão — para desistir ele cancela o
  // jogo inteiro (regra reforçada também no backend).
  async function leaveCurrentMatch(event) {
    if (!state.currentMatch?.id) return;
    const button = event.currentTarget;
    const confirmed = await confirmAction({
      eyebrow: "Sair da partida",
      title: "Sair deste jogo?",
      message:
        "Tem certeza que deseja sair deste jogo? Sua vaga ficará disponível para outro jogador.",
      confirmLabel: "Confirmar saída",
      cancelLabel: "Cancelar",
    });
    if (!confirmed) return;
    setBusy(button, true, "Saindo…");
    try {
      const matchId = state.currentMatch.id;
      await apiRequest(`/api/v1/matches/${encodeURIComponent(matchId)}/leave`, {
        method: "POST",
      });
      stopChatPolling();
      closeModal($("[data-match-detail-modal]"));
      state.currentMatch = null;
      await Promise.all([loadMatches(), loadBookings()]);
      showToast("Você saiu do jogo. A vaga foi liberada.");
    } catch (error) {
      showToast(error.message);
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  async function openMatch(id) {
    stopChatPolling();
    try {
      const { match } = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(id)}`,
      );
      state.currentMatch = match;
      await loadCurrentMatchResult(match);
      renderMatchDetail(match);
      const modal = $("[data-match-detail-modal]");
      openAccessibleModal(
        modal,
        matchParticipant(match)
          ? "[data-match-chat-form] textarea"
          : "[data-join-position]",
      );
      if (matchParticipant(match)) {
        await loadChatMessages(true);
        startChatPolling();
      }
    } catch (error) {
      showToast(error.message);
    }
  }

  async function joinCurrentMatch(event) {
    if (!state.currentMatch?.id) return;
    setBusy(event.currentTarget, true, "Entrando…");
    try {
      await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/join`,
        { method: "POST" },
      );
      await Promise.all([loadMatches(), loadBookings()]);
      await openMatch(state.currentMatch.id);
      showToast("Você entrou no jogo. O chat já está disponível.");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(event.currentTarget, false);
    }
  }

  async function joinMatchPosition(button) {
    if (!state.currentMatch?.id) return;
    setBusy(button, true, "Entrando…");
    try {
      await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/join`,
        {
          method: "POST",
          body: {
            team: button.dataset.team,
            slot: Number(button.dataset.slot),
          },
        },
      );
      const matchId = state.currentMatch.id;
      await Promise.all([loadMatches(), loadBookings()]);
      await openMatch(matchId);
      showToast("Você entrou nesta vaga. O chat já está disponível.");
    } catch (error) {
      showToast(error.message);
      if (error.code === "match_position_taken") {
        await openMatch(state.currentMatch.id);
      }
    } finally {
      setBusy(button, false);
    }
  }

  // TASK-32: organizador remove outro jogador da partida (com confirmação).
  async function removePlayerFromMatch(button) {
    if (!state.currentMatch?.id) return;
    const playerId = button.dataset.removePlayer;
    const playerName = button.dataset.playerName || "este jogador";
    const confirmed = await confirmAction({
      eyebrow: "Remover jogador",
      title: `Remover ${playerName} desta partida?`,
      message:
        "A vaga ficará disponível para outro jogador. Essa pessoa poderá entrar novamente se houver vaga.",
      confirmLabel: "Confirmar remoção",
      cancelLabel: "Cancelar",
    });
    if (!confirmed) return;
    setBusy(button, true, "…");
    try {
      const { match } = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/remove-player`,
        { method: "POST", body: { playerId } },
      );
      state.currentMatch = match;
      renderMatchDetail(match);
      await Promise.all([loadMatches(), loadBookings()]);
      showToast(`${playerName} foi removido. A vaga está livre.`);
    } catch (error) {
      showToast(error.message);
      if (button.isConnected) setBusy(button, false);
    }
  }

  // TASK-12: participante se move para uma vaga vazia.
  async function moveSelfToPosition(button) {
    if (!state.currentMatch?.id) return;
    setBusy(button, true, "Movendo…");
    try {
      const { match } = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/position`,
        {
          method: "PATCH",
          body: {
            team: button.dataset.team,
            slot: Number(button.dataset.slot),
          },
        },
      );
      state.currentMatch = match;
      renderMatchDetail(match);
      await Promise.all([loadMatches(), loadBookings()]);
      if (matchParticipant(match)) await loadChatMessages(false);
      showToast("Você trocou de vaga.");
    } catch (error) {
      showToast(error.message);
      if (error.code === "match_position_taken") {
        await openMatch(state.currentMatch.id);
      }
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  function matchTeamIds(match) {
    if (match.teamIds) {
      return {
        team1: [...match.teamIds.team1],
        team2: [...match.teamIds.team2],
      };
    }
    const teams = normalizedMatchTeams(match);
    return Object.fromEntries(
      Object.entries(teams).map(([team, players]) => [
        team,
        players.map((player) => player?.id || null),
      ]),
    );
  }

  async function reorganizeMatchPlayer(select) {
    if (!state.currentMatch?.id || !state.currentMatch.isOrganizer) return;
    const sourceTeam = select.dataset.sourceTeam;
    const sourceSlot = Number(select.dataset.sourceSlot);
    const [targetTeam, targetSlotValue] = select.value.split(":");
    const targetSlot = Number(targetSlotValue);
    if (sourceTeam === targetTeam && sourceSlot === targetSlot) return;
    const teams = matchTeamIds(state.currentMatch);
    const movingPlayer = teams[sourceTeam][sourceSlot];
    const targetPlayer = teams[targetTeam][targetSlot];
    teams[targetTeam][targetSlot] = movingPlayer;
    teams[sourceTeam][sourceSlot] = targetPlayer;
    select.disabled = true;
    try {
      const { match } = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/teams`,
        { method: "PATCH", body: { teams } },
      );
      state.currentMatch = match;
      renderMatchDetail(match);
      await Promise.all([loadMatches(), loadBookings()]);
      if (matchParticipant(match)) await loadChatMessages(false);
      showToast("Duplas reorganizadas.");
    } catch (error) {
      showToast(error.message);
      renderMatchDetail(state.currentMatch);
      if (matchParticipant(state.currentMatch)) await loadChatMessages(false);
    }
  }

  function messagePlayer(message) {
    return message.player || message.author || {};
  }

  function messagePlayerId(message) {
    return (
      message.playerId ||
      message.senderId ||
      message.userId ||
      message.player?.id
    );
  }

  function messageTimestamp(message) {
    const timestamp = new Date(message.createdAt).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function renderChatMessages(messages) {
    const container = $("[data-match-messages]");
    if (!container) return;
    container.innerHTML = messages.length
      ? messages
          .map((message) => {
            const player = messagePlayer(message);
            const name = player.displayName || player.name || "Jogador";
            const initials = player.initials || initialsFor(name) || "—";
            const playerId = messagePlayerId(message);
            const date = message.createdAt
              ? formatDate(message.createdAt, {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "";
            const tag = playerId ? "button" : "div";
            const attributes = playerId
              ? ` type="button" data-public-player="${escapeHTML(playerId)}" aria-label="Ver perfil de ${escapeHTML(name)}"`
              : "";
            return `<${tag} class="match-player-row"${attributes}><span aria-hidden="true">${escapeHTML(initials)}</span><div><strong>${escapeHTML(name)}</strong><small>${escapeHTML(message.content)}</small></div>${date ? `<time datetime="${escapeHTML(message.createdAt)}">${escapeHTML(date)}</time>` : ""}</${tag}>`;
          })
          .join("")
      : '<p class="profile-data-note">Ainda não há mensagens. Comece a conversa sobre a partida.</p>';
    container.scrollTop = container.scrollHeight;
  }

  function readStateKey(matchId) {
    return `quadrafy:match-read:${state.session?.user?.id || "player"}:${matchId}`;
  }

  function storedReadState(matchId) {
    try {
      return (
        JSON.parse(localStorage.getItem(readStateKey(matchId)) || "{}") || {}
      );
    } catch {
      return {};
    }
  }

  function markMessagesRead(matchId, messages) {
    const latest = messages.reduce(
      (current, message) =>
        messageTimestamp(message) >= (current.createdAt || 0)
          ? { id: message.id, createdAt: messageTimestamp(message) }
          : current,
      { id: null, createdAt: 0 },
    );
    if (latest.id || latest.createdAt) {
      localStorage.setItem(readStateKey(matchId), JSON.stringify(latest));
    }
    state.unreadByMatch.set(matchId, 0);
    updateUnreadBadge();
  }

  function unreadMessageCount(matchId, messages) {
    const seen = storedReadState(matchId);
    const ownId = state.session?.user?.id;
    if (seen.createdAt) {
      return messages.filter(
        (message) =>
          messagePlayerId(message) !== ownId &&
          messageTimestamp(message) > Number(seen.createdAt),
      ).length;
    }
    if (seen.id) {
      const index = messages.findIndex((message) => message.id === seen.id);
      return messages
        .slice(index + 1)
        .filter((message) => messagePlayerId(message) !== ownId).length;
    }
    return messages.filter((message) => messagePlayerId(message) !== ownId)
      .length;
  }

  function updateUnreadBadge() {
    const total = [...state.unreadByMatch.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    const badge = $("[data-match-unread-count]");
    badge.textContent = String(total);
    badge.classList.toggle("hidden", total === 0);
    badge.setAttribute(
      "aria-label",
      `${total} ${total === 1 ? "mensagem não lida" : "mensagens não lidas"}`,
    );
    if ($('[data-player-view="matches"]')?.classList.contains("active")) {
      renderMatches();
    }
  }

  async function loadChatMessages(markRead = false) {
    const matchId = state.currentMatch?.id;
    if (!matchId || !matchParticipant(state.currentMatch)) return;
    try {
      const data = await apiRequest(
        `/api/v1/matches/${encodeURIComponent(matchId)}/messages?limit=100`,
      );
      if (state.currentMatch?.id !== matchId) return;
      state.chatMessages = data.messages || [];
      renderChatMessages(state.chatMessages);
      const status = $("[data-chat-status]");
      if (status) status.textContent = "Atualizado";
      if (markRead) markMessagesRead(matchId, state.chatMessages);
    } catch (error) {
      const status = $("[data-chat-status]");
      if (status) status.textContent = "Sem conexão";
      if (markRead) showToast(error.message);
    }
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    if (!state.currentMatch?.id) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem("content");
    const content = input.value.trim();
    if (!content) return;
    const button = $("[data-chat-send]", form);
    setBusy(button, true, "Enviando…");
    try {
      await apiRequest(
        `/api/v1/matches/${encodeURIComponent(state.currentMatch.id)}/messages`,
        { method: "POST", body: { content } },
      );
      input.value = "";
      await loadChatMessages(true);
      input.focus();
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function stopChatPolling() {
    clearInterval(state.chatPollTimer);
    state.chatPollTimer = null;
  }

  function startChatPolling() {
    stopChatPolling();
    state.chatPollTimer = setInterval(() => {
      const modal = $("[data-match-detail-modal]");
      if (!modal?.classList.contains("open")) {
        stopChatPolling();
        return;
      }
      if (!document.hidden) loadChatMessages(true);
    }, CHAT_POLL_INTERVAL);
  }

  async function refreshUnreadCounts() {
    if (state.refreshingUnread || document.hidden || !state.session) return;
    const participantMatches = state.matches.filter(matchParticipant);
    if (!participantMatches.length) {
      state.unreadByMatch.clear();
      updateUnreadBadge();
      return;
    }
    state.refreshingUnread = true;
    try {
      await Promise.all(
        participantMatches.map(async (match) => {
          if (
            state.currentMatch?.id === match.id &&
            $("[data-match-detail-modal]")?.classList.contains("open")
          ) {
            return;
          }
          try {
            const data = await apiRequest(
              `/api/v1/matches/${encodeURIComponent(match.id)}/messages?limit=100`,
            );
            state.unreadByMatch.set(
              match.id,
              unreadMessageCount(match.id, data.messages || []),
            );
          } catch {
            state.unreadByMatch.delete(match.id);
          }
        }),
      );
      updateUnreadBadge();
    } finally {
      state.refreshingUnread = false;
    }
  }

  // TASK-14: Ranking de nível.
  function rankingRow(player, isMe) {
    const name = player.displayName || "Jogador";
    const photoUrl = safePhotoUrl(player.photoUrl);
    const avatar = photoUrl
      ? `<span class="ranking-avatar"><img src="${escapeHTML(photoUrl)}" alt="" /></span>`
      : `<span class="ranking-avatar" aria-hidden="true">${escapeHTML(initialsFor(name) || "—")}</span>`;
    const details = [player.levelCategory, player.city]
      .filter(Boolean)
      .join(" · ");
    return `<button class="ranking-row${isMe ? " ranking-row-me" : ""}" type="button" data-public-player="${escapeHTML(player.id)}" aria-label="Ver perfil de ${escapeHTML(name)}">
      <span class="ranking-position">#${player.rank}</span>
      ${avatar}
      <span class="ranking-info"><strong>${escapeHTML(name)}${isMe ? " (você)" : ""}</strong><small>${escapeHTML(details || "—")}</small></span>
      <span class="ranking-level"><strong>${escapeHTML(formatLevel(player.level))}</strong><small>Nível</small></span>
    </button>`;
  }

  async function loadRanking() {
    const list = $("[data-ranking-list]");
    const meBanner = $("[data-ranking-me]");
    if (!list) return;
    try {
      const data = await apiRequest("/api/v1/players/ranking");
      const myId = state.session?.user?.id;
      const myGroup = data.me?.technical ?? null;
      const groupsWithPlayers = (data.groups || []).filter(
        (group) => group.players.length,
      );
      // TASK-31: seções por categoria (accordion); a categoria do próprio
      // jogador abre expandida por padrão.
      list.innerHTML = groupsWithPlayers.length
        ? groupsWithPlayers
            .map((group) => {
              const isMine = group.technical === myGroup;
              const rows = group.players
                .map((player) => rankingRow(player, player.id === myId))
                .join("");
              return `<details class="ranking-category${isMine ? " ranking-category-mine" : ""}"${isMine ? " open" : ""}><summary><span class="ranking-category-title">${escapeHTML(group.label)}</span><span class="ranking-category-meta">${group.players.length} ${group.players.length === 1 ? "jogador" : "jogadores"}${isMine ? " · sua categoria" : ""}</span></summary><div class="ranking-list">${rows}</div></details>`;
            })
            .join("")
        : emptyState(
            "Ainda não há jogadores no ranking.",
            "Complete seu teste de nível para aparecer aqui.",
          );
      if (data.me) {
        meBanner.innerHTML = `Você está em <strong>#${data.me.rank}º lugar</strong> de ${data.me.groupTotal} na categoria <strong>${escapeHTML(data.me.technical)} · ${escapeHTML(data.me.category)}</strong>, com nível <strong>${escapeHTML(formatLevel(data.me.level))}</strong>.`;
        meBanner.classList.remove("hidden");
      } else {
        meBanner.innerHTML =
          "Você ainda não aparece no ranking. Complete o teste de nível no seu perfil.";
        meBanner.classList.remove("hidden");
      }
    } catch (error) {
      list.innerHTML = emptyState(
        "Não foi possível carregar o ranking.",
        error.message,
      );
      meBanner.classList.add("hidden");
    }
  }

  function renderPublicPlayerProfile(player, achievements = []) {
    const content = $("[data-public-player-content]");
    const name = player.displayName || "Jogador";
    const photoUrl = safePhotoUrl(player.photoUrl);
    const avatar = photoUrl
      ? `<img src="${escapeHTML(photoUrl)}" alt="Foto de ${escapeHTML(name)}" />`
      : `<span aria-hidden="true">${escapeHTML(initialsFor(name) || "—")}</span>`;
    const level = Number.isFinite(Number(player.level))
      ? formatLevel(player.level)
      : "Não informado";
    const matchesPlayed = Number(player.stats?.matchesPlayed || 0);
    const wins =
      player.stats?.wins !== null &&
      player.stats?.wins !== undefined &&
      Number.isFinite(Number(player.stats.wins))
      ? Number(player.stats.wins)
      : null;
    const winRate =
      player.stats?.winRate !== null &&
      player.stats?.winRate !== undefined &&
      Number.isFinite(Number(player.stats.winRate))
      ? `${Number(player.stats.winRate).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`
      : "—";
    content.innerHTML = `
      <div class="public-player-heading">
        <div class="public-player-avatar">${avatar}</div>
        <div>
          <p class="eyebrow dark">Jogador Quadrafy</p>
          <h2 id="public-player-title">${escapeHTML(name)}</h2>
          <p>${escapeHTML(player.city || "Cidade não informada")}</p>
        </div>
      </div>
      <div class="public-player-level"><small>Nível numérico</small><strong>${escapeHTML(level)}</strong></div>
      <div class="public-player-stats" aria-label="Estatísticas públicas">
        <span><strong>${matchesPlayed}</strong><small>Partidas</small></span>
        <span><strong>${wins ?? "—"}</strong><small>Vitórias</small></span>
        <span><strong>${escapeHTML(winRate)}</strong><small>Taxa de vitória</small></span>
      </div>
      <section class="public-achievements" aria-labelledby="public-player-achievements">
        <p class="micro-label">Pins conquistados</p>
        <h3 id="public-player-achievements">Conquistas</h3>
        <div class="achievements-grid achievements-grid-public" data-public-achievements-grid></div>
      </section>`;
    renderAchievementsGrid($('[data-public-achievements-grid]', content), achievements, {
      owner: false,
    });
  }

  async function openPublicPlayerProfile(playerId) {
    if (!playerId) return;
    try {
      const [profileData, achievementData] = await Promise.all([
        apiRequest(`/api/v1/players/${encodeURIComponent(playerId)}/profile`),
        apiRequest(`/api/v1/players/${encodeURIComponent(playerId)}/achievements`),
      ]);
      renderPublicPlayerProfile(profileData.player, achievementData.achievements || []);
      openAccessibleModal(
        $("[data-player-profile-modal]"),
        ".modal-close",
      );
    } catch (error) {
      showToast(error.message);
    }
  }

  function setupMatches() {
    $("[data-match-detail-join]")?.addEventListener("click", joinCurrentMatch);
    document.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-remove-player]");
      if (removeButton) {
        event.preventDefault();
        event.stopPropagation();
        removePlayerFromMatch(removeButton);
        return;
      }
      const position = event.target.closest("[data-join-position]");
      if (position) {
        event.preventDefault();
        event.stopPropagation();
        if (position.dataset.moveSelf) moveSelfToPosition(position);
        else joinMatchPosition(position);
        return;
      }
      const target = event.target.closest("[data-public-player]");
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      openPublicPlayerProfile(target.dataset.publicPlayer);
    });
    document.addEventListener("change", (event) => {
      const select = event.target.closest("[data-reorganize-player]");
      if (select) reorganizeMatchPlayer(select);
    });
    $("[data-create-match]")?.addEventListener("click", () => {
      switchView("clubs");
      showToast("Escolha um clube, quadra e horário para criar seu jogo.");
    });
    state.unreadPollTimer = setInterval(
      refreshUnreadCounts,
      UNREAD_POLL_INTERVAL,
    );
  }

  function profileValue(value, labels = {}) {
    if (!value) return "—";
    return labels[String(value).toLowerCase()] || value;
  }

  function renderLevelBanner(profile) {
    const banner = $("[data-match-level-banner]");
    if (!banner) return;
    if (!profile.levelAssessmentCompleted) {
      banner.classList.add("hidden");
      return;
    }
    const level = clampLevel(profile.level);
    const progress = ((level - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)) * 100;
    banner.innerHTML = `<div><small>Seu nível Quadrafy</small><strong>${escapeHTML(profile.levelCategory || formatLevel(level))}</strong></div><div class="level-track" aria-hidden="true"><i></i><b></b></div><p>Use sua faixa de nível para encontrar jogos mais equilibrados.</p>`;
    $(".level-track i", banner).style.width = `${progress}%`;
    $(".level-track b", banner).style.left = `${progress}%`;
    banner.classList.remove("hidden");
  }

  // Tabela oficial de faixas (espelha backend/src/lib/level-dynamics.js).
  const LEVEL_BANDS = [
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
  const PREFERRED_TIME_DAYS = [
    ["mon", "Seg"],
    ["tue", "Ter"],
    ["wed", "Qua"],
    ["thu", "Qui"],
    ["fri", "Sex"],
    ["sat", "Sáb"],
    ["sun", "Dom"],
  ];
  const PREFERRED_TIME_PERIODS = [
    ["morning", "Manhã"],
    ["afternoon", "Tarde"],
    ["evening", "Noite"],
  ];

  function levelBandFor(level) {
    const numeric = Number(level);
    if (!Number.isFinite(numeric)) return null;
    return (
      LEVEL_BANDS.find((band) => numeric >= band.min && numeric < band.max) ??
      LEVEL_BANDS.at(-1)
    );
  }

  // TASKS-07: fiabilidade em percentual 0–100 (valores legados na escala
  // 0–1 são convertidos multiplicando por 100).
  function normalizeReliabilityValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 35;
    const percent = numeric <= 1 ? numeric * 100 : numeric;
    return Math.min(100, Math.max(0, Math.round(percent)));
  }

  function renderConfidenceBar(profile) {
    const block = $("[data-profile-confidence-block]");
    if (!block) return;
    const hasAssessment = Boolean(profile.levelAssessmentCompleted);
    block.classList.toggle("hidden", !hasAssessment);
    if (!hasAssessment) return;
    const percent = normalizeReliabilityValue(profile.levelConfidence);
    $("[data-profile-confidence-value]").textContent = `${percent}%`;
    $("[data-profile-confidence-fill]").style.width = `${percent}%`;
    const matches = Number(profile.matchesPlayed) || 0;
    // TASK-27: interpretação qualitativa em percentual.
    const stage =
      percent > 70
        ? "nível consolidado"
        : percent >= 50
          ? "em consolidação"
          : "em calibração";
    $("[data-profile-confidence-note]").textContent =
      `Sua classificação está com ${percent}% de precisão baseada em seu histórico recente (${matches} ${matches === 1 ? "partida" : "partidas"} · ${stage}).`;
  }

  function renderPreferredTimesSummary(profile) {
    const container = $("[data-profile-preferred-times]");
    if (!container) return;
    const selected = new Set(
      Array.isArray(profile.preferredTimes) ? profile.preferredTimes : [],
    );
    if (!selected.size) {
      container.innerHTML =
        '<p class="profile-data-note">Nenhum horário de preferência definido.</p>';
      return;
    }
    const header = PREFERRED_TIME_DAYS.map(
      ([, label]) => `<span class="times-day-label">${label}</span>`,
    ).join("");
    const rows = PREFERRED_TIME_PERIODS.map(([period, periodLabel]) => {
      const cells = PREFERRED_TIME_DAYS.map(([day]) => {
        const active = selected.has(`${day}_${period}`);
        return `<span class="times-dot${active ? " active" : ""}" aria-hidden="true"></span>`;
      }).join("");
      return `<span class="times-period-label">${periodLabel}</span>${cells}`;
    }).join("");
    const readable = [...selected]
      .map((block) => {
        const [day, period] = block.split("_");
        const dayLabel = PREFERRED_TIME_DAYS.find(([key]) => key === day)?.[1];
        const periodLabel = PREFERRED_TIME_PERIODS.find(
          ([key]) => key === period,
        )?.[1];
        return dayLabel && periodLabel ? `${dayLabel} ${periodLabel}` : null;
      })
      .filter(Boolean)
      .join(", ");
    container.innerHTML = `<div class="times-summary-grid" role="img" aria-label="Horários preferidos: ${escapeHTML(readable)}"><span></span>${header}${rows}</div>`;
  }

  function renderProfile() {
    if (!state.session) return;
    const profile = state.session.user.profile || {};
    const hasAssessment = Boolean(profile.levelAssessmentCompleted);
    const band = hasAssessment ? levelBandFor(profile.level) : null;
    $("[data-profile-level]").textContent = hasAssessment
      ? band
        ? `${band.technical} · ${band.category}`
        : profile.levelCategory || "Categoria em análise"
      : "Teste pendente";
    $("[data-profile-score]").textContent = hasAssessment
      ? formatLevel(profile.level)
      : "—";
    $("[data-profile-level-note]").textContent = hasAssessment
      ? profile.levelAnalysis ||
        "Jogue partidas com resultado confirmado para calibrar seu nível."
      : "Faça o teste inicial para descobrir seu nível e receber recomendações compatíveis.";
    renderConfidenceBar(profile);
    const matchesPlayed = Number(profile.matchesPlayed) || 0;
    $("[data-profile-matches]").textContent = matchesPlayed
      ? String(matchesPlayed)
      : String(
          state.bookings.filter((booking) => booking.status !== "cancelled")
            .length,
        );
    $("[data-profile-wins]").textContent = matchesPlayed
      ? String(Number(profile.wins) || 0)
      : "—";
    $("[data-profile-winrate]").textContent =
      matchesPlayed && Number.isFinite(Number(profile.winRate))
        ? `${Number(profile.winRate).toLocaleString("pt-BR")}%`
        : "—";
    const clubIds = new Set(
      state.bookings
        .filter((booking) => booking.status !== "cancelled")
        .map((booking) => booking.clubId),
    );
    $("[data-profile-clubs]").textContent = String(clubIds.size);
    const phoneCell = $("[data-profile-phone-value]");
    if (phoneCell) {
      phoneCell.textContent = profile.phone
        ? profile.phone.replace(/^(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3")
        : "—";
    }
    const genderCell = $("[data-profile-gender-value]");
    if (genderCell) {
      genderCell.textContent = profileValue(profile.gender, {
        female: "Feminino",
        male: "Masculino",
        unspecified: "Prefiro não informar",
      });
    }
    $("[data-profile-preferred-side]").textContent = profileValue(
      profile.preferredSide,
      {
        esquerdo: "Esquerda",
        direito: "Direita",
        // TASK-99: valores antigos (drive/revés) mapeados para o lado mais
        // comum associado (direita/esquerda), agora que o campo pergunta
        // literalmente o lado da quadra preferido.
        drive: "Direita",
        reves: "Esquerda",
        indiferente: "Indiferente",
      },
    );
    $("[data-profile-dominant-hand]").textContent = profileValue(
      profile.dominantHand,
      { destra: "Destra", canhota: "Canhota", ambidestra: "Ambidestra" },
    );
    const playStyleLabel = profileValue(profile.playStyle, {
      competitivo: "Competitivo",
      social: "Social",
      misto: "Misto",
    });
    const playStyleCell = $("[data-profile-play-style]");
    playStyleCell.innerHTML =
      profile.playStyle && playStyleLabel !== "—"
        ? `<span class="play-style-badge play-style-${escapeHTML(String(profile.playStyle))}">${escapeHTML(playStyleLabel)}</span>`
        : "—";
    renderPreferredTimesSummary(profile);
    const hasPreferences = Boolean(
      profile.preferredSide ||
      profile.dominantHand ||
      profile.playStyle ||
      (Array.isArray(profile.preferredTimes) && profile.preferredTimes.length),
    );
    $("[data-profile-info-empty]").classList.toggle("hidden", hasPreferences);
    applyPlayerIdentity();
    renderLevelBanner(profile);
  }

  // TASK-23/25 — dados que dependem do histórico de partidas confirmadas.
  // TASK-99: conquistas não aparecem mais direto no perfil — carregadas sob
  // demanda quando o modal "Ver conquistas" é aberto.
  async function loadProfileExtras() {
    await Promise.all([
      loadProfileStats(),
      loadLevelHistoryChart(),
      loadConnections(),
    ]);
  }

  function achievementAsset(asset) {
    const value = String(asset || "");
    return /^\/assets\/images\/achievements\/[a-z0-9/_\-.]+\.svg$/i.test(value)
      ? value
      : "/assets/images/achievements/pin-jogos-bronze.svg";
  }

  function achievementDetailText(achievement) {
    const details = achievement.titleDetails;
    const facts = details
      ? [
          details.competitionName,
          details.clubName,
          details.competitionDate
            ? formatDate(details.competitionDate, {
                day: "2-digit",
                month: "long",
                year: "numeric",
              })
            : "",
          details.levelCategory ? `Faixa ${details.levelCategory}` : "",
        ].filter(Boolean)
      : [];
    const unlocked = achievement.unlockedAt
      ? ` Desbloqueada em ${formatDate(achievement.unlockedAt, { day: "2-digit", month: "long", year: "numeric" })}.`
      : "";
    return `${achievement.description || "Conquista Quadrafy."}${facts.length ? ` ${facts.join(" · ")}.` : ""}${unlocked}`;
  }

  function showAchievementDetail(achievement) {
    showGenericModal({
      eyebrow: achievement.type === "champion_title" ? "Título de campeão" : achievement.category || "Conquista Quadrafy",
      title: achievement.name || "Conquista",
      text: achievementDetailText(achievement),
    });
  }

  // TASK-73: barra "atual/meta" para conquistas de progresso (não se aplica
  // a títulos de campeão, que não têm meta numérica).
  function achievementProgressMarkup(achievement) {
    if (achievement.type !== "progress_tier" || !achievement.progress) return "";
    const target = Number(achievement.progress.target) || 0;
    if (!target) return "";
    const current = Math.min(Number(achievement.progress.current) || 0, target);
    const percent = Math.max(0, Math.min(100, (current / target) * 100));
    const currentLabel = Number.isInteger(target) ? Math.round(current) : current;
    return `<div class="achievement-progress"><div class="achievement-progress-bar"><span style="width:${percent}%"></span></div><small class="achievement-progress-label">${escapeHTML(String(currentLabel))} / ${escapeHTML(String(target))}</small></div>`;
  }

  function renderAchievementsGrid(container, items, { owner }) {
    if (!container) return;
    if (!items.length) {
      container.innerHTML = `<p class="profile-data-note">${owner ? "Seus próximos pins aparecerão aqui conforme você joga." : "Este jogador ainda não desbloqueou pins públicos."}</p>`;
      return;
    }
    container.innerHTML = items
      .map((achievement, index) => {
        const locked = Boolean(achievement.locked);
        const champion = achievement.type === "champion_title";
        const stateText = locked ? "Bloqueado" : champion ? "Título de campeão" : `Nível ${achievement.tier || "bronze"}`;
        return `<button class="achievement-pin${locked ? " is-locked" : ""}${champion ? " is-champion" : ""}" type="button" data-achievement-index="${index}" aria-label="${escapeHTML(achievement.name)} — ${escapeHTML(stateText)}"><span class="achievement-pin-art"><img src="${escapeHTML(achievementAsset(achievement.asset))}" alt="" width="64" height="76" /></span><span class="achievement-pin-name">${escapeHTML(achievement.name)}</span><small>${escapeHTML(stateText)}</small>${achievementProgressMarkup(achievement)}</button>`;
      })
      .join("");
    $$('[data-achievement-index]', container).forEach((button) =>
      button.addEventListener("click", () => {
        const achievement = items[Number(button.dataset.achievementIndex)];
        if (achievement) showAchievementDetail(achievement);
      }),
    );
  }

  function ownAchievementItems() {
    const unlockedById = new Map(
      state.achievements
        .filter((achievement) => achievement.type === "progress_tier")
        .map((achievement) => [achievement.achievementId, achievement]),
    );
    const progress = state.achievementCatalog.map((definition) => {
      const unlocked = unlockedById.get(definition.id);
      return unlocked ? { ...definition, ...unlocked } : { ...definition, locked: true };
    });
    const championTitles = state.achievements.filter(
      (achievement) => achievement.type === "champion_title",
    );
    return [...championTitles, ...progress];
  }

  function announceRecentAchievements(achievements) {
    const userId = state.session?.user?.id;
    if (!userId || !achievements.length) return;
    const storageKey = `quadrafy:achievement-notices:${userId}`;
    try {
      const seen = new Set(JSON.parse(localStorage.getItem(storageKey) || "[]"));
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const fresh = achievements.filter(
        (achievement) =>
          !seen.has(achievement.id) &&
          new Date(achievement.unlockedAt).getTime() >= oneDayAgo,
      );
      if (fresh.length) showToast(`🏆 Nova conquista desbloqueada: ${fresh[0].name}!`);
      achievements.forEach((achievement) => seen.add(achievement.id));
      localStorage.setItem(storageKey, JSON.stringify([...seen].slice(-120)));
    } catch {
      // A coleção continua funcional quando o navegador bloqueia storage local.
    }
  }

  // TASK-99 — conquistas só aparecem ao abrir o modal (botão "Ver
  // conquistas"), não mais direto no corpo do perfil.
  async function loadAchievements() {
    const container = $('[data-achievements-modal-grid]');
    const userId = state.session?.user?.id;
    if (!container || !userId) return;
    try {
      const data = await apiRequest(
        `/api/v1/players/${encodeURIComponent(userId)}/achievements`,
      );
      state.achievements = data.achievements || [];
      state.achievementCatalog = data.catalog || [];
      const items = ownAchievementItems();
      renderAchievementsGrid(container, items, { owner: true });
      const unlockedCount = state.achievements.length;
      const count = $('[data-achievements-modal-count]');
      if (count) {
        count.textContent = `${unlockedCount} ${unlockedCount === 1 ? "desbloqueado" : "desbloqueados"}`;
      }
      announceRecentAchievements(state.achievements);
    } catch (error) {
      container.innerHTML = `<p class="profile-data-note">${escapeHTML(error.message)}</p>`;
    }
  }

  function winrateSegment(label, rate, played) {
    const hasData = rate !== null && rate !== undefined;
    const width = hasData ? Math.max(2, Math.min(100, rate)) : 0;
    return `<div class="winrate-segment"><div class="winrate-segment-head"><span>${label}</span><strong>${hasData ? `${Number(rate).toLocaleString("pt-BR")}%` : "—"}</strong></div><div class="winrate-track" aria-hidden="true"><span style="width:${width}%"></span></div><small>${played ? `${played} ${played === 1 ? "partida" : "partidas"}` : "Sem partidas"}</small></div>`;
  }

  async function loadProfileStats() {
    const container = $("[data-profile-winrate-segments]");
    const streak = $("[data-profile-streak]");
    if (!container) return;
    try {
      const { stats } = await apiRequest("/api/v1/player/stats");
      if (!stats.matchesPlayed) {
        container.innerHTML =
          '<p class="profile-data-note">Jogue partidas com resultado confirmado para ver seu aproveitamento por força de adversário.</p>';
        streak?.classList.add("hidden");
        return;
      }
      container.innerHTML = [
        winrateSegment(
          "vs. nível superior",
          stats.winRateVsHigherLevel,
          stats.playedVsHigherLevel,
        ),
        winrateSegment(
          "vs. nível similar",
          stats.winRateVsSimilarLevel,
          stats.playedVsSimilarLevel,
        ),
        winrateSegment(
          "vs. nível inferior",
          stats.winRateVsLowerLevel,
          stats.playedVsLowerLevel,
        ),
      ].join("");
      if (streak) {
        const wins = Number(stats.currentWinStreak) || 0;
        streak.classList.toggle("hidden", wins < 2);
        streak.textContent =
          wins >= 2 ? `🔥 ${wins} vitórias seguidas` : "";
      }
    } catch {
      container.innerHTML =
        '<p class="profile-data-note">Não foi possível carregar as estatísticas agora.</p>';
    }
  }

  async function loadLevelHistoryChart() {
    const container = $("[data-level-history-chart]");
    if (!container || !window.QuadrafyCharts) return;
    try {
      const { history } = await apiRequest("/api/v1/player/level-history");
      if (!history?.length) return;
      const items = history.slice(-24).map((entry) => ({
        label: formatDate(entry.createdAt, {
          day: "2-digit",
          month: "short",
        }),
        value: Number(entry.level) || 0,
      }));
      window.QuadrafyCharts.renderLine(container, items, {
        label: "Evolução do nível Quadrafy ao longo do tempo",
        formatValue: (value) => formatLevel(value),
      });
    } catch {
      /* mantém o placeholder */
    }
  }

  // TASK-29 — explicador conversacional local: mostra as contas do último
  // resultado confirmado, recalculadas no backend pela mesma função do motor.
  async function loadLevelExplanation(event) {
    const button = event.currentTarget;
    const container = $("[data-level-explain-content]");
    if (!container) return;
    setBusy(button, true, "Calculando…");
    try {
      const { explanation } = await apiRequest(
        "/api/v1/player/level-explanation",
      );
      container.classList.remove("hidden");
      if (!explanation) {
        container.innerHTML =
          '<p class="profile-data-note">Você ainda não tem nenhuma partida com resultado confirmado. Jogue e confirme um resultado para ver o cálculo.</p>';
        return;
      }
      const teamLabel = (team) => (team === "team1" ? "Dupla 1" : "Dupla 2");
      const myTeamLabel = teamLabel(explanation.myTeam);
      const opponentTeam =
        explanation.myTeam === "team1" ? "team2" : "team1";
      const fmt = (value, digits = 2) =>
        Number(value).toLocaleString("pt-BR", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });
      const signedDelta = `${explanation.delta >= 0 ? "+" : "−"}${fmt(Math.abs(explanation.delta), 3)}`;
      container.innerHTML = `
        <ol class="level-explainer-steps">
          <li><strong>Médias das duplas:</strong> ${myTeamLabel} ${fmt(explanation.averages[explanation.myTeam])} × ${fmt(explanation.averages[opponentTeam])} ${teamLabel(opponentTeam)} (diferença ${fmt(explanation.difference)}). A ${teamLabel(explanation.favorite)} era a favorita.</li>
          <li><strong>Pote base:</strong> ${fmt(explanation.potBase)} — ${explanation.upset ? "vitória da zebra (surpresa), pote cheio" : "vitória da favorita, pote reduzido"}.</li>
          <li><strong>Multiplicador de fiabilidade da sua dupla:</strong> ×${fmt(explanation.multiplier)} (fiabilidade média ${fmt(explanation.reliabilities[explanation.myTeam], 0)}%) → pote total ${fmt(explanation.pot, 3)}.</li>
          <li><strong>Sua fatia (distribuição inversa):</strong> peso ${fmt(explanation.weight, 3)} → ${explanation.won ? "ganho" : "perda"} de ${signedDelta} no seu nível (${fmt(explanation.previousLevel)} → ${fmt(explanation.newLevel)}).</li>
        </ol>
        <p class="level-explainer-summary">${escapeHTML(explanation.summary)}</p>`;
    } catch (error) {
      container.classList.remove("hidden");
      container.innerHTML = `<p class="profile-data-note">${escapeHTML(error.message)}</p>`;
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  function connectionRow(player, suffix) {
    const name = player.displayName || "Jogador";
    const photoUrl = safePhotoUrl(player.photoUrl);
    const avatar = photoUrl
      ? `<span class="ranking-avatar"><img src="${escapeHTML(photoUrl)}" alt="" /></span>`
      : `<span class="ranking-avatar" aria-hidden="true">${escapeHTML(initialsFor(name) || "—")}</span>`;
    return `<button class="connection-row" type="button" data-public-player="${escapeHTML(player.id)}" aria-label="Ver perfil de ${escapeHTML(name)}">${avatar}<span class="connection-info"><strong>${escapeHTML(name)}</strong><small>${player.level !== null && player.level !== undefined ? `Nível ${escapeHTML(formatLevel(player.level))} · ` : ""}${player.matches} ${player.matches === 1 ? "partida" : "partidas"} ${suffix}</small></span></button>`;
  }

  async function loadConnections() {
    const partnersList = $("[data-profile-partners-list]");
    const rivalsList = $("[data-profile-rivals-list]");
    if (!partnersList || !rivalsList) return;
    try {
      const data = await apiRequest("/api/v1/player/connections");
      partnersList.innerHTML = data.frequentPartners?.length
        ? data.frequentPartners
            .map((player) => connectionRow(player, "juntos"))
            .join("")
        : '<p class="profile-data-note">Jogue partidas confirmadas para ver seus parceiros.</p>';
      rivalsList.innerHTML = data.recurringRivals?.length
        ? data.recurringRivals
            .map((player) => connectionRow(player, "contra"))
            .join("")
        : '<p class="profile-data-note">Seus rivais mais frequentes aparecerão aqui.</p>';
    } catch {
      /* mantém os placeholders */
    }
  }

  // TASK-30 — modal de progressão da fiabilidade.
  async function openConfidenceProgress() {
    const modal = $("[data-confidence-progress-modal]");
    const profile = state.session?.user?.profile || {};
    const percent = normalizeReliabilityValue(profile.levelConfidence);
    const marker = $("[data-confidence-marker]", modal);
    if (marker) marker.style.left = `${percent}%`;
    const zone =
      percent > 70
        ? "Alta (> 70%): nível consolidado — vitórias e derrotas isoladas movem pouco."
        : percent >= 50
          ? "Média (50–70%): variações moderadas a cada resultado."
          : "Baixa (< 50%): seu nível ainda oscila bastante a cada jogo.";
    const note = $("[data-confidence-scale-note]", modal);
    if (note) note.textContent = `Você está em ${percent}% — faixa ${zone}`;
    openAccessibleModal(modal, "[data-modal-close]");
    const container = $("[data-confidence-history-chart]", modal);
    if (!container || !window.QuadrafyCharts) return;
    try {
      const { history } = await apiRequest("/api/v1/player/level-history");
      const items = (history || [])
        .filter((entry) => entry.levelConfidence !== null)
        .slice(-24)
        .map((entry) => ({
          label: formatDate(entry.createdAt, {
            day: "2-digit",
            month: "short",
          }),
          value: normalizeReliabilityValue(entry.levelConfidence),
        }));
      if (items.length) {
        window.QuadrafyCharts.renderLine(container, items, {
          label: "Evolução da fiabilidade (%) ao longo do tempo",
          formatValue: (value) => `${Math.round(value)}%`,
        });
      }
    } catch {
      /* mantém o placeholder */
    }
  }

  // TASK-24 — modal "Entenda seu nível".
  function openLevelInfo() {
    const modal = $("[data-level-info-modal]");
    const content = $("[data-level-info-content]", modal);
    const profile = state.session?.user?.profile || {};
    const level = Number(profile.level);
    const hasLevel =
      Boolean(profile.levelAssessmentCompleted) && Number.isFinite(level);
    const currentBand = hasLevel ? levelBandFor(level) : null;
    const rows = LEVEL_BANDS.map((band) => {
      const isCurrent = currentBand === band;
      return `<tr class="${isCurrent ? "current-band" : ""}"><td>${band.min.toLocaleString("pt-BR", { minimumFractionDigits: 1 })} – ${band.max.toLocaleString("pt-BR", { minimumFractionDigits: 1 })}</td><td>${escapeHTML(band.technical)}${isCurrent ? ' <span class="band-you">você está aqui</span>' : ""}</td><td>${escapeHTML(band.category)}</td></tr>`;
    }).join("");
    const nextBand = currentBand
      ? LEVEL_BANDS[LEVEL_BANDS.indexOf(currentBand) + 1]
      : null;
    const progressNote = hasLevel
      ? nextBand
        ? `<p class="profile-data-note">Seu nível atual é <strong>${escapeHTML(formatLevel(level))}</strong>. Faltam <strong>${(Math.round((nextBand.min - level) * 100) / 100).toLocaleString("pt-BR")}</strong> pontos para alcançar a faixa ${escapeHTML(nextBand.technical)} (${escapeHTML(nextBand.category)}).</p>`
        : `<p class="profile-data-note">Seu nível atual é <strong>${escapeHTML(formatLevel(level))}</strong> — você está na faixa mais alta do Quadrafy.</p>`
      : '<p class="profile-data-note">Complete o teste de nível para descobrir sua faixa.</p>';
    content.innerHTML = `<table class="level-bands-table"><thead><tr><th scope="col">Nível</th><th scope="col">Classificação técnica</th><th scope="col">Categoria equivalente</th></tr></thead><tbody>${rows}</tbody></table>${progressNote}`;
    openAccessibleModal(modal, "[data-modal-close]");
  }

  function setSelectValue(select, value) {
    const normalized = String(value || "").toLowerCase();
    const matchingOption = [...select.options].find(
      (option) => option.value.toLowerCase() === normalized,
    );
    select.value = matchingOption?.value || "";
  }

  function setPlayerPhotoPreview(url, name = playerName()) {
    const image = $("[data-player-photo-preview]");
    const placeholder = $("[data-player-photo-placeholder]");
    if (!image || !placeholder) return;
    const safeUrl = url?.startsWith("blob:") ? url : safePhotoUrl(url);
    image.hidden = !safeUrl;
    image.src = safeUrl || "";
    placeholder.hidden = Boolean(safeUrl);
    placeholder.textContent = initialsFor(name) || "QF";
  }

  function clearPlayerPhotoObjectUrl() {
    if (!state.profilePreviewObjectUrl) return;
    URL.revokeObjectURL(state.profilePreviewObjectUrl);
    state.profilePreviewObjectUrl = null;
  }

  // TASKS-15 / TASK-65 — controles da pré-visualização (erro no lugar do
  // preview + botão de remover/trocar antes de confirmar).
  function setPlayerPhotoFeedback({ error = "", selected = false } = {}) {
    const note = $("[data-player-photo-error]");
    if (note) {
      note.textContent = error;
      note.classList.toggle("hidden", !error);
    }
    $("[data-player-photo-clear]")?.classList.toggle("hidden", !selected);
  }

  function clearSelectedPlayerPhoto() {
    const input = $("[data-player-photo-input]");
    if (input) input.value = "";
    clearPlayerPhotoObjectUrl();
    setPlayerPhotoPreview(state.session?.user?.profile?.photoUrl);
    setPlayerPhotoFeedback();
  }

  function previewPlayerPhoto(event) {
    const [file] = event.currentTarget.files || [];
    clearPlayerPhotoObjectUrl();
    if (!file) {
      setPlayerPhotoPreview(state.session?.user?.profile?.photoUrl);
      setPlayerPhotoFeedback();
      return;
    }
    try {
      validateImageFile(file);
      state.profilePreviewObjectUrl = URL.createObjectURL(file);
      setPlayerPhotoPreview(state.profilePreviewObjectUrl);
      setPlayerPhotoFeedback({ selected: true });
    } catch (error) {
      // TASK-65: o arquivo inválido NÃO fica selecionado e o erro aparece
      // junto da área de preview (além do toast), sem sugerir aceitação.
      event.currentTarget.value = "";
      setPlayerPhotoPreview(state.session?.user?.profile?.photoUrl);
      setPlayerPhotoFeedback({ error: error.message });
      showToast(error.message);
    }
  }

  function renderPreferredTimesEditor(selectedTimes) {
    const grid = $("[data-preferred-times-grid]");
    if (!grid) return;
    const selected = new Set(
      Array.isArray(selectedTimes) ? selectedTimes : [],
    );
    const header = PREFERRED_TIME_DAYS.map(
      ([, label]) => `<span class="times-day-label">${label}</span>`,
    ).join("");
    const rows = PREFERRED_TIME_PERIODS.map(([period, periodLabel]) => {
      const cells = PREFERRED_TIME_DAYS.map(([day, dayLabel]) => {
        const value = `${day}_${period}`;
        return `<label class="times-toggle"><input type="checkbox" name="preferredTimes" value="${value}"${selected.has(value) ? " checked" : ""} aria-label="${dayLabel} — ${periodLabel}" /><i></i></label>`;
      }).join("");
      return `<span class="times-period-label">${periodLabel}</span>${cells}`;
    }).join("");
    grid.innerHTML = `<span></span>${header}${rows}`;
  }

  function openProfileEditor() {
    const form = $("[data-profile-edit-form]");
    const profile = state.session?.user?.profile || {};
    form.elements.firstName.value = profile.firstName || "";
    form.elements.lastName.value = profile.lastName || "";
    form.elements.city.value = profile.city || "";
    setPlayerPhotoFeedback();
    if (form.elements.phone) {
      form.elements.phone.value = profile.phone
        ? profile.phone.replace(
            /^(\d{2})(\d{4,5})(\d{4})$/,
            "($1) $2-$3",
          )
        : "";
    }
    form.elements.photo.value = "";
    clearPlayerPhotoObjectUrl();
    setPlayerPhotoPreview(profile.photoUrl);
    // TASK-99: valores antigos ("drive"/"reves") são mapeados para o lado
    // mais comum associado (direita/esquerda).
    const legacySides = { drive: "direito", reves: "esquerdo" };
    setSelectValue(
      form.elements.preferredSide,
      legacySides[String(profile.preferredSide || "").toLowerCase()] ||
        profile.preferredSide,
    );
    setSelectValue(form.elements.dominantHand, profile.dominantHand);
    setSelectValue(form.elements.playStyle, profile.playStyle);
    setSelectValue(form.elements.gender, profile.gender);
    renderPreferredTimesEditor(profile.preferredTimes);
    openAccessibleModal($("[data-profile-edit-modal]"), '[name="firstName"]');
  }

  async function saveProfile(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const button = $("[data-profile-save]", form);
    const formData = new FormData(form);
    const photo = formData.get("photo");
    formData.delete("photo");
    formData.delete("preferredTimes");
    const body = Object.fromEntries(formData.entries());
    Object.keys(body).forEach((key) => {
      if (typeof body[key] === "string") body[key] = body[key].trim();
    });
    // TASK-21: horários de preferência (checkboxes dia × período).
    body.preferredTimes = $$(
      '[data-preferred-times-grid] input[type="checkbox"]:checked',
      form,
    ).map((input) => input.value);
    setBusy(button, true, "Salvando…");
    try {
      if (photo instanceof File && photo.size > 0) {
        validateImageFile(photo);
        setBusy(button, true, "Enviando imagem…");
        const { url } = await uploadImage(photo, "player");
        body.photoUrl = url;
        setBusy(button, true, "Salvando…");
      }
      const { user } = await apiRequest("/api/v1/player/profile", {
        method: "PATCH",
        body,
      });
      state.session.user = user;
      clearPlayerPhotoObjectUrl();
      renderProfile();
      closeModal($("[data-profile-edit-modal]"));
      showToast("Perfil atualizado.");
    } catch (error) {
      showToast(error.message);
      if (error.details?.field) {
        form.elements.namedItem(error.details.field)?.focus();
      }
    } finally {
      setBusy(button, false);
    }
  }

  function openLevelTest(required = false) {
    state.levelTestRequired = required;
    const modal = $("[data-level-test-modal]");
    const closeButton = $("[data-level-test-close]", modal);
    closeButton.classList.toggle("hidden", required);
    modal.dataset.required = String(required);
    openAccessibleModal(modal, '[name="tempo_pratica"]');
  }

  async function submitLevelTest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const button = $("[data-level-test-submit]", form);
    const body = Object.fromEntries(new FormData(form).entries());
    setBusy(button, true, "Analisando…");
    try {
      const { result, user, engine } = await apiRequest(
        "/api/v1/player/level-test",
        {
          method: "POST",
          body,
        },
      );
      state.session.user = user;
      state.levelTestRequired = false;
      closeModal($("[data-level-test-modal]"));
      renderProfile();
      showGenericModal({
        eyebrow: "Seu nível Quadrafy",
        title:
          result.categoria_sugerida ||
          result.levelCategory ||
          user.profile.levelCategory ||
          "Nivelamento concluído",
        text: [
          result.analise_tecnica ||
            result.analysis ||
            "Seu perfil foi atualizado com o resultado do nivelamento.",
          engine?.warning ? `Aviso: ${engine.warning}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      form.reset();
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function setupProfile() {
    $$("[data-edit-profile]").forEach((button) =>
      button.addEventListener("click", openProfileEditor),
    );
    $$("[data-level-test-open]").forEach((button) =>
      button.addEventListener("click", () => openLevelTest(false)),
    );
    $("[data-profile-edit-form]")?.addEventListener("submit", saveProfile);
    $("[data-player-photo-clear]")?.addEventListener(
      "click",
      clearSelectedPlayerPhoto,
    );
    $("[data-player-photo-input]")?.addEventListener(
      "change",
      previewPlayerPhoto,
    );
    $("[data-level-test-form]")?.addEventListener("submit", submitLevelTest);
    // TASK-50: refazer a listagem ao mudar o filtro de categoria.
    $("[data-match-gender-filter]")?.addEventListener("change", loadMatches);
    // TASK-17B: formulário de placar (sempre 3 sets).
    const resultForm = $("[data-match-result-form]");
    resultForm?.addEventListener("submit", submitMatchResult);
    resultForm?.addEventListener("input", updateResultPreview);
    // TASK-24: modal "Entenda seu nível".
    $("[data-level-info-open]")?.addEventListener("click", openLevelInfo);
    // TASK-30: progressão da fiabilidade.
    $("[data-confidence-progress-open]")?.addEventListener(
      "click",
      openConfidenceProgress,
    );
    // TASK-29: explicador passo a passo do último resultado (sem IA).
    $("[data-level-explain-open]")?.addEventListener(
      "click",
      loadLevelExplanation,
    );
    // TASK-99: "Ver conquistas" abre um modal com todas as conquistas, em
    // vez de mostrá-las direto no corpo do perfil.
    $("[data-achievements-open]")?.addEventListener("click", () => {
      openAccessibleModal(
        $("[data-achievements-modal]"),
        "[data-modal-close]",
      );
      loadAchievements();
    });

    const levelModal = $("[data-level-test-modal]");
    levelModal?.addEventListener(
      "click",
      (event) => {
        if (state.levelTestRequired && event.target === levelModal) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (state.levelTestRequired && event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  function setupModalFocusRestore() {
    $$(
      "[data-profile-edit-modal] [data-modal-close], [data-booking-detail-modal] [data-modal-close], [data-match-detail-modal] [data-modal-close], [data-level-test-modal] [data-modal-close]",
    ).forEach((button) => button.addEventListener("click", restoreModalFocus));
  }

  async function initialize() {
    setupTabs();
    setupClubFilters();
    setupBookingModal();
    setupBookingSegments();
    setupBookingDetail();
    setupMatches();
    setupProfile();
    setupModalFocusRestore();
    state.session = await loadDashboard("player");
    if (!state.session) return;
    applyPlayerIdentity();
    renderProfile();
    if (!state.session.user.profile?.levelAssessmentCompleted) {
      openLevelTest(true);
    }
    await Promise.all([loadClubs(), loadBookings(), loadMatches()]);
    loadProfileExtras();
    hydrateIcons();
  }

  addEventListener("beforeunload", () => {
    clearInterval(state.chatPollTimer);
    clearInterval(state.unreadPollTimer);
  });

  initialize();
})();
