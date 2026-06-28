import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth, GoogleAuthProvider,
  signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged,
  updateProfile, type User,
} from "firebase/auth";
import {
  getDatabase, ref, set, get, onValue,
  onDisconnect, serverTimestamp, off, type Database,
} from "firebase/database";
import { FIREBASE_CONFIG, FIREBASE_ENABLED } from "./config";
import type { LibraryItem, WorkbenchType, Faction } from "../types/index";
import { bus } from "../state/EventEmitter";

// ── Types ──────────────────────────────────────────────────
export interface PresenceUser {
  uid:          string;
  displayName:  string;
  email:        string;
  photoURL:     string;
  workbench:    WorkbenchType | null;
  faction:      Faction | null;
  workspaceKey: string;
  color:        string;
  lastSeen:     number | object;
  // Cursor position in canvas coords
  cursorX:      number;
  cursorY:      number;
}

export interface FirebaseState {
  enabled:     boolean;
  initialized: boolean;
  user:        User | null;
  users:       Map<string, PresenceUser>;
}

let app:  FirebaseApp | null = null;
let db:   Database    | null = null;
let auth: ReturnType<typeof getAuth> | null = null;

const state: FirebaseState = {
  enabled: FIREBASE_ENABLED, initialized: false,
  user: null, users: new Map(),
};

const PRESENCE_COLORS = [
  "#4d8ef0","#e85c8a","#50c878","#f0a030",
  "#a050e0","#20b8c8","#e06050","#80c040",
];
function colorForUid(uid: string): string {
  let h = 0;
  for (const c of uid) h = ((h << 5) - h) + c.charCodeAt(0);
  return PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length];
}

// ── Init ───────────────────────────────────────────────────
export function initFirebase(): void {
  if (!FIREBASE_ENABLED) return;
  try {
    app  = initializeApp(FIREBASE_CONFIG);
    db   = getDatabase(app);
    auth = getAuth(app);

    getRedirectResult(auth).catch(err => console.error("Redirect result error:", err));

    onAuthStateChanged(auth, user => {
      state.user = user;
      bus.emit("firebase:auth", user);
      if (user) { setupPresence(user); subscribeLibrary(); }
      else       { cleanupPresence(); }
    });

    state.initialized = true;
  } catch (e) { console.error("Firebase init failed:", e); }
}

// ── Auth ───────────────────────────────────────────────────
export async function signInWithGoogle(): Promise<void> {
  if (!auth) return;
  await signInWithRedirect(auth, new GoogleAuthProvider());
}

export async function signInEmail(email: string, password: string): Promise<string | null> {
  if (!auth) return "Firebase nicht verfügbar";
  try {
    await signInWithEmailAndPassword(auth, email, password);
    return null;
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password")
      return "E-Mail oder Passwort falsch";
    if (err.code === "auth/user-not-found") return "Kein Konto mit dieser E-Mail";
    if (err.code === "auth/too-many-requests") return "Zu viele Versuche — kurz warten";
    return "Anmeldung fehlgeschlagen";
  }
}

export async function registerEmail(email: string, password: string, displayName: string): Promise<string | null> {
  if (!auth) return "Firebase nicht verfügbar";
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName });
    return null;
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === "auth/email-already-in-use") return "E-Mail bereits registriert";
    if (err.code === "auth/weak-password")        return "Passwort zu schwach (min. 6 Zeichen)";
    if (err.code === "auth/invalid-email")        return "Ungültige E-Mail-Adresse";
    return "Registrierung fehlgeschlagen";
  }
}

export async function signOutUser(): Promise<void> {
  if (auth) await signOut(auth);
}

export function getFirebaseState(): Readonly<FirebaseState> { return state; }
export function isEnabled(): boolean { return FIREBASE_ENABLED && state.initialized; }

// ── Presence ───────────────────────────────────────────────
let presenceRef: ReturnType<typeof ref> | null = null;

function makePresenceData(user: User, update: Partial<PresenceUser> = {}): object {
  return {
    uid:          user.uid,
    displayName:  user.displayName ?? user.email ?? "Anonym",
    email:        user.email ?? "",
    photoURL:     user.photoURL ?? "",
    workbench:    null,
    faction:      null,
    workspaceKey: "Kleidung",
    color:        colorForUid(user.uid),
    cursorX:      0,
    cursorY:      0,
    ...update,
    lastSeen: serverTimestamp(),
  };
}

function setupPresence(user: User): void {
  if (!db) return;
  presenceRef = ref(db, `presence/${user.uid}`);
  set(presenceRef, makePresenceData(user));
  onDisconnect(presenceRef).remove();

  onValue(ref(db, "presence"), snapshot => {
    state.users.clear();
    const val = snapshot.val();
    if (val) Object.values(val).forEach((u: unknown) => {
      const pu = u as PresenceUser;
      state.users.set(pu.uid, pu);
    });
    bus.emit("firebase:presence");
  });
}

export function updatePresence(update: Partial<PresenceUser>): void {
  if (!db || !state.user || !presenceRef) return;
  set(presenceRef, makePresenceData(state.user, update));
}

function cleanupPresence(): void {
  if (!db) return;
  off(ref(db, "presence"));
  state.users.clear();
  bus.emit("firebase:presence");
}

// ── Library ────────────────────────────────────────────────
// Firebase Realtime DB node limit: 10MB
// Base64 images can be large — we chunk them safely
const MAX_IMAGE_BYTES = 900_000; // ~900KB per image (safe under Firebase limits)

let libraryCallback: ((items: LibraryItem[]) => void) | null = null;

export function subscribeLibrary(): void {
  if (!db) return;
  onValue(ref(db, "library"), snapshot => {
    const val = snapshot.val();
    if (val && libraryCallback) {
      const items = Object.values(val) as LibraryItem[];
      libraryCallback(items);
      bus.emit("firebase:library", items);
    }
  });
}

export function onLibraryUpdate(cb: (items: LibraryItem[]) => void): void {
  libraryCallback = cb;
}

export async function saveLibraryToFirebase(items: LibraryItem[]): Promise<void> {
  if (!db || !state.user) return;
  try {
    // Save each item as its own node (with imageUrl included directly)
    // This avoids the two-phase meta/image split that was causing the bug
    const libObj: Record<string, object> = {};
    for (const item of items) {
      // Check image size — skip if too large for Firebase
      let imageUrl: string | undefined = item.imageUrl;
      if (imageUrl && imageUrl.length > MAX_IMAGE_BYTES) {
        console.warn(`Image for ${item.classname} too large (${Math.round(imageUrl.length/1024)}KB), skipping`);
        imageUrl = undefined;
      }
      libObj[item.classname] = {
        classname:   item.classname,
        displayName: item.displayName,
        category:    item.category    ?? null,
        tags:        item.tags        ?? null,
        imageUrl:    imageUrl         ?? null,
      };
    }
    await set(ref(db, "library"), libObj);
  } catch (e) { console.error("Library save failed:", e); }
}

export async function loadLibraryFromFirebase(): Promise<LibraryItem[]> {
  if (!db) return [];
  try {
    const snap = await get(ref(db, "library"));
    const val  = snap.val() ?? {};
    return Object.values(val).map((m: unknown) => {
      const item = m as {
        classname: string; displayName: string;
        category?: string; tags?: string[]; imageUrl?: string;
      };
      return {
        classname:   item.classname,
        displayName: item.displayName,
        category:    item.category ?? undefined,
        tags:        item.tags     ?? undefined,
        imageUrl:    item.imageUrl ?? undefined,
      };
    });
  } catch (e) { console.error("Library load failed:", e); return []; }
}

// ── Workspace ──────────────────────────────────────────────
function sanitizeKey(key: string): string {
  return key.replace(/[.#$[\]/]/g, "_");
}

export function subscribeWorkspace(key: string, cb: (data: unknown) => void): () => void {
  if (!db) return () => {};
  const wsRef = ref(db, `workspaces/${sanitizeKey(key)}`);
  onValue(wsRef, snapshot => { const val = snapshot.val(); if (val) cb(val); });
  return () => off(wsRef);
}

export async function saveWorkspaceToFirebase(key: string, data: unknown): Promise<void> {
  if (!db || !state.user) return;
  try {
    await set(ref(db, `workspaces/${sanitizeKey(key)}`), JSON.parse(JSON.stringify(data)));
  } catch (e) { console.error("Workspace save failed:", e); }
}

export async function loadWorkspaceFromFirebase(key: string): Promise<unknown | null> {
  if (!db) return null;
  try {
    const snap = await get(ref(db, `workspaces/${sanitizeKey(key)}`));
    return snap.val();
  } catch (e) { console.error("Workspace load failed:", e); return null; }
}
