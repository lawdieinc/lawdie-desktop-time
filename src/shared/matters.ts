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

import { MATTER_MAX, stretchesOf, type Activity, type Draft, type Stretch, type Workspace } from "./model";

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

/**
 * Pending activity as the inbox shows it: one group per matter per day (newest first),
 * however short its sittings, since four seconds on the right matter is still that
 * matter's time; everything without a matter as stretches, as before.
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
    const groups = [...byKey.values()].sort((x, y) => ms(y.startedAt) - ms(x.startedAt));
    for (const g of groups) g.documents.sort((x, y) => y.seconds - x.seconds);
    return { groups, ...stretchesOf(rest) };
}

/** What the inbox asks a person to review: matter groups and the stretches outside them. */
export const toReview = (activities: readonly Activity[]): number => { const i = inboxOf(activities); return i.groups.length + i.stretches.length; };
