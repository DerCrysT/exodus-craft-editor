import {
  getFirebaseState, signInWithGoogle, signOutUser,
  updatePresence, isEnabled,
} from "../../firebase/service";
import { bus } from "../../state/EventEmitter";
import { store } from "../../state/AppStore";

export function initPresenceBar(): void {
  if (!isEnabled()) {
    // Show offline indicator
    renderOfflineBar();
    return;
  }

  bus.on("firebase:auth",     () => renderPresenceBar());
  bus.on("firebase:presence", () => renderPresenceBar());
  bus.on("workspace:change",  () => syncPresenceToWorkspace());
  bus.on("state:change",      () => syncPresenceToWorkspace());

  renderPresenceBar();
}

function syncPresenceToWorkspace(): void {
  if (!isEnabled()) return;
  const state = store.getState();
  updatePresence({
    workbench:    state.activeWorkbench,
    faction:      state.activeFaction,
    workspaceKey: store.currentWorkspaceKey(),
  });
}

function renderOfflineBar(): void {
  const container = getOrCreateContainer();
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:0 12px;height:100%;">
      <div style="width:8px;height:8px;border-radius:50%;background:var(--text-muted);flex-shrink:0;"></div>
      <span style="font-size:11px;color:var(--text-muted);">Offline-Modus (Firebase nicht konfiguriert)</span>
    </div>
  `;
}

function renderPresenceBar(): void {
  const container = getOrCreateContainer();
  const fb = getFirebaseState();

  if (!fb.user) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:0 12px;height:100%;">
        <div style="width:8px;height:8px;border-radius:50%;background:var(--warning);flex-shrink:0;"></div>
        <span style="font-size:11px;color:var(--text-muted);">Nicht angemeldet</span>
        <button id="pb-signin" class="btn btn-primary btn-sm" style="padding:3px 10px;font-size:11px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:4px;">
            <path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032
              s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2
              C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z"/>
          </svg>
          Mit Google anmelden
        </button>
      </div>
    `;
    container.querySelector("#pb-signin")?.addEventListener("click", async () => {
      await signInWithGoogle();
    });
    return;
  }

  // Logged in — show presence
  const onlineUsers = [...fb.users.values()];
  const currentWsKey = store.currentWorkspaceKey();

  const userAvatars = onlineUsers.map(u => {
    const isMe    = u.uid === fb.user!.uid;
    const isSameWs = u.workspaceKey === currentWsKey;
    const initials = (u.displayName || u.email || "?").slice(0, 2).toUpperCase();
    const wsLabel  = u.workspaceKey || "—";

    return `
      <div style="position:relative;display:inline-block;" title="${esc(u.displayName)} — ${esc(wsLabel)}${isMe ? " (Du)" : ""}">
        ${u.photoURL
          ? `<img src="${esc(u.photoURL)}" style="
              width:26px;height:26px;border-radius:50%;
              border:2px solid ${u.color};
              object-fit:cover;
              opacity:${isSameWs ? 1 : 0.5};
              filter:${isSameWs ? 'none' : 'grayscale(60%)'};
            " />`
          : `<div style="
              width:26px;height:26px;border-radius:50%;
              background:${u.color};border:2px solid ${u.color};
              display:flex;align-items:center;justify-content:center;
              font-size:10px;font-weight:700;color:white;
              opacity:${isSameWs ? 1 : 0.5};
            ">${initials}</div>`
        }
        <div style="
          position:absolute;bottom:-1px;right:-1px;
          width:8px;height:8px;border-radius:50%;
          background:${isSameWs ? 'var(--success)' : 'var(--text-muted)'};
          border:1px solid var(--bg-surface);
        "></div>
      </div>
    `;
  }).join("");

  // Users in same workspace
  const sameWsUsers = onlineUsers.filter(u => u.workspaceKey === currentWsKey && u.uid !== fb.user!.uid);
  const editingLabel = sameWsUsers.length > 0
    ? `<span style="font-size:10px;color:var(--warning);margin-left:4px;">
        ⚠ ${sameWsUsers.map(u => u.displayName.split(" ")[0]).join(", ")} ${sameWsUsers.length === 1 ? "arbeitet" : "arbeiten"} hier auch
       </span>`
    : "";

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:0 12px;height:100%;">
      <div style="display:flex;gap:-4px;align-items:center;">
        ${userAvatars}
      </div>
      <div style="display:flex;flex-direction:column;line-height:1.2;">
        <span style="font-size:11px;color:var(--text-primary);font-weight:500;">${esc(fb.user.displayName ?? fb.user.email ?? "User")}</span>
        <span style="font-size:10px;color:var(--text-muted);">${onlineUsers.length} online</span>
      </div>
      ${editingLabel}
      <div style="flex:1;"></div>
      <button id="pb-signout" class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px;opacity:0.7;">
        Abmelden
      </button>
    </div>
  `;

  container.querySelector("#pb-signout")?.addEventListener("click", () => signOutUser());
}

function getOrCreateContainer(): HTMLElement {
  let el = document.getElementById("presence-bar");
  if (!el) {
    el = document.createElement("div");
    el.id = "presence-bar";
    el.style.cssText = `
      grid-area: toolbar;
      display: flex;
      align-items: center;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      height: 36px;
      flex-shrink: 0;
    `;
    // Insert after toolbar
    const toolbar = document.getElementById("toolbar");
    if (toolbar) {
      toolbar.insertAdjacentElement("afterend", el);
      // Adjust grid to add presence bar row
      const appEl = document.getElementById("app");
      if (appEl) {
        appEl.style.gridTemplateRows = "44px 36px 1fr 28px";
        appEl.style.gridTemplateAreas = `
          "toolbar toolbar toolbar"
          "presence presence presence"
          "library canvas props"
          "statusbar statusbar statusbar"
        `;
        el.style.gridArea = "presence";
      }
    }
  }
  return el;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
