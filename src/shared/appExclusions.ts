/**
 * Settings → Capture → "Apps that stay private" (2026-11-18: "you should be able to select applications, not type
 * them in that weird format"). Pure: the installed apps come from the main process (`src/main/apps.ts`), the apps
 * used from the workspace. The setting itself is unchanged: `excludedOwnerIDs`, a bundle id on macOS and an
 * executable's file name on Windows and Linux, matched as before by `isExcluded()`.
 */
import { isBrowser, isLockScreen, MANUAL_OWNER_ID, type Workspace } from "./model";

/** One app the person can pick. `id` is what goes in `excludedOwnerIDs`; `path` is where it is, for its icon. */
export type AppChoice = { id: string; name: string; path?: string | null; seconds?: number };

/** The id an exclusion is stored under: a bundle id as it is, a Windows or Linux path as its file name. */
export function exclusionID(ownerID: string): string {
    const id = ownerID.trim();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(id) && !/\.exe$/i.test(id)) return id;
    return id.split(/[\\/]/).pop() ?? id;
}

const key = (id: string) => exclusionID(id).toLowerCase();

/** Names for the apps excluded by default, so they read as apps before the installed list has come. */
const KNOWN_NAMES: Record<string, string> = {
    "com.apple.systempreferences": "System Settings",
    "com.apple.keychainaccess": "Keychain Access",
    "com.apple.passwords": "Passwords",
    "com.agilebits.onepassword7": "1Password 7",
    "com.1password.1password": "1Password",
    "1password.exe": "1Password",
    "keepass.exe": "KeePass",
    "bitwarden.exe": "Bitwarden",
};

/** A readable name for an id nothing else names: "keepass.exe" → "keepass", "com.example.Private-App" → "Private-App". */
export function fallbackName(id: string): string {
    const known = KNOWN_NAMES[id.toLowerCase()];
    if (known) return known;
    const base = exclusionID(id).replace(/\.(exe|app|desktop)$/i, "");
    return /\./.test(base) ? base.split(".").pop() || base : base;
}

/** This app, packaged and in development (Electron). */
export const SELF_OWNER_IDS = ["co.lawdie.timecapture.desktop", "com.github.electron", "lawdie time capture.exe", "lawdie-time-capture", "electron.exe", "electron"];

/** Never offered: browsers are never captured anyway, nor this app, the lock screen or time added by hand. */
export const offerable = (id: string, selfID?: string | null): boolean =>
    !!id && !isBrowser(id) && !isLockScreen(id) && id !== MANUAL_OWNER_ID && !id.startsWith("calendar:") && !SELF_OWNER_IDS.includes(key(id)) && (!selfID || key(id) !== key(selfID));

/** The apps this workspace has captured, most time first, by the id they would be excluded under. */
export function usedApps(w: Workspace, selfID?: string | null): AppChoice[] {
    const byID = new Map<string, AppChoice>();
    for (const a of w.activities) {
        if (a.origin || !offerable(a.ownerID, selfID)) continue;
        const id = exclusionID(a.ownerID), k = id.toLowerCase();
        const secs = Math.max(0, (Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000);
        const had = byID.get(k);
        if (had) had.seconds = (had.seconds ?? 0) + secs;
        else byID.set(k, { id, name: a.app || fallbackName(id), seconds: secs });
    }
    return [...byID.values()].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0) || a.name.localeCompare(b.name));
}

/** Installed and used apps as one list, one row per id (the installed app's name and path win), by name. */
export function appChoices(installed: readonly AppChoice[], used: readonly AppChoice[], selfID?: string | null): AppChoice[] {
    const byID = new Map<string, AppChoice>();
    for (const a of installed) if (offerable(a.id, selfID) && !byID.has(key(a.id))) byID.set(key(a.id), { ...a, id: exclusionID(a.id) });
    for (const a of used) {
        const had = byID.get(key(a.id));
        if (had) had.seconds = a.seconds;
        else if (offerable(a.id, selfID)) byID.set(key(a.id), { ...a, id: exclusionID(a.id) });
    }
    return [...byID.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Whether an id could name an app on this platform: a bundle id on macOS, a program name elsewhere. */
export const forPlatform = (id: string, platform: string): boolean => {
    const bundle = exclusionID(id) === id.trim() && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(id) && !/\.exe$/i.test(id);
    return platform === "darwin" ? bundle : !bundle;
};

/**
 * Each excluded id with the name and path of the app it is, when one is known; `named` says the name is real
 * rather than guessed from the id. Ids for another platform (the defaults carry both) are left off the list shown.
 */
export function excludedApps(excluded: readonly string[], known: readonly AppChoice[], platform?: string): (AppChoice & { named: boolean })[] {
    return excluded.filter((id) => !platform || forPlatform(id, platform)).map((id) => {
        const app = known.find((a) => key(a.id) === key(id));
        return app ? { ...app, id, named: true } : { id, name: fallbackName(id), named: id.toLowerCase() in KNOWN_NAMES };
    });
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The apps whose name or id has every word of the query, names that start with it first. */
export function searchApps(apps: readonly AppChoice[], query: string): AppChoice[] {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [...apps];
    const q = fold(query.trim());
    return apps
        .filter((a) => { const hay = fold(`${a.name} ${a.id}`); return words.every((w) => hay.includes(w)); })
        .sort((a, b) => Number(fold(b.name).startsWith(q)) - Number(fold(a.name).startsWith(q)));
}

/** Adds ids to the list, never twice (case ignored), keeping the order the list had. */
export function withExclusions(excluded: readonly string[], ids: readonly string[]): string[] {
    const out = [...excluded];
    for (const raw of ids) { const id = exclusionID(raw); if (id && !out.some((x) => key(x) === key(id))) out.push(id); }
    return out;
}

/** Whether an app is on the list. */
export const isOnList = (excluded: readonly string[], id: string): boolean => excluded.some((x) => key(x) === key(id));
