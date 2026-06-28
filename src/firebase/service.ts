import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  onAuthStateChanged, type User,
} from "firebase/auth";
import {
  getDatabase, ref, set, get, onValue, push, remove,
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
  lastSeen:     number | object; // serverTimestamp
}

export interface FirebaseState {
  enabled:     boolean;
  initialized: boolean;
  user:        User | null;
  users:       Map<string, PresenceUser>;
}

// ── Module state ───────────────────────────────────────────
let app:  FirebaseApp | null = null;
let db:   Database    | null = null;
let auth: ReturnType<typeof getAuth> | null = null;

const state: FirebaseState = {
  enabled:     FIREBASE_ENABLED,
  initialized: false,
  user:        null,
  users:       new Map(),
};

// Presence colors for different users
const PRESENCE_COLORS = [
  "#4d8ef0", "#e85c8a", "#50c878", "#f0a030",
  "#a050e0", "#20b8c8", "#e06050", "#80c040",
];

function colorForUid(uid: string): string {
  let hash = 0;
  for (const c of uid) hash = ((hash << 5) - hash) + c.charCodeAt(0);
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
}

// ── Init ───────────────────────────────────────────────────
export function initFirebase(): void {
  if (!FIREBASE_ENABLED) {
    console.log("Firebase disabled — using localStorage only");
    return;
  }
  try {
    app  = initializeApp(FIREBASE_CONFIG);
    db   = getDatabase(app);
    auth = getAuth(app);

    onAuthStateChanged(auth, user => {
      state.user = user;
      bus.emit("firebase:auth", user);
      if (user) {
        setupPresence(user);
        subscribeLibrary();
      } else {
        cleanupPresence();
      }
    });

    state.initialized = true;
    console.log("Firebase initialized");
  } catch (e) {
    console.error("Firebase init failed:", e);
  }
}

// ── Auth ───────────────────────────────────────────────────
export async function signInWithGoogle(): Promise<User | null> {
  if (!auth) return null;
  try {
    const provider = new GoogleAuthProvider();
    const result   = await signInWithPopup(auth, provider);
    return result.user;
  } catch (e) {
    console.error("Google sign-in failed:", e);
    return null;
  }
}

export async function signOutUser(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

export function getFirebaseState(): Readonly<FirebaseState> {
  return state;
}

export function isEnabled(): boolean {
  return FIREBASE_ENABLED && state.initialized;
}

// ── Presence ───────────────────────────────────────────────
let presenceRef: ReturnType<typeof ref> | null = null;

function setupPresence(user: User): void {
  if (!db) return;

  presenceRef = ref(db, `presence/${user.uid}`);

  const data: Omit<PresenceUser, "lastSeen"> & { lastSeen: object } = {
    uid:          user.uid,
    displayName:  user.displayName ?? user.email ?? "Anonym",
    email:        user.email ?? "",
    photoURL:     user.photoURL ?? "",
    workbench:    null,
    faction:      null,
    workspaceKey: "Kleidung",
    color:        colorForUid(user.uid),
    lastSeen:     serverTimestamp(),
  };

  set(presenceRef, data);
  onDisconnect(presenceRef).remove();

  // Subscribe to all presence
  const allPresenceRef = ref(db, "presence");
  onValue(allPresenceRef, snapshot => {
    state.users.clear();
    const val = snapshot.val();
    if (val) {
      Object.values(val).forEach((u: unknown) => {
        const pu = u as PresenceUser;
        state.users.set(pu.uid, pu);
      });
    }
    bus.emit("firebase:presence");
  });
}

export function updatePresence(update: Partial<PresenceUser>): void {
  if (!db || !state.user || !presenceRef) return;
  set(presenceRef, {
    uid:          state.user.uid,
    displayName:  state.user.displayName ?? state.user.email ?? "Anonym",
    email:        state.user.email ?? "",
    photoURL:     state.user.photoURL ?? "",
    workbench:    null,
    faction:      null,
    workspaceKey: "Kleidung",
    color:        colorForUid(state.user.uid),
    ...update,
    lastSeen:     serverTimestamp(),
  });
}

function cleanupPresence(): void {
  if (!db) return;
  const allPresenceRef = ref(db, "presence");
  off(allPresenceRef);
  state.users.clear();
  bus.emit("firebase:presence");
}

// ── Library Sync ───────────────────────────────────────────
let libraryCallback: ((items: LibraryItem[]) => void) | null = null;

export function subscribeLibrary(): void {
  if (!db) return;
  const libRef = ref(db, "library");
  onValue(libRef, snapshot => {
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

  // Save images separately (same split strategy as localStorage)
  // Store metadata only in the main library node
  const meta = items.map(item => ({
    classname:   item.classname,
    displayName: item.displayName,
    category:    item.category ?? null,
    tags:        item.tags ?? null,
    hasImage:    !!item.imageUrl,
  }));

  try {
    await set(ref(db, "library"), Object.fromEntries(meta.map(m => [m.classname, m])));

    // Save images as separate nodes (base64 can be large)
    for (const item of items) {
      if (item.imageUrl) {
        await set(ref(db, `library_images/${item.classname}`), item.imageUrl);
      }
    }
  } catch (e) {
    console.error("Library save to Firebase failed:", e);
  }
}

export async function loadLibraryFromFirebase(): Promise<LibraryItem[]> {
  if (!db) return [];
  try {
    const [metaSnap, imgSnap] = await Promise.all([
      get(ref(db, "library")),
      get(ref(db, "library_images")),
    ]);
    const meta   = metaSnap.val()  ?? {};
    const images = imgSnap.val()   ?? {};
    return Object.values(meta).map((m: unknown) => {
      const item = m as { classname: string; displayName: string; category?: string; tags?: string[] };
      return {
        classname:   item.classname,
        displayName: item.displayName,
        category:    item.category ?? undefined,
        tags:        item.tags     ?? undefined,
        imageUrl:    images[item.classname] ?? undefined,
      };
    });
  } catch (e) {
    console.error("Library load from Firebase failed:", e);
    return [];
  }
}

// ── Workspace Sync ─────────────────────────────────────────
type WorkspaceCallback = (data: unknown) => void;
const workspaceCallbacks = new Map<string, WorkspaceCallback>();

export function subscribeWorkspace(key: string, cb: WorkspaceCallback): () => void {
  if (!db) return () => {};
  const wsRef = ref(db, `workspaces/${sanitizeKey(key)}`);
  workspaceCallbacks.set(key, cb);
  onValue(wsRef, snapshot => {
    const val = snapshot.val();
    if (val) cb(val);
  });
  return () => {
    off(wsRef);
    workspaceCallbacks.delete(key);
  };
}

export async function saveWorkspaceToFirebase(key: string, data: unknown): Promise<void> {
  if (!db || !state.user) return;
  try {
    await set(ref(db, `workspaces/${sanitizeKey(key)}`), JSON.parse(JSON.stringify(data)));
  } catch (e) {
    console.error("Workspace save failed:", e);
  }
}

export async function loadWorkspaceFromFirebase(key: string): Promise<unknown | null> {
  if (!db) return null;
  try {
    const snap = await get(ref(db, `workspaces/${sanitizeKey(key)}`));
    return snap.val();
  } catch (e) {
    console.error("Workspace load failed:", e);
    return null;
  }
}

// Firebase keys can't have . / # $ [ ]
function sanitizeKey(key: string): string {
  return key.replace(/[.#$[\]/]/g, "_");
}
