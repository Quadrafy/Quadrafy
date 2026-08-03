(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const listEl = $("[data-admin-list]");
  let currentFilter = "pending";

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : null;
    if (!response.ok) {
      const error = new Error(payload?.error?.message || "Erro na solicitação.");
      error.status = response.status;
      throw error;
    }
    return payload?.data ?? null;
  }

  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  }

  function renderCard(club) {
    const actions =
      currentFilter === "pending"
        ? `<div class="admin-card-actions">
             <button class="button button-primary button-small" type="button" data-approve="${esc(club.id)}">Aprovar</button>
             <button class="button button-outline button-small" type="button" data-reject="${esc(club.id)}">Recusar</button>
           </div>`
        : `<span class="admin-status admin-status--${esc(club.status)}">${
            club.status === "active" ? "Aprovado" : "Recusado"
          }</span>`;
    return `<article class="admin-card">
      <div class="admin-card-body">
        <h3>${esc(club.name || "Arena sem nome")}</h3>
        <p><strong>CNPJ:</strong> ${esc(club.cnpj || "—")} · <strong>Responsável:</strong> ${esc(club.responsibleName || "—")}</p>
        <p><strong>Contato:</strong> ${esc(club.ownerEmail || "—")}${club.ownerPhone ? " · " + esc(club.ownerPhone) : ""}</p>
        ${club.rejectionReason ? `<p class="admin-reason">Motivo da recusa: ${esc(club.rejectionReason)}</p>` : ""}
      </div>
      ${actions}
    </article>`;
  }

  function wireActions() {
    $$("[data-approve]").forEach((button) =>
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api(
            `/api/v1/admin/clubs/${encodeURIComponent(button.dataset.approve)}/approve`,
            { method: "POST", body: {} },
          );
          loadClubs();
        } catch (error) {
          alert(error.message);
          button.disabled = false;
        }
      }),
    );
    $$("[data-reject]").forEach((button) =>
      button.addEventListener("click", async () => {
        const reason = window.prompt("Motivo da recusa (opcional):") ?? "";
        button.disabled = true;
        try {
          await api(
            `/api/v1/admin/clubs/${encodeURIComponent(button.dataset.reject)}/reject`,
            { method: "POST", body: { reason } },
          );
          loadClubs();
        } catch (error) {
          alert(error.message);
          button.disabled = false;
        }
      }),
    );
  }

  async function loadClubs() {
    listEl.innerHTML = '<p class="profile-data-note">Carregando…</p>';
    try {
      const data = await api(`/api/v1/admin/clubs?status=${currentFilter}`);
      const clubs = data?.clubs || [];
      if (!clubs.length) {
        listEl.innerHTML =
          '<p class="profile-data-note">Nenhuma solicitação nesta lista.</p>';
        return;
      }
      listEl.innerHTML = clubs.map(renderCard).join("");
      wireActions();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        location.assign("login.html");
        return;
      }
      listEl.innerHTML = `<p class="profile-data-note">${esc(error.message)}</p>`;
    }
  }

  $$("[data-admin-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      currentFilter = button.dataset.adminFilter;
      $$("[data-admin-filter]").forEach((other) =>
        other.classList.toggle("active", other === button),
      );
      loadClubs();
    }),
  );

  $("[data-logout]")?.addEventListener("click", async () => {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } catch {
      /* ignora */
    }
    location.assign("login.html");
  });

  // Guarda: só administradores acessam.
  api("/api/v1/auth/me")
    .then((me) => {
      if (!me?.isAdmin) {
        location.assign(me ? "index.html" : "login.html");
        return;
      }
      loadClubs();
    })
    .catch(() => location.assign("login.html"));
})();
