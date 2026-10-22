/* Matters: what a person was working on, named by a model from what capture saw, so the
   inbox reviews a matter's day — Outlook, Word and Acrobat together — instead of one row
   per document per app. Kiwi asks its server-side model (POST /desktop-time/matters,
   kiwi/backend/src/lib/desktopMatters.ts holds the prompt) over the device token, so no
   one enters a key. Pure: what is sent, the answer's validation and the grouping live
   here and are tested; the call is src/main/matters.ts.

   The app owns the name. A destination (Kiwi, the CRM) gets it as the kept entry's
   project and decides which of its own matters that is. Only closed, pending activity
   that has something to read (a title or a document) is ever sent; never the segment in
   progress, never kept or dismissed time. A person's answer is never overwritten. */

import { duration } from "./format";
import { DRAFT_MAX, INSIGHT_MAX, MATTER_MAX, NOISE_SECONDS, project, seconds as entrySeconds, stretchesOf, type Activity, type Draft, type Stretch, type Workspace } from "./model";

/** Activities per request (Kiwi's limit); the rest wait for the next round. */
export const MATTER_BATCH = 150;
/** Corrections shown to the model as examples of how this person names matters. */
export const MATTER_EXAMPLES = 40;

const ms = (iso: string) => Date.parse(iso);
const spanSeconds = (a: { startedAt: string; endedAt: string }) => Math.max(0, (ms(a.endedAt) - ms(a.startedAt)) / 1000);
const localDayOf = (isoText: string): string => { const d = new Date(isoText); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const readable = (a: Activity) => !!(a.title || a.document || a.screenText);

/** Pending activities never asked about, with something to read (title, document or on-screen text), oldest first. */
export function unnamed(w: Workspace): Activity[] {
    return w.activities.filter((a) => a.disposition === "pending" && a.matter === undefined && readable(a)).sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
}

/** Matter names already in use: open projects and names on activity, so the model reuses them exactly. */
export function knownMatters(w: Workspace): string[] {
    const names = new Map<string, string>();
    for (const p of w.projects) if (!p.archived && p.name.trim()) names.set(p.name.trim().toLowerCase(), p.name.trim());
    for (const a of w.activities) if (a.matter) names.set(a.matter.toLowerCase(), names.get(a.matter.toLowerCase()) ?? a.matter);
    return [...names.values()].sort((a, b) => a.localeCompare(b));
}

const describe = (a: Activity) => ({
    app: a.app,
    title: a.title,
    document: a.document?.name ?? null,
    path: a.document?.path ?? null,
    excerpt: a.document?.excerpt ?? null,
    screen_text: a.screenText ?? null,
});

/** The wire body of POST /desktop-time/matters; cleanMattersBody() in Kiwi is the other half. */
export type MattersBody = {
    activities: (ReturnType<typeof describe> & { id: string; started_at: string; seconds: number })[];
    known_matters: string[];
    examples: (ReturnType<typeof describe> & { matter: string | null })[];
};
export type MatterRequest = { ids: string[]; body: MattersBody };

/** The next batch to ask about, or null when there is nothing to ask. */
export function matterRequest(w: Workspace, batch = MATTER_BATCH): MatterRequest | null {
    const ask = unnamed(w).slice(0, batch);
    if (!ask.length) return null;
    const examples = w.activities
        .filter((a) => a.matterBy === "person" && readable(a))
        .sort((a, b) => ms(b.endedAt) - ms(a.endedAt))
        .slice(0, MATTER_EXAMPLES)
        .map((a) => ({ ...describe(a), matter: a.matter ?? null }));
    const activities = ask.map((a) => ({ id: a.id, ...describe(a), started_at: a.startedAt, seconds: Math.round(spanSeconds(a)) }));
    return { ids: ask.map((a) => a.id), body: { known_matters: knownMatters(w), examples, activities } };
}

/**
 * Apply the model's answer to the activities it was asked about. An answer without an
 * assignments list changes nothing (they are asked again next round); a malformed item is
 * ignored; an id it was not asked about, or one a person has named meanwhile, is left
 * alone. Every other asked id ends up answered (null when the model skipped it), so
 * nothing is asked twice. Returns how many got a name.
 */
export function applyMatters(w: Workspace, askedIDs: string[], answer: unknown): number {
    const asked = new Set(askedIDs);
    const given = new Map<string, string | null>();
    const list = (answer as { assignments?: unknown } | null)?.assignments;
    if (!Array.isArray(list)) return 0;
    for (const item of list) {
        const id = (item as { activity_id?: unknown })?.activity_id;
        const raw = (item as { matter?: unknown })?.matter;
        if (typeof id !== "string" || !asked.has(id)) continue;
        const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MATTER_MAX) : "";
        given.set(id, name || null);
    }
    // One spelling per matter: a name that differs from a known one only in case takes the known one.
    const canonical = new Map(knownMatters(w).map((n) => [n.toLowerCase(), n]));
    let named = 0;
    for (const a of w.activities) {
        if (!asked.has(a.id) || a.matterBy === "person" || a.disposition !== "pending") continue;
        const name = given.get(a.id) ?? null;
        a.matter = name ? canonical.get(name.toLowerCase()) ?? name : null;
        a.matterBy = "ai";
        if (a.matter) named += 1;
    }
    return named;
}

// ---------------------------------------------------------------------------
// The inbox: a matter's day as one row
// ---------------------------------------------------------------------------

export type MatterDocument = { name: string; app: string; activityIDs: string[]; seconds: number };

export type MatterGroup = {
    /** Stable while pending: the day and the matter. */
    id: string;
    matter: string;
    activityIDs: string[];
    startedAt: string;
    endedAt: string;
    seconds: number;
    sittings: number;
    apps: string[];
    /** What was open, most time first. */
    documents: MatterDocument[];
    /** The first AI draft among its sittings. */
    draft: Draft | null;
};

/** A matter's day as a stretch: for the keep sheet, and for a day too short to be its own row. */
export const matterStretch = (g: MatterGroup): Stretch => ({ id: g.id, app: g.apps.join(", "), ownerID: "", name: g.matter, document: null, activityIDs: g.activityIDs, startedAt: g.startedAt, endedAt: g.endedAt, seconds: g.seconds, sittings: g.sittings, endedBy: "", draft: g.draft });

/**
 * Pending activity as the inbox shows it: one group per matter per day (newest first),
 * however short its sittings, since four seconds on the right matter is still that
 * matter's time; everything without a matter as stretches, as before. A matter whose
 * whole day is under NOISE_SECONDS is a brief touch, not billable time, and goes with the
 * short hops (2026-10-22: "sub-minute entries are not useful for billing").
 */
export function inboxOf(activities: readonly Activity[]): { groups: MatterGroup[]; stretches: Stretch[]; short: Stretch[] } {
    const pending = activities.filter((a) => a.disposition === "pending").sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
    const byKey = new Map<string, MatterGroup>();
    const rest: Activity[] = [];
    for (const a of pending) {
        if (!a.matter) { rest.push(a); continue; }
        const key = `${localDayOf(a.startedAt)}\n${a.matter.toLowerCase()}`;
        let g = byKey.get(key);
        if (!g) {
            g = { id: `${a.id}:matter`, matter: a.matter, activityIDs: [], startedAt: a.startedAt, endedAt: a.endedAt, seconds: 0, sittings: 0, apps: [], documents: [], draft: null };
            byKey.set(key, g);
        }
        g.activityIDs.push(a.id);
        g.endedAt = a.endedAt;
        g.seconds += spanSeconds(a);
        g.sittings += 1;
        g.draft ??= a.draft ?? null;
        if (!g.apps.includes(a.app)) g.apps.push(a.app);
        const name = a.document?.name ?? a.title ?? a.app;
        let doc = g.documents.find((d) => d.name === name && d.app === a.app);
        if (!doc) { doc = { name, app: a.app, activityIDs: [], seconds: 0 }; g.documents.push(doc); }
        doc.activityIDs.push(a.id);
        doc.seconds += spanSeconds(a);
    }
    const all = [...byKey.values()].sort((x, y) => ms(y.startedAt) - ms(x.startedAt));
    for (const g of all) g.documents.sort((x, y) => y.seconds - x.seconds);
    const { stretches, short } = stretchesOf(rest);
    const brief = all.filter((g) => g.seconds < NOISE_SECONDS).map(matterStretch);
    return { groups: all.filter((g) => g.seconds >= NOISE_SECONDS), stretches, short: [...brief, ...short].sort((x, y) => ms(y.startedAt) - ms(x.startedAt)) };
}

/** What the inbox asks a person to review: matter groups and the stretches outside them. */
export const toReview = (activities: readonly Activity[]): number => { const i = inboxOf(activities); return i.groups.length + i.stretches.length; };

// ---------------------------------------------------------------------------
// Drafts: a billing description for each row waiting in review
// (POST /desktop-time/drafts; kiwi/backend/src/lib/desktopDrafts.ts is the other half)
// ---------------------------------------------------------------------------

/** Rows per request, and a row's activities sent at most. */
export const DRAFT_BATCH = 30;
const DRAFT_ACTIVITIES = 60;
const DRAFT_EXAMPLES = 20;

/** One row of the review inbox: a matter's day, or a stretch outside any matter. Its id is its first activity's. */
export type ReviewRow = { id: string; matter: string | null; activityIDs: string[]; seconds: number };

export type DraftsBody = {
    groups: { id: string; matter: string | null; seconds: number; activities: (ReturnType<typeof describe> & { seconds: number })[] }[];
    examples: { matter: string | null; description: string }[];
};

/** Every row the inbox shows (short hops aside), as the drafts request sees them. */
export function reviewRows(activities: readonly Activity[]): ReviewRow[] {
    const { groups, stretches } = inboxOf(activities);
    return [
        ...groups.map((g) => ({ id: g.activityIDs[0], matter: g.matter, activityIDs: g.activityIDs, seconds: g.seconds })),
        ...stretches.map((st) => ({ id: st.activityIDs[0], matter: null, activityIDs: st.activityIDs, seconds: st.seconds })),
    ];
}

/**
 * The rows that need a draft: something to read, and more than a quarter of their time
 * not yet covered by one (a row that grew since it was drafted is drafted again whole).
 * `skip` holds "id:sittings" for rows already asked this session and not answered.
 * Examples are the descriptions the person wrote themselves, so drafts follow their wording.
 */
export function draftRequest(w: Workspace, skip: ReadonlySet<string> = new Set()): { rows: ReviewRow[]; body: DraftsBody } | null {
    const byID = new Map(w.activities.map((a) => [a.id, a]));
    const need = reviewRows(w.activities).filter((r) => {
        const acts = r.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a);
        const undrafted = acts.filter((a) => !a.draft).reduce((n, a) => n + spanSeconds(a), 0);
        return !skip.has(`${r.id}:${r.activityIDs.length}`) && undrafted > r.seconds * 0.25 && acts.some(readable);
    }).slice(0, DRAFT_BATCH);
    if (!need.length) return null;
    const groups = need.map((r) => ({
        id: r.id, matter: r.matter, seconds: Math.round(r.seconds),
        activities: r.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a && readable(a)).slice(0, DRAFT_ACTIVITIES).map((a) => ({ ...describe(a), seconds: Math.round(spanSeconds(a)) })),
    }));
    const examples = w.entries
        .filter((e) => !e.drafted && e.source === "desktop" && e.description.trim())
        .sort((a, b) => ms(b.endedAt) - ms(a.endedAt))
        .slice(0, DRAFT_EXAMPLES)
        .map((e) => ({ matter: project(w, e.projectID)?.name ?? null, description: e.description }));
    return { rows: need, body: { groups, examples } };
}

/** Each answered row's draft onto its open sittings. Returns how many rows got one. */
export function applyDrafts(w: Workspace, rows: readonly ReviewRow[], answer: unknown): number {
    const list = (answer as { drafts?: unknown } | null)?.drafts;
    if (!Array.isArray(list)) return 0;
    const byRow = new Map(rows.map((r) => [r.id, r]));
    let drafted = 0;
    for (const item of list as { id?: unknown; text?: unknown }[]) {
        const row = typeof item?.id === "string" ? byRow.get(item.id) : undefined;
        const text = typeof item?.text === "string" ? item.text.replace(/\s+/g, " ").trim().slice(0, DRAFT_MAX) : "";
        if (!row || !text) continue;
        const ids = new Set(row.activityIDs);
        for (const a of w.activities) if (ids.has(a.id) && a.disposition === "pending") a.draft = { text, source: "kiwi" };
        drafted += 1;
    }
    return drafted;
}

// ---------------------------------------------------------------------------
// Insights: what a model makes of a matter's recent time, for the matter's page
// (POST /desktop-time/insights; kiwi/backend/src/lib/desktopInsights.ts is the other half)
// ---------------------------------------------------------------------------

export const INSIGHT_BATCH = 10;
/** An insight is asked again only when the matter's time changed, and not within the hour. */
export const INSIGHT_MIN_AGE_MS = 60 * 60_000;
const INSIGHT_DAYS = 30;

export type InsightsBody = {
    matters: {
        id: string; name: string; client: string | null; hourly_rate: number;
        /** Worked out here, so the model quotes figures rather than computing them. */
        totals: { kept: string; billable: string; value: string; waiting: string };
        entries: { day: string; description: string; seconds: number; billable: boolean; hourly_rate: number }[];
        waiting: { day: string; seconds: number; apps: string[]; documents: string[]; draft: string | null }[];
    }[];
};

const isoDay = (isoText: string): string => { const d = new Date(isoText); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/**
 * The open matters whose insight is missing or stale: time kept on them in the last 30
 * days or waiting in review, changed since the insight was written, which is over an hour
 * old. A sample insight is never replaced. `skip` holds matters asked this session and not answered.
 */
export function insightRequest(w: Workspace, now: number, skip: ReadonlySet<string> = new Set()): InsightsBody | null {
    const since = now - INSIGHT_DAYS * 86_400_000;
    const { groups } = inboxOf(w.activities);
    const matters: InsightsBody["matters"] = [];
    for (const p of w.projects) {
        if (p.archived || skip.has(p.id) || p.insight?.source === "sample") continue;
        const entries = w.entries.filter((e) => e.projectID === p.id && ms(e.endedAt) >= since).sort((a, b) => ms(b.startedAt) - ms(a.startedAt)).slice(0, 60);
        const waiting = groups.filter((g) => g.matter.toLowerCase() === p.name.trim().toLowerCase()).slice(0, 20);
        if (!entries.length && !waiting.length) continue;
        const changed = Math.max(...entries.map((e) => ms(e.endedAt)), ...waiting.map((g) => ms(g.endedAt)));
        if (p.insight && (changed <= ms(p.insight.generatedAt) || now - ms(p.insight.generatedAt) < INSIGHT_MIN_AGE_MS)) continue;
        const kept = entries.reduce((n, e) => n + entrySeconds(e), 0);
        const billable = entries.filter((e) => e.billable).reduce((n, e) => n + entrySeconds(e), 0);
        const value = entries.filter((e) => e.billable).reduce((n, e) => n + (entrySeconds(e) / 3600) * e.hourlyRate, 0);
        matters.push({
            id: p.id, name: p.name, client: p.client || null, hourly_rate: p.hourlyRate,
            totals: { kept: duration(kept), billable: duration(billable), value: `$${Math.round(value).toLocaleString("en-US")}`, waiting: duration(waiting.reduce((n, g) => n + g.seconds, 0)) },
            entries: entries.map((e) => ({ day: isoDay(e.startedAt), description: e.description, seconds: Math.round(entrySeconds(e)), billable: e.billable, hourly_rate: e.hourlyRate })),
            waiting: waiting.map((g) => ({ day: isoDay(g.startedAt), seconds: Math.round(g.seconds), apps: g.apps, documents: g.documents.slice(0, 10).map((d) => d.name), draft: g.draft?.text ?? null })),
        });
        if (matters.length >= INSIGHT_BATCH) break;
    }
    return matters.length ? { matters } : null;
}

/** Each answered matter's insight, bounded, stamped now. Returns how many matters got one. */
export function applyInsights(w: Workspace, answer: unknown, now: number): number {
    const list = (answer as { insights?: unknown } | null)?.insights;
    if (!Array.isArray(list)) return 0;
    let count = 0;
    for (const item of list as { id?: unknown; summary?: unknown; points?: unknown }[]) {
        const p = typeof item?.id === "string" ? project(w, item.id) : undefined;
        const summary = typeof item?.summary === "string" ? item.summary.trim().slice(0, INSIGHT_MAX) : "";
        if (!p || !summary || p.insight?.source === "sample") continue;
        const points = (Array.isArray(item.points) ? item.points : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 500)).slice(0, 12);
        p.insight = { summary, points, generatedAt: new Date(now).toISOString(), source: "kiwi" };
        count += 1;
    }
    return count;
}