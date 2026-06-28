import {
  getFirebaseState, signInWithGoogle, signInEmail,
  registerEmail, signOutUser, updatePresence, isEnabled,
} from "../../firebase/service";
import { bus } from "../../state/EventEmitter";
import { store } from "../../state/AppStore";

export function initPresenceBar(): void {
  if (!isEnabled()) {
    renderOfflineBar();
    return;
  }
  bus.on("firebase:auth",     () => renderPresenceBar());
  bus.on("firebase:presence", () => renderPresenceBar());
  bus.on("workspace:change",  () => syncPresence());
  bus.on("state:change",      () => syncPresence());
  renderPresenceBar();
}

function syncPresence(): void {
  if (!isEnabled()) return;
  const s = store.getState();
  updatePresence({
    workbench:    s.activeWorkbench,
    faction:      s.activeFaction,
    workspaceKey: store.currentWorkspaceKey(),
  });
}

// ── Offline bar ────────────────────────────────────────────
function renderOfflineBar(): void {
  const c = getOrCreateBar();
  c.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:0 14px;height:100%;">
    <span style="font-size:11px;color:var(--text-muted);">🔌 Offline-Modus (Firebase deaktiviert)</span>
  </div>`;
}

// ── Main render ────────────────────────────────────────────
function renderPresenceBar(): void {
  const bar = getOrCreateBar();
  const fb  = getFirebaseState();

  if (!fb.user) {
    renderLoginBar(bar);
    return;
  }

  const onlineUsers   = [...fb.users.values()];
  const wsKey         = store.currentWorkspaceKey();
  const sameWsOthers  = onlineUsers.filter(u => u.workspaceKey === wsKey && u.uid !== fb.user!.uid);

  const avatars = onlineUsers.map(u => {
    const isMe    = u.uid === fb.user!.uid;
    const sameWs  = u.workspaceKey === wsKey;
    const initials = (u.displayName || u.email || "?").slice(0,2).toUpperCase();
    return `<div title="${esc(u.displayName)} — ${esc(u.workspaceKey)}${isMe ? " (Du)" : ""}"
      style="position:relative;display:inline-flex;flex-shrink:0;">
      ${u.photoURL
        ? `<img src="${esc(u.photoURL)}" style="width:24px;height:24px;border-radius:50%;
            border:2px solid ${u.color};object-fit:cover;opacity:${sameWs?1:0.45};" />`
        : `<div style="width:24px;height:24px;border-radius:50%;background:${u.color};
            border:2px solid ${u.color};display:flex;align-items:center;justify-content:center;
            font-size:9px;font-weight:700;color:white;opacity:${sameWs?1:0.45};">${initials}</div>`}
      <div style="position:absolute;bottom:-1px;right:-1px;width:7px;height:7px;border-radius:50%;
        background:${sameWs?"var(--success)":"var(--text-muted)"};border:1px solid var(--bg-surface);"></div>
    </div>`;
  }).join("");

  const warn = sameWsOthers.length > 0
    ? `<span style="font-size:10px;color:var(--warning);white-space:nowrap;">
        ⚠ ${sameWsOthers.map(u=>u.displayName.split(" ")[0]).join(", ")} arbeite${sameWsOthers.length>1?"n":"t"} hier auch
       </span>` : "";

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:0 14px;height:100%;min-width:0;">
      <div style="display:flex;gap:3px;align-items:center;flex-shrink:0;">${avatars}</div>
      <div style="min-width:0;flex-shrink:0;">
        <div style="font-size:11px;font-weight:600;color:var(--text-primary);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">
          ${esc(fb.user.displayName ?? fb.user.email ?? "User")}
        </div>
        <div style="font-size:10px;color:var(--text-muted);">${onlineUsers.length} online</div>
      </div>
      ${warn}
      <div style="flex:1;"></div>
      <button id="pb-signout" style="font-size:10px;padding:2px 8px;border-radius:4px;
        border:1px solid var(--border);background:transparent;color:var(--text-muted);
        cursor:pointer;white-space:nowrap;flex-shrink:0;">Abmelden</button>
    </div>`;

  bar.querySelector("#pb-signout")?.addEventListener("click", () => signOutUser());
}

// ── Login bar ──────────────────────────────────────────────
function renderLoginBar(bar: HTMLElement): void {
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:0 14px;height:100%;">
      <span style="font-size:11px;color:var(--text-muted);flex-shrink:0;">Nicht angemeldet</span>
      <button id="pb-open-login" class="btn btn-primary btn-sm" style="font-size:11px;padding:3px 12px;flex-shrink:0;">
        Anmelden / Registrieren
      </button>
    </div>`;
  bar.querySelector("#pb-open-login")?.addEventListener("click", openAuthModal);
}

// ── Auth Modal ─────────────────────────────────────────────
function openAuthModal(): void {
  document.getElementById("auth-modal-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "auth-modal-overlay";
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.6);
    display:flex;align-items:center;justify-content:center;z-index:9999;`;

  overlay.innerHTML = `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:10px;
      width:380px;max-width:95vw;box-shadow:0 16px 48px rgba(0,0,0,0.5);overflow:hidden;">

      <!-- Tabs -->
      <div style="display:flex;border-bottom:1px solid var(--border);">
        <button class="auth-tab active" data-tab="login"
          style="flex:1;padding:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;
          background:var(--bg-elevated);color:var(--accent);border-bottom:2px solid var(--accent);">
          Anmelden
        </button>
        <button class="auth-tab" data-tab="register"
          style="flex:1;padding:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;
          background:transparent;color:var(--text-muted);border-bottom:2px solid transparent;">
          Registrieren
        </button>
      </div>

      <!-- Login form -->
      <div id="auth-tab-login" style="padding:20px;display:flex;flex-direction:column;gap:12px;">
        <div>
          <label class="field-label">E-Mail</label>
          <input class="field-input" id="auth-login-email" type="email" placeholder="name@beispiel.de"
            autocomplete="email" style="width:100%;" />
        </div>
        <div>
          <label class="field-label">Passwort</label>
          <input class="field-input" id="auth-login-pw" type="password" placeholder="••••••••"
            autocomplete="current-password" style="width:100%;" />
        </div>
        <div id="auth-login-error" style="font-size:11px;color:var(--danger);display:none;"></div>
        <button id="auth-login-btn" class="btn btn-primary" style="width:100%;padding:8px;">
          Anmelden
        </button>
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <div style="flex:1;height:1px;background:var(--border);"></div>
          <span style="font-size:11px;color:var(--text-muted);">oder</span>
          <div style="flex:1;height:1px;background:var(--border);"></div>
        </div>
        <button id="auth-google-btn" class="btn btn-secondary" style="width:100%;padding:8px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Mit Google anmelden
        </button>
      </div>

      <!-- Register form -->
      <div id="auth-tab-register" style="padding:20px;display:none;flex-direction:column;gap:12px;">
        <div>
          <label class="field-label">Anzeigename</label>
          <input class="field-input" id="auth-reg-name" type="text" placeholder="Dein Name"
            autocomplete="name" style="width:100%;" />
        </div>
        <div>
          <label class="field-label">E-Mail</label>
          <input class="field-input" id="auth-reg-email" type="email" placeholder="name@beispiel.de"
            autocomplete="email" style="width:100%;" />
        </div>
        <div>
          <label class="field-label">Passwort <span style="color:var(--text-muted);font-weight:400;">(min. 6 Zeichen)</span></label>
          <input class="field-input" id="auth-reg-pw" type="password" placeholder="••••••••"
            autocomplete="new-password" style="width:100%;" />
        </div>
        <div id="auth-reg-error" style="font-size:11px;color:var(--danger);display:none;"></div>
        <button id="auth-reg-btn" class="btn btn-primary" style="width:100%;padding:8px;">
          Konto erstellen
        </button>
      </div>

      <!-- Close -->
      <div style="padding:0 20px 16px;text-align:center;">
        <button id="auth-close" style="font-size:11px;color:var(--text-muted);background:none;
          border:none;cursor:pointer;text-decoration:underline;">Abbrechen</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Tab switching
  overlay.querySelectorAll<HTMLElement>(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      overlay.querySelectorAll<HTMLElement>(".auth-tab").forEach(t => {
        t.style.color = "var(--text-muted)";
        t.style.background = "transparent";
        t.style.borderBottom = "2px solid transparent";
      });
      tab.style.color = "var(--accent)";
      tab.style.background = "var(--bg-elevated)";
      tab.style.borderBottom = "2px solid var(--accent)";

      const which = tab.dataset.tab!;
      (overlay.querySelector("#auth-tab-login") as HTMLElement).style.display =
        which === "login" ? "flex" : "none";
      (overlay.querySelector("#auth-tab-register") as HTMLElement).style.display =
        which === "register" ? "flex" : "none";
    });
  });

  // Close
  const close = () => overlay.remove();
  overlay.querySelector("#auth-close")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  // Login
  const loginBtn  = overlay.querySelector("#auth-login-btn")!;
  const loginErr  = overlay.querySelector("#auth-login-error") as HTMLElement;
  loginBtn.addEventListener("click", async () => {
    const email = (overlay.querySelector("#auth-login-email") as HTMLInputElement).value.trim();
    const pw    = (overlay.querySelector("#auth-login-pw")    as HTMLInputElement).value;
    if (!email || !pw) { loginErr.style.display=""; loginErr.textContent="Bitte alle Felder ausfüllen"; return; }
    loginBtn.textContent = "…";
    (loginBtn as HTMLButtonElement).disabled = true;
    const err = await signInEmail(email, pw);
    if (err) {
      loginErr.style.display = "";
      loginErr.textContent   = err;
      loginBtn.textContent   = "Anmelden";
      (loginBtn as HTMLButtonElement).disabled = false;
    } else {
      close();
    }
  });

  // Enter key on login
  overlay.querySelector("#auth-login-pw")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") (loginBtn as HTMLButtonElement).click();
  });

  // Google
  overlay.querySelector("#auth-google-btn")!.addEventListener("click", async () => {
    await signInWithGoogle(); // redirects away
  });

  // Register
  const regBtn = overlay.querySelector("#auth-reg-btn")!;
  const regErr = overlay.querySelector("#auth-reg-error") as HTMLElement;
  regBtn.addEventListener("click", async () => {
    const name  = (overlay.querySelector("#auth-reg-name")  as HTMLInputElement).value.trim();
    const email = (overlay.querySelector("#auth-reg-email") as HTMLInputElement).value.trim();
    const pw    = (overlay.querySelector("#auth-reg-pw")    as HTMLInputElement).value;
    if (!name || !email || !pw) { regErr.style.display=""; regErr.textContent="Bitte alle Felder ausfüllen"; return; }
    regBtn.textContent = "…";
    (regBtn as HTMLButtonElement).disabled = true;
    const err = await registerEmail(email, pw, name);
    if (err) {
      regErr.style.display = "";
      regErr.textContent   = err;
      regBtn.textContent   = "Konto erstellen";
      (regBtn as HTMLButtonElement).disabled = false;
    } else {
      close();
    }
  });

  // Auto-focus
  setTimeout(() => {
    (overlay.querySelector("#auth-login-email") as HTMLInputElement)?.focus();
  }, 50);
}

// ── Bar container ──────────────────────────────────────────
function getOrCreateBar(): HTMLElement {
  let el = document.getElementById("presence-bar");
  if (!el) {
    el = document.createElement("div");
    el.id = "presence-bar";
    el.style.cssText = `height:36px;background:var(--bg-elevated);
      border-bottom:1px solid var(--border);flex-shrink:0;overflow:hidden;`;

    const toolbar = document.getElementById("toolbar");
    if (toolbar) {
      toolbar.insertAdjacentElement("afterend", el);
      const appEl = document.getElementById("app");
      if (appEl) {
        appEl.style.gridTemplateRows    = "44px 36px 1fr 28px";
        appEl.style.gridTemplateAreas  =
          '"toolbar toolbar toolbar" "presence presence presence" "library canvas props" "statusbar statusbar statusbar"';
        el.style.gridArea = "presence";
      }
    }
  }
  return el;
}

function esc(s: string): string {
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
}
