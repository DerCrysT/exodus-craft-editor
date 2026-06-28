import {
  getFirebaseState, signInWithGoogle, signInEmail,
  registerEmail, signOutUser, updatePresence, isEnabled,
  type PresenceUser,
} from "../../firebase/service";
import { bus } from "../../state/EventEmitter";
import { store } from "../../state/AppStore";

// ── Init ───────────────────────────────────────────────────
export function initPresenceBar(): void {
  if (!isEnabled()) { renderOfflineBar(); return; }

  bus.on("firebase:auth",     () => renderPresenceBar());
  bus.on("firebase:presence", () => { renderPresenceBar(); renderCursors(); });
  bus.on("workspace:change",  () => { syncPresence(); renderCursors(); });
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

// ── Cursor overlays ────────────────────────────────────────
function renderCursors(): void {
  const root = document.getElementById("node-editor-root");
  if (!root) return;

  // Remove stale cursors
  root.querySelectorAll(".teammate-cursor").forEach(el => el.remove());

  const fb  = getFirebaseState();
  if (!fb.user) return;
  const wsKey = store.currentWorkspaceKey();
  const canvas = store.getState().project.canvas;

  fb.users.forEach(u => {
    if (u.uid === fb.user!.uid) return;          // skip self
    if (u.workspaceKey !== wsKey) return;         // skip other workspaces
    if (!u.cursorX && !u.cursorY) return;         // no cursor yet

    // Convert canvas → screen coordinates
    const sx = u.cursorX * canvas.zoom + canvas.offsetX;
    const sy = u.cursorY * canvas.zoom + canvas.offsetY;

    const cursor = document.createElement("div");
    cursor.className = "teammate-cursor";
    cursor.style.cssText = `
      position:absolute;
      left:${sx}px;top:${sy}px;
      pointer-events:none;
      z-index:1000;
      transform:translate(0,-2px);
      transition:left 0.2s ease, top 0.2s ease;
    `;
    cursor.innerHTML = `
      <svg width="18" height="22" viewBox="0 0 18 22" fill="none">
        <path d="M0 0 L0 16 L4 12 L7 19 L9 18 L6 11 L11 11 Z"
          fill="${u.color}" stroke="white" stroke-width="1"/>
      </svg>
      <div style="
        position:absolute;left:14px;top:12px;
        background:${u.color};color:white;
        font-size:10px;font-weight:600;padding:1px 5px;
        border-radius:3px;white-space:nowrap;
        box-shadow:0 1px 4px rgba(0,0,0,0.3);
      ">${esc(u.displayName.split(" ")[0])}</div>
    `;
    root.appendChild(cursor);
  });
}

// ── Offline bar ────────────────────────────────────────────
function renderOfflineBar(): void {
  const c = getOrCreateBar();
  c.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:0 14px;height:100%;">
    <span style="font-size:11px;color:var(--text-muted);">🔌 Offline-Modus</span>
  </div>`;
}

// ── Main bar render ────────────────────────────────────────
function renderPresenceBar(): void {
  const bar = getOrCreateBar();
  const fb  = getFirebaseState();

  if (!fb.user) { renderLoginBar(bar); return; }

  const all     = [...fb.users.values()];
  const wsKey   = store.currentWorkspaceKey();
  const others  = all.filter(u => u.workspaceKey === wsKey && u.uid !== fb.user!.uid);

  const avatars = all.map(u => {
    const isMe   = u.uid === fb.user!.uid;
    const sameWs = u.workspaceKey === wsKey;
    const init   = (u.displayName || u.email || "?").slice(0,2).toUpperCase();
    const wsLabel = formatWsLabel(u.workspaceKey);
    return `
      <div class="presence-avatar" title="${esc(u.displayName)} — ${esc(wsLabel)}${isMe?" (Du)":""}"
        style="position:relative;flex-shrink:0;">
        ${u.photoURL
          ? `<img src="${esc(u.photoURL)}" style="width:24px;height:24px;border-radius:50%;
              border:2px solid ${u.color};object-fit:cover;opacity:${sameWs?1:0.4};"/>`
          : `<div style="width:24px;height:24px;border-radius:50%;background:${u.color};
              display:flex;align-items:center;justify-content:center;font-size:9px;
              font-weight:700;color:white;opacity:${sameWs?1:0.4};">${init}</div>`}
        <div style="position:absolute;bottom:-1px;right:-1px;width:7px;height:7px;
          border-radius:50%;background:${sameWs?"var(--success)":"var(--text-muted)"};
          border:1px solid var(--bg-surface);"></div>
      </div>`;
  }).join("");

  const warn = others.length > 0
    ? `<span style="font-size:10px;color:var(--warning);white-space:nowrap;flex-shrink:0;">
        ⚠ ${others.map(u=>u.displayName.split(" ")[0]).join(", ")} ${others.length===1?"ist":"sind"} hier
       </span>` : "";

  // Workspace label
  const wsLabel = formatWsLabel(wsKey);

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:0 14px;height:100%;min-width:0;">
      <div style="display:flex;gap:3px;align-items:center;flex-shrink:0;">${avatars}</div>
      <div style="min-width:0;flex-shrink:0;">
        <div style="font-size:11px;font-weight:600;color:var(--text-primary);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;">
          ${esc(fb.user.displayName ?? fb.user.email ?? "User")}
        </div>
        <div style="font-size:10px;color:var(--text-muted);">${all.length} online · ${esc(wsLabel)}</div>
      </div>
      ${warn}
      <div style="flex:1;"></div>
      <div id="autosync-indicator" style="font-size:10px;color:var(--text-muted);
        display:flex;align-items:center;gap:4px;flex-shrink:0;">
        <div id="sync-dot" style="width:6px;height:6px;border-radius:50%;background:var(--success);"></div>
        <span id="sync-label">Synced</span>
      </div>
      <button id="pb-signout" style="font-size:10px;padding:2px 8px;border-radius:4px;
        border:1px solid var(--border);background:transparent;color:var(--text-muted);
        cursor:pointer;white-space:nowrap;flex-shrink:0;margin-left:4px;">Abmelden</button>
    </div>`;

  bar.querySelector("#pb-signout")?.addEventListener("click", () => signOutUser());

  // Pulse sync dot every 5s
  let lastSync = Date.now();
  const dot   = bar.querySelector<HTMLElement>("#sync-dot");
  const label = bar.querySelector<HTMLElement>("#sync-label");
  setInterval(() => {
    if (!dot || !label) return;
    dot.style.background = "var(--accent)";
    label.textContent    = "Syncing…";
    setTimeout(() => {
      if (!dot || !label) return;
      dot.style.background = "var(--success)";
      label.textContent    = `Synced ${new Date().toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})}`;
      lastSync = Date.now();
    }, 800);
  }, 5000);
}

function formatWsLabel(key: string): string {
  // "Kleidung_Duty" → "Kleidung / Duty"
  return key.replace("_", " / ");
}

// ── Login bar ──────────────────────────────────────────────
function renderLoginBar(bar: HTMLElement): void {
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:0 14px;height:100%;">
      <span style="font-size:11px;color:var(--text-muted);flex-shrink:0;">Nicht angemeldet —</span>
      <button id="pb-open-login" class="btn btn-primary btn-sm"
        style="font-size:11px;padding:3px 12px;flex-shrink:0;">
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
      <div style="display:flex;border-bottom:1px solid var(--border);">
        <button class="auth-tab" data-tab="login"
          style="flex:1;padding:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;
          background:var(--bg-elevated);color:var(--accent);border-bottom:2px solid var(--accent);">
          Anmelden</button>
        <button class="auth-tab" data-tab="register"
          style="flex:1;padding:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;
          background:transparent;color:var(--text-muted);border-bottom:2px solid transparent;">
          Registrieren</button>
      </div>
      <div id="auth-tab-login" style="padding:20px;display:flex;flex-direction:column;gap:12px;">
        <div><label class="field-label">E-Mail</label>
          <input class="field-input" id="auth-login-email" type="email"
            placeholder="name@beispiel.de" autocomplete="email" style="width:100%;"/></div>
        <div><label class="field-label">Passwort</label>
          <input class="field-input" id="auth-login-pw" type="password"
            placeholder="••••••••" autocomplete="current-password" style="width:100%;"/></div>
        <div id="auth-login-error" style="font-size:11px;color:var(--danger);display:none;"></div>
        <button id="auth-login-btn" class="btn btn-primary" style="width:100%;padding:8px;">Anmelden</button>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;height:1px;background:var(--border);"></div>
          <span style="font-size:11px;color:var(--text-muted);">oder</span>
          <div style="flex:1;height:1px;background:var(--border);"></div>
        </div>
        <button id="auth-google-btn" class="btn btn-secondary"
          style="width:100%;padding:8px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Mit Google anmelden</button>
      </div>
      <div id="auth-tab-register" style="padding:20px;display:none;flex-direction:column;gap:12px;">
        <div><label class="field-label">Anzeigename</label>
          <input class="field-input" id="auth-reg-name" type="text"
            placeholder="Dein Name" autocomplete="name" style="width:100%;"/></div>
        <div><label class="field-label">E-Mail</label>
          <input class="field-input" id="auth-reg-email" type="email"
            placeholder="name@beispiel.de" autocomplete="email" style="width:100%;"/></div>
        <div><label class="field-label">Passwort <span style="color:var(--text-muted);font-weight:400;">(min. 6 Zeichen)</span></label>
          <input class="field-input" id="auth-reg-pw" type="password"
            placeholder="••••••••" autocomplete="new-password" style="width:100%;"/></div>
        <div id="auth-reg-error" style="font-size:11px;color:var(--danger);display:none;"></div>
        <button id="auth-reg-btn" class="btn btn-primary" style="width:100%;padding:8px;">Konto erstellen</button>
      </div>
      <div style="padding:0 20px 16px;text-align:center;">
        <button id="auth-close" style="font-size:11px;color:var(--text-muted);background:none;
          border:none;cursor:pointer;text-decoration:underline;">Abbrechen</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();

  // Tabs
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

  overlay.querySelector("#auth-close")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  // Login
  const loginBtn = overlay.querySelector("#auth-login-btn")! as HTMLButtonElement;
  const loginErr = overlay.querySelector("#auth-login-error")! as HTMLElement;
  const doLogin  = async () => {
    const email = (overlay.querySelector("#auth-login-email") as HTMLInputElement).value.trim();
    const pw    = (overlay.querySelector("#auth-login-pw")    as HTMLInputElement).value;
    if (!email || !pw) { loginErr.style.display=""; loginErr.textContent="Bitte alle Felder ausfüllen"; return; }
    loginBtn.textContent = "…"; loginBtn.disabled = true;
    const err = await signInEmail(email, pw);
    if (err) { loginErr.style.display=""; loginErr.textContent=err; loginBtn.textContent="Anmelden"; loginBtn.disabled=false; }
    else     { close(); }
  };
  loginBtn.addEventListener("click", doLogin);
  overlay.querySelector("#auth-login-pw")!.addEventListener("keydown", e => {
    if ((e as KeyboardEvent).key === "Enter") doLogin();
  });

  // Google
  overlay.querySelector("#auth-google-btn")!.addEventListener("click", () => signInWithGoogle());

  // Register
  const regBtn = overlay.querySelector("#auth-reg-btn")! as HTMLButtonElement;
  const regErr = overlay.querySelector("#auth-reg-error")! as HTMLElement;
  const doReg  = async () => {
    const name  = (overlay.querySelector("#auth-reg-name")  as HTMLInputElement).value.trim();
    const email = (overlay.querySelector("#auth-reg-email") as HTMLInputElement).value.trim();
    const pw    = (overlay.querySelector("#auth-reg-pw")    as HTMLInputElement).value;
    if (!name||!email||!pw) { regErr.style.display=""; regErr.textContent="Bitte alle Felder ausfüllen"; return; }
    regBtn.textContent = "…"; regBtn.disabled = true;
    const err = await registerEmail(email, pw, name);
    if (err) { regErr.style.display=""; regErr.textContent=err; regBtn.textContent="Konto erstellen"; regBtn.disabled=false; }
    else     { close(); }
  };
  regBtn.addEventListener("click", doReg);

  setTimeout(() => (overlay.querySelector("#auth-login-email") as HTMLInputElement)?.focus(), 50);
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
      const app = document.getElementById("app");
      if (app) {
        app.style.gridTemplateRows   = "44px 36px 1fr 28px";
        app.style.gridTemplateAreas =
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
