(() => {
  "use strict";

  const page = document.documentElement.dataset.page;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];

  const iconPaths = {
    pin: '<path d="M12 21s6-4.4 6-11A6 6 0 0 0 6 10c0 6.6 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
    heart:
      '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.7-7.5 1.1-1.1a5.5 5.5 0 0 0 0-7.8Z"/>',
    roof: '<path d="m3 11 9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/>',
    shower: '<path d="M4 5a4 4 0 0 1 8 0v2M9 10h6M10 13v1M13 13v2M16 13v1"/>',
    parking:
      '<circle cx="12" cy="12" r="9"/><path d="M10 17V7h3a3 3 0 0 1 0 6h-3"/>',
    player:
      '<circle cx="12" cy="8" r="3"/><path d="M6 21v-2a6 6 0 0 1 12 0v2"/>',
    club: '<path d="M4 21V8l8-5 8 5v13M8 21v-6h8v6M8 11h1M15 11h1"/>',
    pix: '<path d="m12 3 5 5-5 5-5-5 5-5Zm0 10 5 5-5 3-5-3 5-5ZM7 8l-4 4 4 4M17 8l4 4-4 4"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
    wallet:
      '<path d="M4 6h14a2 2 0 0 1 2 2v11H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12"/><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"/>',
    court:
      '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16M3 12h18M7 4v16M17 4v16"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };

  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.check}</svg>`;

  function hydrateIcons(root = document) {
    $$("[data-icon]", root).forEach((element) => {
      if (!element.querySelector("svg")) {
        element.insertAdjacentHTML("afterbegin", icon(element.dataset.icon));
      }
    });
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatCurrency(value) {
    return Number(value || 0).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  }

  function formatDate(value, options = {}) {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      ...options,
    }).format(new Date(value));
  }

  function showToast(message) {
    const toast = $("[data-toast]");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function openModal(modal) {
    if (!modal) return;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    if (!$(".modal-backdrop.open"))
      document.body.classList.remove("modal-open");
  }

  async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : null;
    if (!response.ok) {
      const error = new Error(
        payload?.error?.message || "Não foi possível concluir a solicitação.",
      );
      error.status = response.status;
      error.code = payload?.error?.code;
      error.details = payload?.error?.details;
      throw error;
    }
    return payload?.data ?? null;
  }

  function validateImageFile(file) {
    const acceptedTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    if (!acceptedTypes.has(file?.type)) {
      throw new Error("Escolha uma imagem JPEG, PNG ou WebP.");
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("A imagem deve ter no máximo 5 MB.");
    }
  }

  function imageFileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const result = String(reader.result || "");
        const separator = result.indexOf(",");
        if (separator === -1) {
          reject(new Error("Não foi possível ler a imagem."));
          return;
        }
        resolve(result.slice(separator + 1));
      });
      reader.addEventListener("error", () =>
        reject(new Error("Não foi possível ler a imagem.")),
      );
      reader.readAsDataURL(file);
    });
  }

  async function uploadImage(file, type, resourceId) {
    validateImageFile(file);
    return apiRequest("/api/v1/uploads/image", {
      method: "POST",
      body: {
        type,
        ...(resourceId ? { resourceId } : {}),
        mimeType: file.type,
        data: await imageFileToBase64(file),
      },
    });
  }

  function showGenericModal({ eyebrow = "Quadrafy", title, text }) {
    const modal = $("[data-generic-modal]");
    const content = $("[data-generic-content]", modal);
    if (!modal || !content) return;
    content.replaceChildren();
    const mark = document.createElement("span");
    mark.className = "generic-modal-icon";
    mark.innerHTML = icon("court");
    const label = document.createElement("p");
    label.className = "eyebrow dark";
    label.textContent = eyebrow;
    const heading = document.createElement("h2");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-primary button-block shine";
    button.textContent = "Entendi";
    button.addEventListener("click", () => closeModal(modal));
    content.append(mark, label, heading, paragraph, button);
    openModal(modal);
  }

  function setupMotion() {
    requestAnimationFrame(() => document.body.classList.add("loaded"));
    if (!("IntersectionObserver" in window)) {
      $$(".reveal").forEach((element) => element.classList.add("visible"));
      return;
    }
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12 },
    );
    $$(".reveal").forEach((element) => revealObserver.observe(element));
  }

  function setupNavigation() {
    const siteNav = $("[data-site-nav]");
    if (siteNav) {
      const update = () => siteNav.classList.toggle("scrolled", scrollY > 30);
      update();
      addEventListener("scroll", update, { passive: true });
      $("[data-menu-toggle]")?.addEventListener("click", (event) => {
        const open = siteNav.classList.toggle("menu-open");
        event.currentTarget.setAttribute("aria-expanded", String(open));
      });
    }
    $("[data-app-menu]")?.addEventListener("click", () =>
      $(".app-nav")?.classList.toggle("menu-open"),
    );
    $("[data-profile-trigger]")?.addEventListener("click", () =>
      $("[data-profile-dropdown]")?.classList.toggle("open"),
    );
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".profile-menu")) {
        $("[data-profile-dropdown]")?.classList.remove("open");
      }
    });
  }

  function setupModals() {
    $$("[data-modal-close]").forEach((button) =>
      button.addEventListener("click", () =>
        closeModal(button.closest(".modal-backdrop")),
      ),
    );
    $$(".modal-backdrop").forEach((modal) =>
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeModal(modal);
      }),
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape")
        $$(".modal-backdrop.open").forEach(closeModal);
    });
  }

  function setupForms() {
    $$("[data-password-toggle]").forEach((button) =>
      button.addEventListener("click", () => {
        const input = button.parentElement.querySelector("input");
        const visible = input.type === "text";
        input.type = visible ? "password" : "text";
        button.textContent = visible ? "Mostrar" : "Ocultar";
      }),
    );
    $$("[data-demo-form]").forEach((form) =>
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        showToast("Esta configuração ainda não possui dados para salvar.");
      }),
    );
  }

  function setFormFeedback(form, message = "", success = false) {
    const feedback = $("[data-auth-feedback]", form);
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("hidden", !message);
    feedback.classList.toggle("success", success);
  }

  function setSubmitting(form, submitting) {
    const button = $('button[type="submit"]', form);
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.innerHTML;
    button.disabled = submitting;
    button.classList.toggle("is-loading", submitting);
    if (submitting) button.textContent = "Processando…";
    else button.innerHTML = button.dataset.label;
  }

  function setupAuth() {
    const switchTab = (name) => {
      $$("[data-auth-tab]").forEach((button) => {
        const active = button.dataset.authTab === name;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      $$("[data-auth-view]").forEach((view) =>
        view.classList.toggle("active", view.dataset.authView === name),
      );
    };
    $$("[data-auth-tab]").forEach((button) =>
      button.addEventListener("click", () => switchTab(button.dataset.authTab)),
    );
    if (new URLSearchParams(location.search).get("tab") === "signup") {
      switchTab("signup");
    }
    $$("[data-role]").forEach((button) =>
      button.addEventListener("click", () => {
        const role = button.dataset.role;
        $$("[data-role]").forEach((item) =>
          item.classList.toggle("active", item === button),
        );
        $$("[data-role-form]").forEach((form) =>
          form.classList.toggle("hidden", form.dataset.roleForm !== role),
        );
      }),
    );
    $$("[data-auth-form]").forEach((form) =>
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.checkValidity()) return form.reportValidity();
        const action = form.dataset.authForm;
        const body = Object.fromEntries(new FormData(form).entries());
        if (action === "register") body.role = form.dataset.authRole;
        delete body.rememberMe;
        setFormFeedback(form);
        setSubmitting(form, true);
        try {
          const data = await apiRequest(`/api/v1/auth/${action}`, {
            method: "POST",
            body,
          });
          setFormFeedback(
            form,
            action === "login"
              ? "Login confirmado. Abrindo seu painel…"
              : "Conta criada. Preparando seu painel…",
            true,
          );
          location.assign(data.redirectTo);
        } catch (error) {
          setFormFeedback(form, error.message);
          if (error.details?.field) {
            form.elements.namedItem(error.details.field)?.focus();
          }
        } finally {
          setSubmitting(form, false);
        }
      }),
    );
  }

  function applyIdentity(data) {
    const { identity, user } = data;
    $$("[data-user-name]").forEach((element) => {
      element.textContent = identity.displayName;
    });
    $$("[data-user-initials]").forEach((element) => {
      element.textContent = identity.initials;
    });
    $$("[data-user-subtitle]").forEach((element) => {
      element.textContent = identity.subtitle;
    });
    $$("[data-user-city]").forEach((element) => {
      element.textContent = user.profile.city || "Brasil";
    });
  }

  async function loadDashboard(role) {
    try {
      const data = await apiRequest(`/api/v1/${role}/dashboard`);
      applyIdentity(data);
      return data;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        location.replace("/login.html");
        return null;
      }
      showToast("Não foi possível carregar sua conta. Atualize a página.");
      return null;
    }
  }

  function setupLogout() {
    $$("[data-logout]").forEach((button) =>
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await apiRequest("/api/v1/auth/logout", { method: "POST" });
          location.replace("/index.html");
        } catch (error) {
          button.disabled = false;
          showToast(error.message);
        }
      }),
    );
  }

  function setupLandingDate() {
    const input = $("[data-quick-date]");
    if (!input) return;
    const date = new Date();
    date.setDate(date.getDate() + 1);
    input.value = formatDate(date, {
      weekday: "short",
      day: "2-digit",
      month: "short",
    });
  }

  window.Quadrafy = {
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
  };

  hydrateIcons();
  setupMotion();
  setupNavigation();
  setupModals();
  setupForms();
  setupLandingDate();
  if (page === "auth") setupAuth();
  if (page === "player" || page === "club") setupLogout();
})();
