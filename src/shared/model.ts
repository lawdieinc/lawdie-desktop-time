import { isDestination, type Destination } from "./kiwi";
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
};

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
};

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
    startedAt: string;
    endedAt: string;
    endedBy: string;
    disposition: "pending" | "kept" | "dismissed";
};

export type Preferences = {
    captureEnabled: boolean;
    captureTitles: boolean;
    /** Ask Word, Excel, PowerPoint and Outlook what is open: name, path, a text excerpt. */
    captureDocuments: boolean;
    idleMinutes: number;
    retentionDays: number;
    excludedOwnerIDs: string[];
};

export type SyncState = {
    /** Kiwi or Lawdie CRM; workspaces written before the CRM was a destination read as Kiwi. */
    destination: Destination;
    serverURL: string;
    deviceID: string;
    deviceName: string;
    accountEmail: string | null;
    autoSync: boolean;
    lastSyncedAt: string | null;
    lastError: string | null;
    deletedEntryIDs: string[];
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
    return { captureEnabled: false, captureTitles: false, captureDocuments: false, idleMinutes: 3, retentionDays: 14, excludedOwnerIDs: [...DEFAULT_EXCLUSIONS] };
}

export function emptyWorkspace(): Workspace {
    return { schemaVersion: SCHEMA_VERSION, projects: [], entries: [], activities: [], timer: null, currentActivity: null, preferences: defaultPreferences(), sync: null };
}

export class WorkspaceError extends Error {}

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
export const seconds = (a: { startedAt: string; endedAt: string }) => Math.max(0, (ms(a.endedAt) - ms(a.startedAt)) / 1000);

export function uuid(): string {
    return globalThis.crypto.randomUUID();
}

export function project(w: Workspace, id: string | null): Project | undefined {
    return id ? w.projects.find((p) => p.id === id) : undefined;
}

/** Excluded apps are matched by exact id, or by executable basename on Windows/Linux. */
export function isExcluded(prefs: Preferences, ownerID: string): boolean {
    const lower = ownerID.toLowerCase();
    const base = lower.split(/[\\/]/).pop() ?? lower;
    return prefs.excludedOwnerIDs.some((x) => {
        const xl = x.toLowerCase();
        return xl === lower || xl === base;
    });
}

export function overlaps(w: Workspace, start: number, end: number, excluding: string | null = null): boolean {
    return (
        w.entries.some((e) => e.id !== excluding && ms(e.startedAt) < end && ms(e.endedAt) > start) ||
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
    if (overlaps(w, start, end, entry.id)) throw new WorkspaceError("This time overlaps another entry or the running timer. Adjust the times to avoid double counting.");
    const index = w.entries.findIndex((e) => e.id === entry.id);
    if (index >= 0) w.entries[index] = entry;
    else w.entries.push(entry);
}

export function keepActivity(w: Workspace, id: string, input: { description: string; projectID: string | null; billable: boolean }, now: number): TimeEntry {
    const activity = w.activities.find((a) => a.id === id);
    if (!activity || activity.disposition !== "pending") throw new WorkspaceError("This activity has already been reviewed.");
    const entry: TimeEntry = { id: uuid(), description: input.description.trim(), projectID: input.projectID, startedAt: activity.startedAt, endedAt: activity.endedAt, billable: input.billable, hourlyRate: project(w, input.projectID)?.hourlyRate ?? 0, source: "desktop", activityID: id };
    saveEntry(w, entry, now);
    activity.disposition = "kept";
    return entry;
}

export function dismissActivity(w: Workspace, id: string): void {
    const activity = w.activities.find((a) => a.id === id);
    if (activity && activity.disposition === "pending") activity.disposition = "dismissed";
}

/** Removes an entry, reopens the activity it came from, and remembers the deletion for Kiwi. */
export function deleteEntry(w: Workspace, id: string): void {
    const entry = w.entries.find((e) => e.id === id);
    if (!entry) return;
    w.entries = w.entries.filter((e) => e.id !== id);
    const activity = w.activities.find((a) => a.id === entry.activityID);
    if (activity) activity.disposition = "pending";
    if (w.sync && !w.sync.deletedEntryIDs.includes(id)) w.sync.deletedEntryIDs.push(id);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export type Observation = { app: string; ownerID: string; title: string | null; document?: DocumentInfo | null; isSelf?: boolean } | null;

/** A document as stored: bounded, whitespace collapsed, empty fields null. */
export function cleanDocument(raw: DocumentInfo | null | undefined): DocumentInfo | null {
    if (!raw) return null;
    const name = raw.name?.trim().slice(0, 300);
    if (!name) return null;
    const path = raw.path?.trim().slice(0, 1000) || null;
    const excerpt = raw.excerpt?.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX) || null;
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
    const safeTitle = w.preferences.captureTitles ? foreground.title : null;
    const document = w.preferences.captureDocuments ? cleanDocument(foreground.document) : null;
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
        w.currentActivity = { id: uuid(), app: foreground.app, ownerID: foreground.ownerID, title: safeTitle, document, startedAt: iso(now), endedAt: iso(now), endedBy: "switched", disposition: "pending" };
    } else {
        w.currentActivity.endedAt = iso(now);
        if (document) w.currentActivity.document = document;
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
    return w.entries.filter((e) => !billableOnly || e.billable).reduce((sum, e) => sum + Math.max(0, Math.min(ms(e.endedAt), end) - Math.max(ms(e.startedAt), start)) / 1000, 0);
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

/** Everything Kiwi should know: closed segments within retention, every kept entry, unacknowledged deletions. */
export function syncRequest(w: Workspace, appVersion: string, timeZone: string | null = localTimeZone()): SyncRequest {
    return {
        app_version: appVersion,
        time_zone: timeZone,
        activities: w.activities.map((a) => ({ id: a.id, app: a.app, bundle_id: a.ownerID, title: a.title, document_name: a.document?.name ?? null, document_path: a.document?.path ?? null, excerpt: a.document?.excerpt ?? null, started_at: a.startedAt, ended_at: a.endedAt, seconds: Math.round(seconds(a)), ended_by: a.endedBy, disposition: a.disposition })),
        entries: w.entries.map((e) => {
            const p = project(w, e.projectID);
            return { id: e.id, description: e.description, project_name: p?.name ?? null, client_name: p?.client || null, started_at: e.startedAt, ended_at: e.endedAt, seconds: Math.round(seconds(e)), billable: e.billable, hourly_rate: e.hourlyRate, source: e.source, activity_id: e.activityID };
        }),
        deleted_entry_ids: w.sync?.deletedEntryIDs ?? [],
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

export function markSynced(w: Workspace, at: number, acknowledgedDeletions: string[]): void {
    if (!w.sync) return;
    w.sync.deletedEntryIDs = w.sync.deletedEntryIDs.filter((id) => !acknowledgedDeletions.includes(id));
    w.sync.lastSyncedAt = iso(at);
    w.sync.lastError = null;
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
        w.projects.every((x) => Number.isFinite(x.hourlyRate) && x.hourlyRate >= 0) &&
        w.entries.every((e) => validIso(e.startedAt) && validIso(e.endedAt) && ms(e.endedAt) > ms(e.startedAt) && Number.isFinite(e.hourlyRate) && e.hourlyRate >= 0) &&
        w.activities.every((a) => validIso(a.startedAt) && validIso(a.endedAt) && ms(a.endedAt) >= ms(a.startedAt) && DISPOSITIONS.has(a.disposition) && (a.document == null || (typeof a.document.name === "string" && a.document.name.length > 0 && (a.document.excerpt ?? "").length <= EXCERPT_MAX))) &&
        (!w.timer || (validIso(w.timer.startedAt) && validIso(w.timer.lastHeartbeat) && ms(w.timer.lastHeartbeat) >= ms(w.timer.startedAt))) &&
        (!w.sync || (isDestination(w.sync.destination) && typeof w.sync.serverURL === "string" && w.sync.serverURL.length > 0 && typeof w.sync.deviceID === "string" && w.sync.deviceID.length > 0));
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
        preferences: { captureEnabled: prefs.captureEnabled === true, captureTitles: prefs.captureTitles === true, captureDocuments: false, idleMinutes: Number(prefs.idleMinutes ?? 3), retentionDays: Number(prefs.retentionDays ?? 14), excludedOwnerIDs: Array.isArray(prefs.excludedBundleIDs) ? (prefs.excludedBundleIDs as string[]) : [...DEFAULT_EXCLUSIONS] },
        sync: sync ? { destination: isDestination(sync.destination) ? sync.destination : "kiwi", serverURL: String(sync.serverURL ?? ""), deviceID: String(sync.deviceID ?? ""), deviceName: String(sync.deviceName ?? ""), accountEmail: (sync.accountEmail as string | undefined) ?? null, autoSync: sync.autoSync !== false, lastSyncedAt: sync.lastSyncedAt != null ? fromReference(sync.lastSyncedAt) : null, lastError: (sync.lastError as string | undefined) ?? null, deletedEntryIDs: Array.isArray(sync.deletedEntryIDs) ? (sync.deletedEntryIDs as string[]) : [] } : null,
    };
}

/** Parse a workspace file's JSON, whichever app wrote it. */
export function parseWorkspace(text: string): Workspace {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.schemaVersion === 1) return validate(migrateV1(raw));
    if (raw.schemaVersion !== SCHEMA_VERSION) throw new WorkspaceError("This workspace was created by a newer Time Capture version. Update Time Capture before opening it.");
    const w = raw as unknown as Workspace;
    w.preferences = { ...defaultPreferences(), ...(w.preferences ?? {}) };
    w.sync ??= null;
    // A file written before the CRM was a destination (0.4.x) synced to Kiwi.
    if (w.sync && !isDestination(w.sync.destination)) w.sync.destination = "kiwi";
    w.timer ??= null;
    w.currentActivity ??= null;
    return validate(w);
}
