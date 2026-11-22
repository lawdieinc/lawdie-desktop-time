/* Sitting summaries (2026-11-12, "just some AI summary from what you captured for that
   sitting"): one line per sitting saying what the work was, written by Kiwi's model
   (POST /desktop-time/summaries; kiwi/backend/src/lib/desktopSummaries.ts holds the prompt)
   from what capture saw and, when screenshots are on, up to three screenshots spread across it (2026-11-22; one before). Part of the AI
   suggestions round (src/main/matters.ts), so only with "AI suggestions" on and this computer
   connected to Kiwi. Pure: what is sent and how the answer is applied live here and are
   tested; the main process reads and shrinks the screenshot.

   A sitting is summarised once: it is closed, so what capture saw of it never changes.
   Never the segment in progress, never reviewed or Personal time, never one under a minute.
   A screenshot goes only with a sitting of an app that may be pictured at all (never a
   browser, an excluded app or a call): the ones nearest a sixth, a half and five sixths of the way through it.
   The summary stays on this computer: it is shown on the item, feeds the row's draft and the
   matter's name, and becomes evidence at keep; it is never synced. */

import { callApp } from "./calls";
import { describe, readable } from "./matters";
import { MANUAL_OWNER_ID, SUMMARY_MAX, intervals, isBrowser, isExcluded, isPersonal, redact, screenshotTime, seconds, type Activity, type Workspace } from "./model";

/** Sittings per request (Kiwi's limit), and screenshots among them. */
export const SUMMARY_BATCH = 40;
export const SUMMARY_IMAGES = 20;
/** Screenshots of one sitting the model may see, spread across it. */
export const SUMMARY_SHOTS_PER_SITTING = 3;
/** A sitting shorter than this is a hop, not work worth a line. */
export const SUMMARY_MIN_SECONDS = 60;

const ms = (iso: string) => Date.parse(iso);

/** May a screenshot of this sitting be read by the model? Not of a browser, an excluded app or a call. */
export const pictureAllowed = (w: Workspace, a: Activity): boolean =>
    !a.origin && !a.ownerID.startsWith("calendar:") && !isBrowser(a.ownerID) && !isExcluded(w.preferences, a.ownerID) && !callApp(a.ownerID);

/** The screenshot nearest the middle of the sitting, when screenshots are on and it may be read. */
export function summaryShot(w: Workspace, a: Activity): string | null {
    const shots = a.screenshots ?? [];
    if (w.preferences.captureScreenshots !== true || !shots.length || !pictureAllowed(w, a)) return null;
    const spans = intervals(a);
    const middle = (ms(spans[0].startedAt) + ms(spans[spans.length - 1].endedAt)) / 2;
    return [...shots].sort((x, y) => Math.abs(screenshotTime(x) - middle) - Math.abs(screenshotTime(y) - middle))[0];
}

/** Up to `max` screenshots spread across the sitting, in time order, when screenshots are on and it may be read. */
export function summaryShots(w: Workspace, a: Activity, max = SUMMARY_SHOTS_PER_SITTING): string[] {
    const shots = [...(a.screenshots ?? [])].sort((x, y) => screenshotTime(x) - screenshotTime(y));
    if (w.preferences.captureScreenshots !== true || !shots.length || !pictureAllowed(w, a)) return [];
    if (shots.length <= max) return shots;
    const spans = intervals(a);
    const from = ms(spans[0].startedAt), to = ms(spans[spans.length - 1].endedAt);
    const picked: string[] = [];
    for (let k = 0; k < max; k++) {
        const aim = from + ((2 * k + 1) / (2 * max)) * (to - from);
        const near = shots.filter((x) => !picked.includes(x)).sort((x, y) => Math.abs(screenshotTime(x) - aim) - Math.abs(screenshotTime(y) - aim))[0];
        if (near) picked.push(near);
    }
    return picked.sort((x, y) => screenshotTime(x) - screenshotTime(y));
}

/** Sittings that need a summary, newest first (what the person is about to review gets its line first; a backlog after an update follows): pending, not Personal, a minute or more, with text to read or a screenshot. */
export function unsummarised(w: Workspace, skip: ReadonlySet<string> = new Set()): Activity[] {
    return w.activities
        .filter((a) => a.disposition === "pending" && a.ownerID !== MANUAL_OWNER_ID && !a.summary && !skip.has(a.id) && !isPersonal(a.matter ?? null) && seconds(a) >= SUMMARY_MIN_SECONDS && (readable(a) || !!summaryShot(w, a)))
        .sort((a, b) => ms(b.startedAt) - ms(a.startedAt));
}

/**
 * The wire body of POST /desktop-time/summaries; cleanSummariesBody() in Kiwi is the other half. The main process fills
 * `images` (each screenshot made small) and `image`, the first of them, for a Kiwi from before `images`.
 */
export type SummariesBody = {
    sittings: (Omit<ReturnType<typeof describe>, "summary"> & { id: string; started_at: string; seconds: number; matter: string | null; image?: string; images?: string[] })[];
};
/** The request, and the screenshot files to send with each sitting that has some (the main process reads them). */
export type SummaryRequest = { ids: string[]; shots: Record<string, string[]>; body: SummariesBody };

/** The next batch to ask about, or null when there is nothing to ask. `skip` holds sittings asked this session and not answered. */
export function summaryRequest(w: Workspace, skip: ReadonlySet<string> = new Set(), batch = SUMMARY_BATCH): SummaryRequest | null {
    const ask = unsummarised(w, skip).slice(0, batch);
    if (!ask.length) return null;
    const shots: Record<string, string[]> = {};
    let pictures = 0;
    for (const a of ask) {
        const room = SUMMARY_IMAGES - pictures;
        if (room <= 0) break;
        const some = summaryShots(w, a, Math.min(SUMMARY_SHOTS_PER_SITTING, room));
        if (!some.length) continue;
        shots[a.id] = some;
        pictures += some.length;
    }
    const sittings = ask.map((a) => {
        const { summary: _, ...d } = describe(a);
        return { id: a.id, ...d, started_at: a.startedAt, seconds: Math.round(seconds(a)), matter: a.matter && !isPersonal(a.matter) ? a.matter : null };
    });
    return { ids: ask.map((a) => a.id), shots, body: { sittings } };
}

/**
 * The model's summaries onto the sittings asked about. A malformed item, an id not asked, or
 * a sitting reviewed meanwhile is skipped; personal details are redacted here as well. A sitting
 * sent with a screenshot records it. Returns the ids that got one.
 */
export function applySummaries(w: Workspace, request: Pick<SummaryRequest, "ids" | "shots">, answer: unknown): string[] {
    const list = (answer as { summaries?: unknown } | null)?.summaries;
    if (!Array.isArray(list)) return [];
    const asked = new Set(request.ids);
    const given = new Map<string, string>();
    for (const item of list as { id?: unknown; text?: unknown }[]) {
        const id = item?.id;
        const text = typeof item?.text === "string" ? redact(item.text.replace(/\s+/g, " ").trim()).replace(/\.$/, "").slice(0, SUMMARY_MAX) : "";
        if (typeof id !== "string" || !asked.has(id) || !text || given.has(id)) continue;
        given.set(id, text);
    }
    const done: string[] = [];
    for (const a of w.activities) {
        const text = given.get(a.id);
        if (!text || a.disposition !== "pending") continue;
        a.summary = { text, source: "kiwi", ...(request.shots[a.id]?.length ? { screenshot: true as const } : {}) };
        done.push(a.id);
    }
    return done;
}

/** The lines an item of several sittings shows (in matters.ts, which the sitting's line needs). */
export { itemSummaries } from "./matters";
