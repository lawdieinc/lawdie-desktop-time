import { isProduct, type Product } from "./kiwi";
/* The workspace and the rules that change it. Pure: no Electron, no filesystem, no
   clock of its own — every function takes `now` in milliseconds — so the whole thing
   runs under vitest and inside the main process unchanged.

   These are the ideas the Swift app (legacy/swift) was built on, kept: capture is opt-in
   and titles are a separate opt-in; a segment is bounded by wall-clock observations and
   never spans an unobserved gap; idle trims to the last input; raw activity is evidence,
   not time, until a person keeps it; kept time never overlaps; rates freeze at save.
   Dates are ISO-8601 strings, which is both the file format and the wire format. */

export const SCHEMA_VERSION = 2;
export const APP_ID = "co.lawdie.timecapture.desktop";
/** A stalled process or a sleep must never inflate a timer or a segment. */
export const GAP_SECONDS = 45;
export const MIN_ACTIVITY_SECONDS = 2;

export type Project = {
    id: string;
    name: string;
    client: string;
    color: string;
    hourlyRate: number;
    archived: boolean;
    /** What a model made of the matter's work, shown on its page. Nothing writes one yet but
     *  sample data ("sample"); Kiwi is meant to ("kiwi"). */
    insight?: MatterInsight | null;
};

export type MatterInsight = { summary: string; points: string[]; generatedAt: string; source: "kiwi" | "sample" };
export const INSIGHT_MAX = 2000;

const insightValid = (i: MatterInsight | null | undefined): boolean =>
    i == null || (typeof i.summary === "string" && i.summary.length <= INSIGHT_MAX && Array.isArray(i.points) && i.points.length <= 12
        && i.points.every((x) => typeof x === "string" && x.length <= 500) && validIso(i.generatedAt) && (i.source === "kiwi" || i.source === "sample"));

export type TimeEntry = {
    id: string;
    description: string;
    projectID: string | null;
    startedAt: string;
    endedAt: string;
    billable: boolean;
    hourlyRate: number;
    /** manual | timer | desktop | timer-idle | timer-suspended | timer-recovered */
    source: string;
    activityID: string | null;
    /** A stretch kept from several sittings: the sittings, in order, inside [startedAt, endedAt]. Only their time counts. */
    sittings?: Interval[];
    /** Every activity a stretch entry was kept from (activityID is the first). */
    activityIDs?: string[];
    /** The description is an AI draft, kept as written. */
    drafted?: DraftSource;
};

export type Interval = { startedAt: string; endedAt: string };

/** Where an AI draft came from: Kiwi, or sample data (nothing drafts yet). */
export type DraftSource = "kiwi" | "sample";
export type Draft = { text: string; source: DraftSource };
export const DRAFT_MAX = 500;
const draftValid = (d: Draft | null | undefined): boolean => d == null || (typeof d.text === "string" && d.text.length > 0 && d.text.length <= DRAFT_MAX && (d.source === "kiwi" || d.source === "sample"));

export type RunningTimer = {
    description: string;
    projectID: string | null;
    startedAt: string;
    lastHeartbeat: string;
    billable: boolean;
    hourlyRate: number;
};

/** What an Office app said it had open, when the person switched that on. */
export type DocumentInfo = {
    /** "Whitfield motion.docx", or an email's subject. */
    name: string;
    /** Where it is saved, or null for an unsaved document or an email. */
    path: string | null;
    /** The first few hundred characters of text (Outlook: sender and subject), or null. */
    excerpt: string | null;
};

export const EXCERPT_MAX = 600;

export type Activity = {
    id: string;
    app: string;
    /** The stable id of the app: bundle id on macOS, executable path elsewhere. */
    ownerID: string;
    title: string | null;
    /** Present only for Office apps with "Read Office document details" on. */
    document?: DocumentInfo | null;
    /** Text the window showed, read through the OS accessibility system, with "Read on-screen text" on. */
    screenText?: string | null;
    startedAt: string;
    endedAt: string;
    endedBy: string;
    disposition: "pending" | "kept" | "dismissed";
    /** The matter this was work on: suggested by the model (src/shared/matters.ts) or set by
     *  the person. Absent until asked; null when it is not work on any matter. */
    matter?: string | null;
    /** Who named the matter. A person's answer is never overwritten by a suggestion. */
    matterBy?: "ai" | "person";
    /** A billing description drafted by a model for the work this is part of; a person keeps or edits it. */
    draft?: Draft | null;
};

export type Preferences = {
    captureEnabled: boolean;
    captureTitles: boolean;
    /** Ask Word, Excel, PowerPoint and Outlook what is open: name, path, a text excerpt. */
    captureDocuments: boolean;
    /** Read the text the window in front shows (accessibility), for apps other than Office and browsers. */
    captureScreenText: boolean;
    /** Send closed, pending activity (titles, document details) to Kiwi to name its matter. */
    suggestMatters: boolean;
    idleMinutes: number;
    retentionDays: number;
    excludedOwnerIDs: string[];
};

/** One product this computer syncs to. Each has its own device row, so its own id and name. */
export type SyncTarget = {
    product: Product;
    serverURL: string;
    deviceID: string;
    deviceName: string;
    accountEmail: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
    /** Deletions this product has not acknowledged yet: the one outbox, per product. */
    deletedEntryIDs: string[];
};

/** Kiwi, Lawdie CRM, or both — with one token. Files from 0.4.x (one product, flat) are read into this. */
export type SyncState = {
    targets: SyncTarget[];
    autoSync: boolean;
};

export type Workspace = {
    schemaVersion: number;
    projects: Project[];
    entries: TimeEntry[];
    activities: Activity[];
    timer: RunningTimer | null;
    currentActivity: Activity | null;
    preferences: Preferences;
    sync: SyncState | null;
};

export const DEFAULT_EXCLUSIONS = [
    // macOS
    "com.apple.systempreferences",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.agilebits.onepassword7",
    "com.1password.1password",
    // Windows (executable names; matched case-insensitively by basename)
    "1password.exe",
    "keepass.exe",
    "bitwarden.exe",
];

export function defaultPreferences(): Preferences {
    return { captureEnabled: false, captureTitles: false, captureDocuments: false, captureScreenText: false, suggestMatters: false, idleMinutes: 3, retentionDays: 14, excludedOwnerIDs: [...DEFAULT_EXCLUSIONS] };
}

export function emptyWorkspace(): Workspace {
    return { schemaVersion: SCHEMA_VERSION, projects: [], entries: [], activities: [], timer: null, currentActivity: null, preferences: defaultPreferences(), sync: null };
}

export class WorkspaceError extends Error {}

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
/** The spans an entry's time is made of: its sittings when it was kept as a stretch, else the whole interval. */
export const intervals = (e: Interval & { sittings?: Interval[] }): Interval[] => (e.sittings && e.sittings.length ? e.sittings : [e]);
const spanSeconds = (a: Interval) => Math.max(0, (ms(a.endedAt) - ms(a.startedAt)) / 1000);
/** Seconds of work in an entry or activity: a stretch counts only its sittings, never the gaps between them. */
export const seconds = (a: Interval & { sittings?: Interval[] }) => intervals(a).reduce((sum, i) => sum + spanSeconds(i), 0);
/** The seconds of an entry that fall inside [start, end]. */
export const secondsWithin = (e: Interval & { sittings?: Interval[] }, start: number, end: number) =>
    intervals(e).reduce((sum, i) => sum + Math.max(0, Math.min(ms(i.endedAt), end) - Math.max(ms(i.startedAt), start)) / 1000, 0);

export function uuid(): string {
    return globalThis.crypto.randomUUID();
}

export function project(w: Workspace, id: string | null): Project | undefined {
    return id ? w.projects.find((p) => p.id === id) : undefined;
}

/**
 * Browsers belong to the Lawdie browser extension, which records the pages themselves;
 * the desktop app leaves them alone so that time is never counted twice. Matched like an
 * exclusion: bundle id on macOS, executable basename on Windows and Linux.
 */
export const BROWSER_OWNER_IDS = [
    // macOS
    "com.google.chrome", "com.google.chrome.beta", "com.google.chrome.dev", "com.google.chrome.canary", "org.chromium.chromium",
    "com.apple.safari", "com.apple.safaritechnologypreview", "com.microsoft.edgemac", "com.microsoft.edgemac.beta", "com.microsoft.edgemac.dev",
    "com.brave.browser", "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "company.thebrowser.browser", "com.operasoftware.opera",
    "com.vivaldi.vivaldi", "app.zen-browser.zen",
    // Windows and Linux
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe",
    "chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "firefox", "brave", "brave-browser", "microsoft-edge", "opera", "vivaldi",
];

const matchesOwner = (list: readonly string[], ownerID: string): boolean => {
    const lower = ownerID.toLowerCase();
    const base = lower.split(/[\\/]/).pop() ?? lower;
    return list.some((x) => { const xl = x.toLowerCase(); return xl === lower || xl === base; });
};

export const isBrowser = (ownerID: string): boolean => matchesOwner(BROWSER_OWNER_IDS, ownerID);

/** Excluded apps are matched by exact id, or by executable basename on Windows/Linux. */
export function isExcluded(prefs: Preferences, ownerID: string): boolean {
    return matchesOwner(prefs.excludedOwnerIDs, ownerID);
}

export function overlaps(w: Workspace, start: number, end: number, excluding: string | null = null): boolean {
    return (
        w.entries.some((e) => e.id !== excluding && intervals(e).some((i) => ms(i.startedAt) < end && ms(i.endedAt) > start)) ||
        (w.timer !== null && ms(w.timer.startedAt) < end)
    );
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

export function startTimer(w: Workspace, input: { description: string; projectID: string | null; billable: boolean }, now: number): void {
    if (w.timer) throw new WorkspaceError("Stop the current timer before starting another.");
    const text = input.description.trim();
    if (!text) throw new WorkspaceError("Add a description for this time entry.");
    if (input.projectID && !project(w, input.projectID)) throw new WorkspaceError("Choose an existing project.");
    w.timer = { description: text, projectID: input.projectID, startedAt: iso(now), lastHeartbeat: iso(now), billable: input.billable, hourlyRate: project(w, input.projectID)?.hourlyRate ?? 0 };
}

export function stopTimer(w: Workspace, at: number, source = "timer"): void {
    const running = w.timer;
    if (!running) return;
    w.timer = null;
    const end = Math.max(ms(running.startedAt), at);
    if (end - ms(running.startedAt) >= 1000) {
        w.entries.push({ id: uuid(), description: running.description, projectID: running.projectID, startedAt: running.startedAt, endedAt: iso(end), billable: running.billable, hourlyRate: running.hourlyRate, source, activityID: null });
    }
}

// ---------------------------------------------------------------------------
// Entries and review
// ---------------------------------------------------------------------------

export function saveEntry(w: Workspace, entry: TimeEntry, now: number): void {
    if (!entry.description.trim()) throw new WorkspaceError("Add a description.");
    const start = ms(entry.startedAt), end = ms(entry.endedAt);
    if (!(end > start) || end > now + 1000) throw new WorkspaceError("The end must be after the start and cannot be in the future.");
    if (!Number.isFinite(entry.hourlyRate) || entry.hourlyRate < 0) throw new WorkspaceError("Enter a valid hourly rate.");
    if (entry.projectID && !project(w, entry.projectID)) throw new WorkspaceError("Choose an existing project.");
    if (entry.sittings && !sittingsValid(entry)) throw new WorkspaceError("The sittings of this entry are out of order or outside its span.");
    if (intervals(entry).some((i) => overlaps(w, ms(i.startedAt), ms(i.endedAt), entry.id))) throw new WorkspaceError("This time overlaps another entry or the running timer. Adjust the times to avoid double counting.");
    const index = w.entries.findIndex((e) => e.id === entry.id);
    if (index >= 0) w.entries[index] = entry;
    else w.entries.push(entry);
}

/** Sittings inside the entry's span, in order, not overlapping one another. */
export function sittingsValid(e: TimeEntry): boolean {
    const list = e.sittings ?? [];
    return list.every((i, n) => validIso(i.startedAt) && validIso(i.endedAt) && ms(i.endedAt) > ms(i.startedAt)
        && ms(i.startedAt) >= ms(e.startedAt) && ms(i.endedAt) <= ms(e.endedAt) && (n === 0 || ms(i.startedAt) >= ms(list[n - 1].endedAt)));
}

/** Adjacent or touching spans become one. */
function mergeAdjacent(list: Interval[]): Interval[] {
    const out: Interval[] = [];
    for (const i of [...list].sort((a, b) => ms(a.startedAt) - ms(b.startedAt))) {
        const last = out[out.length - 1];
        if (last && ms(i.startedAt) <= ms(last.endedAt)) { if (ms(i.endedAt) > ms(last.endedAt)) last.endedAt = i.endedAt; }
        else out.push({ startedAt: i.startedAt, endedAt: i.endedAt });
    }
    return out;
}

export type KeepInput = {
    description: string;
    projectID: string | null;
    billable: boolean;
    /** The matter, by name, when projectID is null: the project of that name, made if there is none. */
    matter?: string | null;
    /** The description is the AI draft as offered, unedited. */
    drafted?: DraftSource;
    /** The span the person settled on before keeping, when they changed it. */
    startedAt?: string;
    endedAt?: string;
};

/** The parts of the sittings inside [start, end]. */
export function clipSittings(list: Interval[], start: number, end: number): Interval[] {
    return list
        .map((i) => ({ startedAt: iso(Math.max(ms(i.startedAt), start)), endedAt: iso(Math.min(ms(i.endedAt), end)) }))
        .filter((i) => ms(i.endedAt) > ms(i.startedAt));
}

/**
 * The entry a stretch would become for a span: one sitting takes the span as given (a
 * person may stretch it to when the work really started); several sittings are clipped
 * to it and only they count. Returns null when no captured time falls inside.
 */
export function stretchSpan(sittings: Interval[], start: number, end: number): { startedAt: string; endedAt: string; sittings?: Interval[] } | null {
    if (!(end > start)) return null;
    if (sittings.length <= 1) return { startedAt: iso(start), endedAt: iso(end) };
    const clipped = clipSittings(sittings, start, end);
    if (!clipped.length) return null;
    return clipped.length > 1 ? { startedAt: iso(start), endedAt: iso(end), sittings: clipped } : { startedAt: clipped[0].startedAt, endedAt: clipped[0].endedAt };
}

/**
 * Keep a stretch — one or more pending activities — as ONE entry. The entry spans the
 * first sitting's start to the last one's end (or the span the person set), but only the
 * sittings count as time and only they are held against overlap, so the minutes spent in
 * another document between two sittings stay free to be kept on their own.
 */
export function keepStretch(w: Workspace, activityIDs: string[], input: KeepInput, now: number): TimeEntry {
    const ids = [...new Set(activityIDs)];
    const picked = ids.map((id) => w.activities.find((a) => a.id === id));
    if (!ids.length || picked.some((a) => !a || a.disposition !== "pending")) throw new WorkspaceError("This activity has already been reviewed.");
    const merged = mergeAdjacent((picked as Activity[]).map((a) => ({ startedAt: a.startedAt, endedAt: a.endedAt })));
    const start = input.startedAt ? ms(input.startedAt) : ms(merged[0].startedAt);
    const end = input.endedAt ? ms(input.endedAt) : ms(merged[merged.length - 1].endedAt);
    if (!(end > start)) throw new WorkspaceError("The end must be after the start.");
    const span = stretchSpan(merged, start, end);
    if (!span) throw new WorkspaceError("No captured time falls between those times.");
    const matter = input.matter?.trim().slice(0, MATTER_MAX) || null;
    const projectID = input.projectID ?? (matter ? projectNamed(w, matter).id : null);
    const entry: TimeEntry = {
        id: uuid(), description: input.description.trim(), projectID, ...span,
        billable: input.billable, hourlyRate: project(w, projectID)?.hourlyRate ?? 0, source: "desktop", activityID: ids[0],
        ...(ids.length > 1 ? { activityIDs: ids } : {}),
        ...(input.drafted ? { drafted: input.drafted } : {}),
    };
    saveEntry(w, entry, now);
    for (const a of picked as Activity[]) {
        a.disposition = "kept";
        if (matter) { a.matter = matter; a.matterBy = "person"; }
    }
    return entry;
}

export const MATTER_MAX = 120;

/** The project a matter name stands for: an open one of that name (any case), else a new one. */
export function projectNamed(w: Workspace, name: string): Project {
    const key = name.trim().toLowerCase();
    const found = w.projects.find((p) => !p.archived && p.name.trim().toLowerCase() === key);
    if (found) return found;
    const made: Project = { id: uuid(), name: name.trim(), client: "", color: "gold", hourlyRate: 0, archived: false };
    w.projects.push(made);
    return made;
}

/** Activity named after a matter follows it when the matter is renamed or merged. */
function renameMatter(w: Workspace, from: string, to: string): void {
    const key = from.trim().toLowerCase();
    for (const a of w.activities) if (a.matter && a.matter.toLowerCase() === key) { a.matter = to; a.matterBy = "person"; }
}

/**
 * Change a matter's name, client or rate. The rate applies to time kept from now on:
 * entries keep the rate they were saved with. A new name must not be another open
 * matter's (merge them instead); activity named after the old one follows.
 */
export function updateProject(w: Workspace, id: string, change: { name?: string; client?: string; hourlyRate?: number }): void {
    const p = project(w, id);
    if (!p) throw new WorkspaceError("That matter no longer exists.");
    if (change.name !== undefined) {
        const name = change.name.trim().slice(0, MATTER_MAX);
        if (!name) throw new WorkspaceError("Give the matter a name.");
        if (w.projects.some((x) => x.id !== id && !x.archived && x.name.trim().toLowerCase() === name.toLowerCase())) throw new WorkspaceError(`There is already a matter called “${name}”. Merge them instead.`);
        if (name !== p.name) renameMatter(w, p.name, name);
        p.name = name;
    }
    if (change.client !== undefined) p.client = change.client.trim().slice(0, 200);
    if (change.hourlyRate !== undefined) {
        if (!Number.isFinite(change.hourlyRate) || change.hourlyRate < 0) throw new WorkspaceError("Enter a valid hourly rate.");
        p.hourlyRate = change.hourlyRate;
    }
}

/** One matter becomes another: its entries move (times and rates untouched), its activity takes the other's name, and it is gone. */
export function mergeProjects(w: Workspace, fromID: string, intoID: string): void {
    const from = project(w, fromID), into = project(w, intoID);
    if (!from || !into || fromID === intoID) throw new WorkspaceError("Choose two different matters to merge.");
    for (const e of w.entries) if (e.projectID === fromID) e.projectID = intoID;
    if (w.timer?.projectID === fromID) w.timer.projectID = intoID;
    renameMatter(w, from.name, into.name);
    w.projects = w.projects.filter((p) => p.id !== fromID);
}

export function archiveProject(w: Workspace, id: string, archived: boolean): void {
    const p = project(w, id);
    if (!p) throw new WorkspaceError("That matter no longer exists.");
    if (!archived && w.projects.some((x) => x.id !== id && !x.archived && x.name.trim().toLowerCase() === p.name.trim().toLowerCase())) throw new WorkspaceError(`There is already an open matter called “${p.name}”. Merge them instead.`);
    p.archived = archived;
}

/** The person names (or clears) the matter of pending activities. */
export function setMatter(w: Workspace, ids: string[], matter: string | null): void {
    const name = matter?.trim().slice(0, MATTER_MAX) || null;
    for (const a of w.activities) if (ids.includes(a.id) && a.disposition === "pending") { a.matter = name; a.matterBy = "person"; }
}

export function keepActivity(w: Workspace, id: string, input: KeepInput, now: number): TimeEntry {
    return keepStretch(w, [id], input, now);
}

export function dismissActivity(w: Workspace, id: string): void {
    dismissActivities(w, [id]);
}

export function dismissActivities(w: Workspace, ids: string[]): void {
    for (const a of w.activities) if (ids.includes(a.id) && a.disposition === "pending") a.disposition = "dismissed";
}

/** Removes an entry, reopens the activity it came from, and remembers the deletion for Kiwi. */
export function deleteEntry(w: Workspace, id: string): void {
    const entry = w.entries.find((e) => e.id === id);
    if (!entry) return;
    w.entries = w.entries.filter((e) => e.id !== id);
    const from = new Set([entry.activityID, ...(entry.activityIDs ?? [])]);
    for (const a of w.activities) if (from.has(a.id)) a.disposition = "pending";
    for (const t of w.sync?.targets ?? []) if (!t.deletedEntryIDs.includes(id)) t.deletedEntryIDs.push(id);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export type Observation = { app: string; ownerID: string; title: string | null; document?: DocumentInfo | null; screenText?: string | null; isSelf?: boolean } | null;

export const SCREEN_TEXT_MAX = 600;

/** On-screen text as stored: personal details redacted, one line per piece, repeats and blank lines dropped, bounded. */
export function cleanScreenText(raw: string | null | undefined): string | null {
    const lines: string[] = [];
    for (const line of (raw ?? "").replace(/\r\n?/g, "\n").split("\n")) {
        const t = redact(line.replace(/\s+/g, " ").trim());
        if (t && !lines.includes(t)) lines.push(t);
    }
    const text = lines.join("\n").slice(0, SCREEN_TEXT_MAX).trim();
    return text || null;
}

/** What a screen-text reader printed (src/main/screenText.ts): TEXT=… over any number of lines, or UNTRUSTED when macOS has not granted Accessibility. */
export function parseScreenText(output: string): { text: string | null; untrusted: boolean } {
    const text = output.replace(/\r\n?/g, "\n");
    if (/^UNTRUSTED\s*$/m.test(text)) return { text: null, untrusted: true };
    const at = text.indexOf("TEXT=");
    return { text: at < 0 ? null : cleanScreenText(text.slice(at + 5)), untrusted: false };
}

// ---------------------------------------------------------------------------
// Redaction: personal details are removed on this computer, before anything is stored
// ---------------------------------------------------------------------------

const luhn = (digits: string): boolean => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
    }
    return sum % 10 === 0;
};

/**
 * Text read from a window or a document with personal details taken out: card numbers
 * (Luhn-checked), anything labelled as a card code, password, PIN, token or account,
 * social security numbers, phone numbers, long digit runs, and the person part of email
 * addresses (the domain stays: it often names the client). Case numbers ("1:26-cv-01182"),
 * matter numbers ("2026-144"), dates and amounts are kept, since they name the work.
 */
export function redact(text: string): string {
    return text
        // Labelled secrets; the label stays so a reader knows something was there. A card
        // code needs its 3–4 digits, the rest a ":" or "=" ("pin the memo" is not a PIN).
        .replace(/\b(cvc|cvv2?|cid|security code|card code)(\s*[:#=-]?\s*)\d{3,4}\b/gi, "$1$2[redacted]")
        .replace(/\b(pin|passcode|password|passwd|pwd|api key|secret|token|account (?:number|no\.?|#)|acct(?: no\.?| #)?|routing(?: number| no\.?)?|iban|sort code)(\s*[:#=]\s*)\S+/gi, "$1$2[redacted]")
        // Card numbers: 13–19 digits, spaced or dashed, that pass the Luhn check.
        .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[card]" : m))
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
        // Bare runs of eleven or more digits (account, policy, reference numbers); ten is a phone.
        .replace(/\b\d{11,}\b/g, "[number]")
        // Phone numbers: ten or more digits written as one ((555) 123-4567, +1 555 123 4567).
        .replace(/(?<![\w:/-])\+?\(?\d[\d ().-]{8,}\d(?![\w-])/g, (m) => (m.replace(/\D/g, "").length >= 10 && !/^\d{4}-\d{2}-\d{2}/.test(m) ? "[phone]" : m))
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
        .replace(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, "[email]@$1");
}

/** A document as stored: bounded, whitespace collapsed, empty fields null. */
export function cleanDocument(raw: DocumentInfo | null | undefined): DocumentInfo | null {
    if (!raw) return null;
    const name = raw.name?.trim().slice(0, 300);
    if (!name) return null;
    const path = raw.path?.trim().slice(0, 1000) || null;
    const excerpt = raw.excerpt ? redact(raw.excerpt.replace(/\s+/g, " ").trim()).slice(0, EXCERPT_MAX) || null : null;
    return { name, path, excerpt };
}

const sameDocument = (a: DocumentInfo | null | undefined, b: DocumentInfo | null | undefined) =>
    (a?.name ?? null) === (b?.name ?? null) && (a?.path ?? null) === (b?.path ?? null);

/** One sample of the foreground. Bounds are wall-clock timestamps; no interval spans an unobserved gap. */
export function observe(w: Workspace, foreground: Observation, now: number, idleSeconds: number, suspended = false): void {
    const idle = idleSeconds >= w.preferences.idleMinutes * 60;
    if (suspended || idle) {
        const cutoff = idle ? now - idleSeconds * 1000 : now;
        closeActivity(w, cutoff, suspended ? "suspended" : "idle");
        stopTimer(w, cutoff, suspended ? "timer-suspended" : "timer-idle");
        return;
    }
    if (w.timer) {
        if (now - ms(w.timer.lastHeartbeat) > GAP_SECONDS * 1000) stopTimer(w, ms(w.timer.lastHeartbeat), "timer-recovered");
        else w.timer.lastHeartbeat = iso(now);
    }
    if (!w.preferences.captureEnabled || !foreground) {
        closeActivity(w, now, "paused");
        return;
    }
    // Switching to this app is a switch like any other; only a private app is "excluded".
    if (foreground.isSelf || foreground.ownerID === APP_ID) {
        closeActivity(w, now, "switched");
        return;
    }
    if (isExcluded(w.preferences, foreground.ownerID)) {
        closeActivity(w, now, "excluded");
        return;
    }
    // Checked before anything about the window is used, as an exclusion is.
    if (isBrowser(foreground.ownerID)) {
        closeActivity(w, now, "browser");
        return;
    }
    const safeTitle = w.preferences.captureTitles ? foreground.title : null;
    const document = w.preferences.captureDocuments ? cleanDocument(foreground.document) : null;
    const screenText = w.preferences.captureScreenText ? cleanScreenText(foreground.screenText) : null;
    const current = w.currentActivity;
    if (current) {
        const lastSeen = ms(current.endedAt);
        if (now - lastSeen > GAP_SECONDS * 1000 || now < lastSeen) closeActivity(w, lastSeen, "gap");
        else if (current.ownerID !== foreground.ownerID || current.title !== safeTitle) closeActivity(w, now, "switched");
        // A different document in the same app is different work. A segment that only now
        // learns its document keeps going, and a probe that failed this once (null) does not
        // end a segment that already knows its document.
        else if (document && current.document && !sameDocument(current.document, document)) closeActivity(w, now, "switched");
    }
    if (!w.currentActivity) {
        w.currentActivity = { id: uuid(), app: foreground.app, ownerID: foreground.ownerID, title: safeTitle, document, ...(screenText ? { screenText } : {}), startedAt: iso(now), endedAt: iso(now), endedBy: "switched", disposition: "pending" };
    } else {
        w.currentActivity.endedAt = iso(now);
        if (document) w.currentActivity.document = document;
        // The first text read stands for the segment: scrolling is not other work.
        if (screenText && !w.currentActivity.screenText) w.currentActivity.screenText = screenText;
    }
}

export function closeActivity(w: Workspace, at: number, reason: string): void {
    const current = w.currentActivity;
    if (!current) return;
    w.currentActivity = null;
    const end = Math.max(ms(current.startedAt), Math.min(at, ms(current.endedAt) + 15_000));
    const closed: Activity = { ...current, endedAt: iso(end), endedBy: reason };
    if (seconds(closed) >= MIN_ACTIVITY_SECONDS) w.activities.push(closed);
}

/** After a crash: the timer ends at its last heartbeat, the segment at its last observation. Never across the downtime. */
export function recover(w: Workspace, now: number): void {
    if (w.timer) stopTimer(w, ms(w.timer.lastHeartbeat), "timer-recovered");
    if (w.currentActivity) closeActivity(w, ms(w.currentActivity.endedAt), "crash-recovered");
    prune(w, now);
}

export function prune(w: Workspace, now: number): void {
    const cutoff = now - w.preferences.retentionDays * 86_400_000;
    w.activities = w.activities.filter((a) => ms(a.endedAt) >= cutoff);
}

/** Seconds of kept time inside [start, end), clipped. */
export function secondsBetween(w: Workspace, start: number, end: number, billableOnly = false): number {
    return w.entries.filter((e) => !billableOnly || e.billable).reduce((sum, e) => sum + secondsWithin(e, start, end), 0);
}

// ---------------------------------------------------------------------------
// Stretches: how the inbox groups sittings for review
// ---------------------------------------------------------------------------

/** Sittings on the same document at most this far apart are one stretch. */
export const STRETCH_GAP_MS = 15 * 60_000;
/** A stretch shorter than this is an app hop, not work; it is offered only in bulk. */
export const NOISE_SECONDS = 60;

export type Stretch = {
    /** The first sitting's id; stable while the stretch is pending. */
    id: string;
    app: string;
    ownerID: string;
    /** The document, else the window title, else the app. */
    name: string;
    document: DocumentInfo | null;
    activityIDs: string[];
    startedAt: string;
    endedAt: string;
    /** Only the sittings' time. */
    seconds: number;
    sittings: number;
    endedBy: string;
    /** The first AI draft among its sittings. */
    draft: Draft | null;
};

const stretchKey = (a: Activity): string => `${a.ownerID}\n${a.document?.name ?? a.title ?? ""}`;
const localDayOf = (isoText: string): string => { const d = new Date(isoText); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/**
 * Pending activities as stretches: consecutive sittings in the same app on the same
 * document (or title), on the same day, with gaps under STRETCH_GAP_MS, become one — even
 * with other documents' sittings in between, which is how real work goes. Stretches under
 * NOISE_SECONDS are returned apart, to be dismissed in one go. Newest first.
 */
export function stretchesOf(activities: readonly Activity[], gapMs = STRETCH_GAP_MS, noiseSeconds = NOISE_SECONDS): { stretches: Stretch[]; short: Stretch[] } {
    const pending = activities.filter((a) => a.disposition === "pending").sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
    const open = new Map<string, Stretch>();
    const all: Stretch[] = [];
    for (const a of pending) {
        const key = stretchKey(a);
        const last = open.get(key);
        if (last && ms(a.startedAt) - ms(last.endedAt) <= gapMs && localDayOf(a.startedAt) === localDayOf(last.startedAt)) {
            last.activityIDs.push(a.id);
            last.endedAt = a.endedAt;
            last.seconds += spanSeconds(a);
            last.sittings += 1;
            last.endedBy = a.endedBy;
            last.draft ??= a.draft ?? null;
            continue;
        }
        const fresh: Stretch = { id: a.id, app: a.app, ownerID: a.ownerID, name: a.document?.name ?? a.title ?? a.app, document: a.document ?? null, activityIDs: [a.id], startedAt: a.startedAt, endedAt: a.endedAt, seconds: spanSeconds(a), sittings: 1, endedBy: a.endedBy, draft: a.draft ?? null };
        open.set(key, fresh);
        all.push(fresh);
    }
    all.sort((x, y) => ms(y.startedAt) - ms(x.startedAt));
    return { stretches: all.filter((st) => st.seconds >= noiseSeconds), short: all.filter((st) => st.seconds < noiseSeconds) };
}

// ---------------------------------------------------------------------------
// Kiwi sync — the wire contract (kiwi/backend/src/lib/desktopTime.ts is the other half)
// ---------------------------------------------------------------------------

export const SYNC_MAX_ITEMS = 500;

/** The machine's IANA zone, or null where Intl cannot say. */
export function localTimeZone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

export type SyncRequest = {
    app_version: string;
    /** This computer's IANA zone, so Kiwi dates drafts made from kept entries on the day they happened. */
    time_zone: string | null;
    activities: { id: string; app: string; bundle_id: string; title: string | null; document_name: string | null; document_path: string | null; excerpt: string | null; started_at: string; ended_at: string; seconds: number; ended_by: string; disposition: string }[];
    entries: { id: string; description: string; project_name: string | null; client_name: string | null; started_at: string; ended_at: string; seconds: number; billable: boolean; hourly_rate: number; source: string; activity_id: string | null }[];
    deleted_entry_ids: string[];
};

/** Everything a destination should know: closed segments within retention, every kept entry, the deletions it has not acknowledged. */
export function syncRequest(w: Workspace, appVersion: string, timeZone: string | null = localTimeZone(), target: SyncTarget | null = w.sync?.targets[0] ?? null): SyncRequest {
    return {
        app_version: appVersion,
        time_zone: timeZone,
        activities: w.activities.map((a) => ({ id: a.id, app: a.app, bundle_id: a.ownerID, title: a.title, document_name: a.document?.name ?? null, document_path: a.document?.path ?? null, excerpt: a.document?.excerpt ?? null, started_at: a.startedAt, ended_at: a.endedAt, seconds: Math.round(seconds(a)), ended_by: a.endedBy, disposition: a.disposition })),
        entries: w.entries.map((e) => {
            const p = project(w, e.projectID);
            return { id: e.id, description: e.description, project_name: p?.name ?? null, client_name: p?.client || null, started_at: e.startedAt, ended_at: e.endedAt, seconds: Math.round(seconds(e)), billable: e.billable, hourly_rate: e.hourlyRate, source: e.source, activity_id: e.activityID };
        }),
        deleted_entry_ids: target?.deletedEntryIDs ?? [],
    };
}

/** Requests Kiwi will accept, in order; deletions travel with the first. */
export function syncBatches(request: SyncRequest, maxItems = SYNC_MAX_ITEMS): SyncRequest[] {
    const count = Math.max(1, Math.ceil(Math.max(request.activities.length, request.entries.length, request.deleted_entry_ids.length) / maxItems));
    return Array.from({ length: count }, (_, i) => ({
        app_version: request.app_version,
        time_zone: request.time_zone,
        activities: request.activities.slice(i * maxItems, (i + 1) * maxItems),
        entries: request.entries.slice(i * maxItems, (i + 1) * maxItems),
        deleted_entry_ids: request.deleted_entry_ids.slice(i * maxItems, (i + 1) * maxItems),
    }));
}

/** One product answered: its outbox shrinks by what it acknowledged. Without `product`, every target. */
export function markSynced(w: Workspace, at: number, acknowledgedDeletions: string[], product: Product | null = null): void {
    for (const t of w.sync?.targets ?? []) {
        if (product && t.product !== product) continue;
        t.deletedEntryIDs = t.deletedEntryIDs.filter((id) => !acknowledgedDeletions.includes(id));
        t.lastSyncedAt = iso(at);
        t.lastError = null;
    }
}

/** The 0.4.x shape (one product, flat) or the current one, as the current one; anything else as given. */
export function normalizeSync(raw: unknown): SyncState | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.targets)) return r as unknown as SyncState;
    const target: SyncTarget = {
        product: isProduct(r.destination) ? r.destination : "kiwi",
        serverURL: String(r.serverURL ?? ""),
        deviceID: String(r.deviceID ?? ""),
        deviceName: String(r.deviceName ?? ""),
        accountEmail: (r.accountEmail as string | undefined) ?? null,
        lastSyncedAt: (r.lastSyncedAt as string | undefined) ?? null,
        lastError: (r.lastError as string | undefined) ?? null,
        deletedEntryIDs: Array.isArray(r.deletedEntryIDs) ? (r.deletedEntryIDs as string[]) : [],
    };
    return { targets: [target], autoSync: r.autoSync !== false };
}

// ---------------------------------------------------------------------------
// Files: validation and the migration from the Swift app's format
// ---------------------------------------------------------------------------

const DISPOSITIONS = new Set(["pending", "kept", "dismissed"]);
const validIso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Throws on anything that would make the engine misbehave; a corrupt file is preserved, never repaired. */
export function validate(w: Workspace): Workspace {
    const p = w.preferences;
    const ok =
        w.schemaVersion === SCHEMA_VERSION &&
        Array.isArray(w.projects) && Array.isArray(w.entries) && Array.isArray(w.activities) &&
        p && p.idleMinutes >= 1 && p.idleMinutes <= 60 && p.retentionDays >= 1 && p.retentionDays <= 365 && Array.isArray(p.excludedOwnerIDs) &&
        new Set(w.entries.map((e) => e.id)).size === w.entries.length &&
        new Set(w.projects.map((x) => x.id)).size === w.projects.length &&
        new Set(w.activities.map((a) => a.id)).size === w.activities.length &&
        w.projects.every((x) => Number.isFinite(x.hourlyRate) && x.hourlyRate >= 0 && insightValid(x.insight)) &&
        w.entries.every((e) => validIso(e.startedAt) && validIso(e.endedAt) && ms(e.endedAt) > ms(e.startedAt) && Number.isFinite(e.hourlyRate) && e.hourlyRate >= 0 && (e.sittings == null || (Array.isArray(e.sittings) && sittingsValid(e))) && (e.activityIDs == null || Array.isArray(e.activityIDs)) && (e.drafted == null || e.drafted === "kiwi" || e.drafted === "sample")) &&
        w.activities.every((a) => validIso(a.startedAt) && validIso(a.endedAt) && ms(a.endedAt) >= ms(a.startedAt) && DISPOSITIONS.has(a.disposition) && (a.matter == null || (typeof a.matter === "string" && a.matter.length <= MATTER_MAX)) && (a.matterBy == null || a.matterBy === "ai" || a.matterBy === "person") && draftValid(a.draft) && (a.screenText == null || (typeof a.screenText === "string" && a.screenText.length <= SCREEN_TEXT_MAX)) && (a.document == null || (typeof a.document.name === "string" && a.document.name.length > 0 && (a.document.excerpt ?? "").length <= EXCERPT_MAX))) &&
        (!w.timer || (validIso(w.timer.startedAt) && validIso(w.timer.lastHeartbeat) && ms(w.timer.lastHeartbeat) >= ms(w.timer.startedAt))) &&
        (!w.sync || (Array.isArray(w.sync.targets) && w.sync.targets.length > 0 && new Set(w.sync.targets.map((t) => t.product)).size === w.sync.targets.length &&
            w.sync.targets.every((t) => isProduct(t.product) && typeof t.serverURL === "string" && t.serverURL.length > 0 && typeof t.deviceID === "string" && t.deviceID.length > 0 && Array.isArray(t.deletedEntryIDs))));
    if (!ok) throw new WorkspaceError("The workspace contains invalid data. Restore a known-good backup.");
    return w;
}

/** Foundation's Codable dates: seconds since 2001-01-01 UTC. */
const REFERENCE_EPOCH_MS = 978_307_200_000;
const fromReference = (n: unknown): string => iso(REFERENCE_EPOCH_MS + Number(n) * 1000);

/** A workspace.json written by the Swift app (schemaVersion 1) as this app reads it. */
export function migrateV1(raw: Record<string, unknown>): Workspace {
    type Any = Record<string, unknown>;
    const arr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);
    const prefs = (raw.preferences ?? {}) as Any;
    const timer = raw.timer as Any | undefined;
    const current = raw.currentActivity as Any | undefined;
    const sync = raw.sync as Any | undefined;
    const activity = (a: Any): Activity => ({ id: String(a.id), app: String(a.app ?? ""), ownerID: String(a.bundleID ?? ""), title: (a.title as string | undefined) ?? null, startedAt: fromReference(a.startedAt), endedAt: fromReference(a.endedAt), endedBy: String(a.endedBy ?? "switched"), disposition: (a.disposition as Activity["disposition"]) ?? "pending" });
    return {
        schemaVersion: SCHEMA_VERSION,
        projects: arr(raw.projects).map((p) => ({ id: String(p.id), name: String(p.name ?? ""), client: String(p.client ?? ""), color: String(p.color ?? "gold"), hourlyRate: Number(p.hourlyRate ?? 0), archived: p.archived === true })),
        entries: arr(raw.entries).map((e) => ({ id: String(e.id), description: String(e.description ?? ""), projectID: (e.projectID as string | undefined) ?? null, startedAt: fromReference(e.startedAt), endedAt: fromReference(e.endedAt), billable: e.billable === true, hourlyRate: Number(e.hourlyRate ?? 0), source: String(e.source ?? "manual"), activityID: (e.activityID as string | undefined) ?? null })),
        activities: arr(raw.activities).map(activity),
        timer: timer ? { description: String(timer.description ?? ""), projectID: (timer.projectID as string | undefined) ?? null, startedAt: fromReference(timer.startedAt), lastHeartbeat: fromReference(timer.lastHeartbeat), billable: timer.billable === true, hourlyRate: Number(timer.hourlyRate ?? 0) } : null,
        currentActivity: current ? activity(current) : null,
        preferences: { captureEnabled: prefs.captureEnabled === true, captureTitles: prefs.captureTitles === true, captureDocuments: false, captureScreenText: false, suggestMatters: false, idleMinutes: Number(prefs.idleMinutes ?? 3), retentionDays: Number(prefs.retentionDays ?? 14), excludedOwnerIDs: Array.isArray(prefs.excludedBundleIDs) ? (prefs.excludedBundleIDs as string[]) : [...DEFAULT_EXCLUSIONS] },
        sync: sync ? normalizeSync({ serverURL: sync.serverURL, deviceID: sync.deviceID, deviceName: sync.deviceName, accountEmail: sync.accountEmail ?? null, autoSync: sync.autoSync !== false, lastSyncedAt: sync.lastSyncedAt != null ? fromReference(sync.lastSyncedAt) : null, lastError: sync.lastError ?? null, deletedEntryIDs: sync.deletedEntryIDs }) : null,
    };
}

/** Parse a workspace file's JSON, whichever app wrote it. */
export function parseWorkspace(text: string): Workspace {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.schemaVersion === 1) return validate(migrateV1(raw));
    if (raw.schemaVersion !== SCHEMA_VERSION) throw new WorkspaceError("This workspace was created by a newer Time Capture version. Update Time Capture before opening it.");
    const w = raw as unknown as Workspace;
    w.preferences = { ...defaultPreferences(), ...(w.preferences ?? {}) };
    w.sync = normalizeSync(w.sync);
    w.timer ??= null;
    w.currentActivity ??= null;
    return validate(w);
}
