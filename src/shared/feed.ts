/** Imported evidence, durable receipts and matter links. No IO or Electron. */
import { WorkspaceError, clipSittings, intervals, isPersonal, projectNamed, uuid, type Activity, type Interval, type Project, type Workspace } from "./model";

export type SourceKind = "browser" | "chat" | "email";
export type SourceRef = { kind: SourceKind; id: string; account: string; intervals: Interval[] };
export type KiwiMatter = { id: string; name: string; cm_number: string | null };
export type FeedRow = { id: string; kind: SourceKind; app: string; title: string | null; url?: string; started_at: string; ended_at: string; seconds: number; kiwi_project_id: string | null };
export type FeedPage = { account_id: string; rows: FeedRow[]; matters: KiwiMatter[]; next: string | null };
export type JoinProposal = { local_id: string; kiwi_project_id: string; confidence: "high" | "medium" | "low" | "unknown"; reason: string; status?: "declined" | "joined"; before?: Project; after?: string; activityBefore?: { id: string; matter: Activity["matter"]; projectID?: string; kiwiProjectID?: string }[] };
export type FeedState = {
    workspaceID: string;
    account: string;
    matters: KiwiMatter[];
    /** Minimal receipts outlive raw evidence so a replay cannot resurrect reviewed time. */
    receipts: Record<string, { activityID: string; endedAt: string; disposition: "pending" | "dismissed" | "personal" | "expired" | "overlap" | "kept" }>;
    joins: JoinProposal[];
    lastImportedAt: string | null;
};
const date = (s: string) => Date.parse(s);
const keyOf = (kind: string, id: string) => `${kind}:${id}`;
const clean = (s: string) => s.trim().toLowerCase();
export const accountOf = (server: string, id: string): string => `${server.replace(/\/+$/, "")}#${id}`;
export function ensureFeed(w: Workspace, account: string): FeedState {
    if (w.feed && w.feed.account !== account) throw new WorkspaceError("This workspace contains imports from another Kiwi account. Use a separate workspace for that account.");
    return w.feed ??= { workspaceID: uuid(), account, matters: [], receipts: {}, joins: [], lastImportedAt: null };
}

export function parseFeedPage(raw: unknown, now: number): FeedPage {
    const f = raw as FeedPage;
    if (!f || typeof f.account_id !== "string" || !Array.isArray(f.rows) || f.rows.length > 500 || !Array.isArray(f.matters) || f.matters.length > 10000 || !(f.next === null || typeof f.next === "string")) throw new WorkspaceError("Kiwi sent an invalid import page.");
    for (const r of f.rows) {
        const start = date(r.started_at), end = date(r.ended_at);
        if (!r || typeof r.id !== "string" || !r.id || r.id.length > 200 || !["browser", "chat", "email"].includes(r.kind) || typeof r.app !== "string" || !(r.title === null || typeof r.title === "string") || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now + 60_000 || end - start > 86400_000 || !Number.isFinite(r.seconds) || r.seconds <= 0 || Math.abs(r.seconds - (end - start) / 1000) > 2 || !(r.kiwi_project_id === null || typeof r.kiwi_project_id === "string")) throw new WorkspaceError("Kiwi sent an invalid activity interval.");
    }
    for (const m of f.matters) if (!m || typeof m.id !== "string" || typeof m.name !== "string" || !m.name.trim() || !(m.cm_number === null || typeof m.cm_number === "string")) throw new WorkspaceError("Kiwi sent an invalid matter list.");
    return f;
}

/** Subtract a union of occupied intervals, including holes in saved entries. */
export function subtractIntervals(source: Interval[], occupied: Interval[]): Interval[] {
    let result = source.map((i) => ({ ...i }));
    for (const cut of occupied) {
        const c = date(cut.startedAt), d = date(cut.endedAt);
        result = result.flatMap((i) => {
            const a = date(i.startedAt), b = date(i.endedAt);
            if (d <= a || c >= b) return [i];
            return [...(a < c ? [{ startedAt: i.startedAt, endedAt: new Date(c).toISOString() }] : []), ...(d < b ? [{ startedAt: new Date(d).toISOString(), endedAt: i.endedAt }] : [])];
        });
    }
    return result.filter((i) => date(i.endedAt) - date(i.startedAt) >= 1000);
}
/**
 * What is left of each pending imported row once this computer's own time, kept time, the segment in progress and a
 * running timer are taken out, and earlier imports before later ones. Changes nothing: `clipImported` applies it,
 * and Approve (src/shared/keep.ts) asks it whether a row is still whole.
 */
export function importedRemaining(w: Workspace, now: number): Map<string, Interval[]> {
    // A calendar row is what was planned, not what this computer saw: it never clips imported time; the two sit side by side for review.
    const occupied = [...w.activities.filter((a) => !a.origin && !a.ownerID.startsWith("calendar:")).flatMap(intervals), ...w.entries.flatMap(intervals), ...(w.currentActivity ? intervals(w.currentActivity) : []), ...(w.timer ? [{ startedAt: w.timer.startedAt, endedAt: new Date(now).toISOString() }] : [])];
    // Existing reviewed evidence takes precedence; new imports are deterministic by time and source.
    const imported = w.activities.filter((a) => a.origin && a.disposition === "pending").sort((a, b) => date(a.startedAt) - date(b.startedAt) || (a.originRef ?? "").localeCompare(b.originRef ?? ""));
    const out = new Map<string, Interval[]>();
    for (const a of imported) {
        const remaining = subtractIntervals(intervals(a), occupied);
        out.set(a.id, remaining);
        occupied.push(...remaining);
    }
    return out;
}
const totalSeconds = (list: Interval[]): number => list.reduce((n, i) => n + (date(i.endedAt) - date(i.startedAt)) / 1000, 0);
/** Whether other time has covered any of these imported rows since they were last clipped: keeping them would keep less than the row shows. */
export function importedCovered(w: Workspace, ids: readonly string[], now: number): boolean {
    const mine = w.activities.filter((a) => ids.includes(a.id) && a.origin && a.disposition === "pending");
    if (!mine.length) return false;
    const remaining = importedRemaining(w, now);
    return mine.some((a) => totalSeconds(remaining.get(a.id) ?? []) < totalSeconds(intervals(a)) - 0.5);
}
export function clipImported(w: Workspace, now: number): void {
    const byID = new Map(w.activities.map((a) => [a.id, a]));
    for (const [id, remaining] of importedRemaining(w, now)) {
        const a = byID.get(id)!;
        a.sittings = remaining;
        if (!remaining.length) {
            a.disposition = "dismissed";
            const receipt = w.feed?.receipts[keyOf(a.sourceKind!, a.originRef!)];
            if (receipt) receipt.disposition = "overlap";
        } else {
            a.startedAt = remaining[0].startedAt; a.endedAt = remaining[remaining.length - 1].endedAt;
        }
    }
}
export function prepareImportedKeep(w: Workspace, ids: string[], now: number): void {
    if (!w.activities.some((a) => ids.includes(a.id) && a.origin)) return;
    clipImported(w, now);
    if (w.activities.some((a) => ids.includes(a.id) && a.origin && a.disposition !== "pending")) throw new WorkspaceError("This imported time is covered by other activity. Refresh the inbox before keeping it.");
}

/** Exact IDs are authoritative; ambiguous names/numbers/aliases never choose arbitrarily. */
export function matchingProject(w: Workspace, matter: KiwiMatter): Project | undefined {
    const available = w.projects.filter((p) => !p.archived && (!p.kiwiAccount || p.kiwiAccount === w.feed?.account));
    const exact = available.filter((p) => p.kiwiProjectID === matter.id);
    if (exact.length) return exact.length === 1 ? exact[0] : undefined;
    for (const match of [(p: Project) => !!matter.cm_number && p.matterNumber === matter.cm_number, (p: Project) => clean(p.name) === clean(matter.name), (p: Project) => p.aliases?.some((a) => clean(a) === clean(matter.name))]) {
        const hits = available.filter(match);
        if (hits.length) return hits.length === 1 && !hits[0].kiwiProjectID ? hits[0] : undefined;
    }
    return undefined;
}
export function importFeed(w: Workspace, page: FeedPage, now: number): number {
    const f = w.feed;
    if (!f) throw new WorkspaceError("Connect Kiwi before importing.");
    f.matters = page.matters;
    let count = 0;
    for (const r of page.rows) {
        const key = keyOf(r.kind, r.id);
        if (f.receipts[key]) continue;
        const id = uuid();
        f.receipts[key] = { activityID: id, endedAt: r.ended_at, disposition: "pending" };
        if (date(r.ended_at) < now - w.preferences.retentionDays * 86400_000) { f.receipts[key].disposition = "expired"; continue; }
        const remote = f.matters.find((m) => m.id === r.kiwi_project_id);
        const local = remote ? matchingProject(w, remote) : undefined;
        if (local && remote) { local.kiwiProjectID = remote.id; local.kiwiAccount = f.account; if (!local.matterNumber && remote.cm_number) local.matterNumber = remote.cm_number; }
        const a: Activity = { id, origin: r.kind === "browser" ? "browser" : "kiwi", sourceKind: r.kind, originRef: r.id, originAccount: f.account, app: r.app.slice(0, 200), ownerID: `import:${r.kind}`, title: r.title?.slice(0, 500) ?? null, startedAt: r.started_at, endedAt: r.ended_at, endedBy: "imported", disposition: "pending", ...(r.url ? { url: r.url.split(/[?#]/)[0].slice(0, 1000) } : {}), ...(remote ? { matter: local?.name ?? remote.name.slice(0, 120), kiwiProjectID: remote.id, ...(local ? { projectID: local.id } : {}) } : {}) };
        w.activities.push(a); count++;
    }
    clipImported(w, now);
    refreshReceipts(w);
    f.lastImportedAt = new Date(now).toISOString();
    return count;
}
export function refreshReceipts(w: Workspace): void {
    if (!w.feed) return;
    const byID = new Map(w.activities.map((a) => [a.id, a]));
    const kept = new Set(w.entries.flatMap((e) => e.sourceRefs ?? []).map((r) => keyOf(r.kind, r.id)));
    for (const [key, r] of Object.entries(w.feed.receipts)) {
        const a = byID.get(r.activityID);
        if (kept.has(key)) r.disposition = "kept";
        else if (a && isPersonal(a.matter)) r.disposition = "personal";
        else if (a && r.disposition !== "overlap") r.disposition = a.disposition;
        else if (!a && r.disposition === "pending") r.disposition = "expired";
    }
}

export function joinRequest(w: Workspace) {
    if (!w.feed?.matters.length) return null;
    const local = w.projects.filter((p) => !p.archived && !p.kiwiProjectID && !isPersonal(p.name)).map((p) => ({ id: p.id, name: p.name, aliases: p.aliases ?? [] }));
    for (const a of w.activities) if (a.disposition === "pending" && a.matter && !isPersonal(a.matter) && !a.kiwiProjectID && !local.some((p) => clean(p.name) === clean(a.matter!))) local.push({ id: `name:${a.matter}`, name: a.matter, aliases: [] });
    const ask = local.filter((p) => !w.feed!.joins.some((j) => j.local_id === p.id)).slice(0, 100);
    return ask.length ? { local_matters: ask, kiwi_matters: w.feed.matters, examples: w.feed.joins.filter((j) => j.status).map((j) => ({ local_id: j.local_id, kiwi_project_id: j.kiwi_project_id, decision: j.status })).slice(-40) } : null;
}
export function applyJoins(w: Workspace, request: NonNullable<ReturnType<typeof joinRequest>>, raw: unknown): void {
    const list = (raw as { joins?: unknown })?.joins;
    if (!w.feed || !Array.isArray(list)) return;
    for (const item of list as JoinProposal[]) {
        const local = request.local_matters.find((p) => p.id === item?.local_id);
        const remote = w.feed.matters.find((m) => m.id === item?.kiwi_project_id);
        if (!local || !remote || isPersonal(remote.name) || w.feed.joins.some((j) => j.local_id === local.id)) continue;
        const j: JoinProposal = { local_id: local.id, kiwi_project_id: remote.id, confidence: ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "unknown", reason: typeof item.reason === "string" ? item.reason.slice(0, 500) : "" };
        w.feed.joins.push(j);
        const current = w.projects.find((p) => p.id === local.id);
        if (j.confidence === "high" && (!current || current.name === local.name) && !w.projects.some((p) => p.kiwiProjectID === remote.id || (clean(p.name) === clean(remote.name) && p.id !== current?.id))) joinMatter(w, j.local_id, remote.id);
    }
}
export function joinMatter(w: Workspace, localID: string, remoteID: string): void {
    const f = w.feed, remote = f?.matters.find((m) => m.id === remoteID);
    if (!f || !remote || isPersonal(remote.name)) throw new WorkspaceError("Choose an available Kiwi matter.");
    let p = w.projects.find((p) => p.id === localID);
    const name = p?.name ?? (localID.startsWith("name:") ? localID.slice(5) : "");
    if (!name || isPersonal(name)) throw new WorkspaceError("That local matter no longer exists.");
    const existing = w.projects.find((x) => x.kiwiProjectID === remoteID && x.kiwiAccount === f.account && x.id !== p?.id);
    if (existing) throw new WorkspaceError("This Kiwi matter is already linked. Merge the local matters first.");
    p ??= projectNamed(w, name);
    if (p.kiwiProjectID && p.kiwiProjectID !== remoteID) throw new WorkspaceError("This matter is already linked to a different Kiwi matter.");
    let j = f.joins.find((j) => j.local_id === localID && !j.status);
    if (!j) { j = { local_id: localID, kiwi_project_id: remoteID, confidence: "unknown", reason: "Joined by you" }; f.joins.push(j); }
    j.kiwi_project_id = remoteID;
    j.before = structuredClone(p);
    j.activityBefore = [];
    const person = p.nameBy === "person" || (!p.nameBy && w.activities.some((a) => a.matter === name && a.matterBy === "person"));
    if (!person && !w.projects.some((other) => other.id !== p.id && clean(other.name) === clean(remote.name))) { p.aliases = [...new Set([...(p.aliases ?? []), p.name])]; p.name = remote.name.slice(0, 120); p.nameBy = "kiwi"; }
    p.kiwiProjectID = remote.id; p.kiwiAccount = f.account;
    // Kiwi's number fills an empty field; a number the person typed stays.
    if (!p.matterNumber && remote.cm_number) p.matterNumber = remote.cm_number;
    for (const a of w.activities) if ((a.projectID === p.id || (!a.kiwiProjectID && clean(a.matter ?? "") === clean(name)) || a.kiwiProjectID === remote.id) && !isPersonal(a.matter)) {
        j.activityBefore.push({ id: a.id, matter: a.matter, projectID: a.projectID, kiwiProjectID: a.kiwiProjectID });
        if (a.matterBy !== "person") a.matter = p.name;
        a.projectID = p.id; a.kiwiProjectID = remote.id;
    }
    j.status = "joined"; j.after = JSON.stringify(p);
}
export function undoJoin(w: Workspace, localID: string): void {
    const j = w.feed?.joins.find((j) => j.local_id === localID && j.status === "joined");
    const p = j?.before && w.projects.find((p) => p.id === j.before!.id);
    if (!j?.before || !p || JSON.stringify(p) !== j.after) throw new WorkspaceError("This matter has changed since the join. Review its link before undoing.");
    Object.keys(p).forEach((k) => delete (p as unknown as Record<string, unknown>)[k]); Object.assign(p, j.before);
    for (const before of j.activityBefore ?? []) {
        const a = w.activities.find((a) => a.id === before.id);
        if (a?.kiwiProjectID === j.kiwi_project_id && a.matterBy !== "person") { a.matter = before.matter; a.projectID = before.projectID; a.kiwiProjectID = before.kiwiProjectID; }
    }
    j.status = "declined"; delete j.before; delete j.after; delete j.activityBefore;
}
export function validateFeedState(w: Workspace): void {
    if (w.preferences.importKiwiTime !== undefined && typeof w.preferences.importKiwiTime !== "boolean") throw new WorkspaceError("Invalid import preference.");
    const f = w.feed;
    if (f && (typeof f.workspaceID !== "string" || typeof f.account !== "string" || !Array.isArray(f.matters) || !Array.isArray(f.joins) || !f.receipts || typeof f.receipts !== "object")) throw new WorkspaceError("Invalid Kiwi import state.");
    for (const a of w.activities ?? []) if (a.origin && (!f || a.originAccount !== f.account || !a.originRef || !["browser", "chat", "email"].includes(a.sourceKind ?? "") || (a.sittings && a.sittings.some((i) => !(date(i.endedAt) > date(i.startedAt)))))) throw new WorkspaceError("Invalid imported activity.");
    for (const e of w.entries ?? []) if (e.sourceRefs && (!Array.isArray(e.sourceRefs) || e.sourceRefs.some((r) => !f || r.account !== f.account || !r.id || !["browser", "chat", "email"].includes(r.kind) || !Array.isArray(r.intervals)))) throw new WorkspaceError("Invalid imported source references.");
}
