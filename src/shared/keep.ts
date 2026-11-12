/**
 * Keeping a review row (2026-11-12). One module says what a row becomes when it is kept: the Keep sheet
 * renders from `keepStart`/`keepPreview`, and Approve (one click on a row, or many rows at once) keeps
 * exactly what the sheet would keep with nothing changed. So the two cannot drift apart. Pure: no
 * Electron, no React. Approve runs in the main process on the live workspace; the window sends only ids.
 */
import { clipSittings, descriptionOf, intervals, isPersonal, keepStretch, keptMatch, overlaps, reviewedActivities, stretchSpan, subtractIntervals, type Activity, type DraftSource, type Interval, type KeepInput, type Project, type Stretch, type TimeEntry, type Workspace } from "./model";
import { contextOf } from "./invoice";
import { checkEntry, rulebookFor, roundUpToTenth, splitPlan, type CheckContext, type EntryDraft, type Finding, type PlanLine } from "./rules";
import { keepBounds, timeValue } from "./format";
import { inboxOf, matterStretch } from "./matters";
import { importedCovered } from "./feed";
import { isTutorialID } from "./onboarding";

// ---------------------------------------------------------------------------
// What the rules see (moved from the window's Rules.tsx, which re-exports them)
// ---------------------------------------------------------------------------

/** The rules context of a matter, by name or project: its client's rule set, its people, the timekeeper. */
export function rulesContext(w: Workspace, project: Project | null | undefined): CheckContext {
    const ctx = contextOf(project);
    return { book: project ? rulebookFor(w, ctx, project.client) : null, ctx, profile: w.profile ?? null };
}

export const projectByName = (w: Workspace, name: string): Project | undefined => w.projects.find((p) => !p.archived && p.name.trim().toLowerCase() === name.trim().toLowerCase());

/** YYYY-MM-DD in local time. */
export const localDay = (t: string | number): string => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** A kept entry as the rules see it. */
export function draftOf(e: TimeEntry): EntryDraft {
    const secs = (e.sittings?.length ? e.sittings : [e]).reduce((n, i) => n + (Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000, 0);
    return { id: e.id, description: e.description, hours: e.hours ?? Math.round((secs / 3600) * 100) / 100, taskCode: e.taskCode, activityCode: e.activityCode, billable: e.billable, hourlyRate: e.hourlyRate, day: localDay(e.startedAt) };
}

/** Entries on the same matter and day, for the rules that look across a day (one email entry, research hours). */
export function sameDayOf(w: Workspace, projectID: string | null, day: string, except?: string): EntryDraft[] {
    return w.entries.filter((e) => e.projectID === projectID && e.id !== except && localDay(e.startedAt) === day).map(draftOf);
}

/** Captured time as it is billed: rounded up to the tenth of an hour, never under a tenth. */
export const billedHours = (seconds: number): number => Math.max(0.1, roundUpToTenth(seconds / 3600));

// ---------------------------------------------------------------------------
// The Keep sheet's state and what it derives
// ---------------------------------------------------------------------------

/** What a person can change in the Keep sheet. Approve keeps the opening state as it is. */
export type KeepState = {
    matter: string;
    description: string;
    billable: boolean;
    /** "HH:MM", as the time boxes hold them; "" when cleared. */
    startText: string;
    endText: string;
    leaveOutIdle: boolean;
    /** Hours typed or set by a fix; null while they follow the captured time. */
    hoursSet: number | null;
    codes: { taskCode?: string; activityCode?: string };
    /** A rate set by a fix; null while it is the matter's. */
    rate: number | null;
};

type Span = { startedAt: string; endedAt: string; sittings?: Interval[] };

/**
 * The one captured task of these sittings, as the client's rules draft it (narrative, codes), when the matter
 * has a rules context and the sittings are exactly one task. The sheet offers it when nothing else describes the work.
 */
export function singleOf(w: Workspace, stretch: Stretch, sittings: readonly Activity[], matter: string): EntryDraft | null {
    const project = projectByName(w, matter);
    const rc = rulesContext(w, project);
    const plan = rc.ctx ? splitPlan(sittings, rc.ctx, rc.profile, { billable: true, hourlyRate: project?.hourlyRate ?? 0, day: localDay(stretch.startedAt) }) : [];
    return plan.length === 1 ? plan[0].draft : null;
}

/** The sheet as it opens: the row's matter, its description (the person's, else the draft, else capture's, else the name given), the captured times. */
export function keepStart(w: Workspace, stretch: Stretch, sittings: readonly Activity[], matter: string | null, initialDescription: string): KeepState & { single: EntryDraft | null } {
    const single = singleOf(w, stretch, sittings, matter ?? "");
    return {
        matter: matter ?? "",
        description: descriptionOf(sittings)?.text ?? single?.description ?? initialDescription,
        billable: true,
        startText: timeValue(stretch.startedAt),
        endText: timeValue(stretch.endedAt),
        leaveOutIdle: false,
        hoursSet: null,
        codes: single ? { taskCode: single.taskCode, activityCode: single.activityCode } : {},
        rate: null,
        single,
    };
}

export type KeepPreview = {
    project: Project | undefined;
    rc: CheckContext;
    day: string;
    start: number;
    end: number;
    /** The person edited a time box. */
    changed: boolean;
    missingTime: boolean;
    imported: boolean;
    /** The captured time inside the bounds. */
    span: Span | null;
    /** Seconds of flagged idle time inside the span. */
    idle: number;
    /** The span with the idle time out, when it is left out and there is more than one piece. */
    left: Interval[] | null;
    /** What would be kept: the span, less the idle time when it is left out. Null when nothing is left. */
    preview: Span | null;
    previewSeconds: number;
    hours: number;
    hourlyRate: number;
    /** One line per captured task of what would be kept: what a split makes. */
    plan: PlanLine[];
    draft: EntryDraft;
    sameDay: EntryDraft[];
    check: CheckContext;
    findings: Finding[];
    /** The description is a draft exactly as it was offered. */
    asDrafted: boolean;
    drafted?: DraftSource;
    /** What Keep time sends. */
    input: KeepInput;
};

/** Everything the sheet shows and sends for a state: bounds, the time kept, billed hours, the rules' findings, the input. */
export function keepPreview(w: Workspace, stretch: Stretch, sittings: readonly Activity[], s: KeepState, single: EntryDraft | null): KeepPreview {
    const project = projectByName(w, s.matter);
    const rc = rulesContext(w, project);
    const day = localDay(stretch.startedAt);
    const asDrafted = (!!stretch.draft && s.description.trim() === stretch.draft.text) || (!!single && s.description.trim() === single.description);
    const { start, end, changed } = keepBounds(stretch, s.startText, s.endText);
    // A cleared time box is "" (the browser's time input).
    const missingTime = !s.startText || !s.endText;
    const spans: Interval[] = sittings.flatMap(intervals);
    const imported = sittings.some((a) => a.origin);
    const span: Span | null = imported ? (() => { const kept = clipSittings(spans, start, end); return kept.length ? { startedAt: kept[0].startedAt, endedAt: kept[kept.length - 1].endedAt, sittings: kept } : null; })() : stretchSpan(spans, start, end);
    const idleList = sittings.flatMap((a) => a.idle ?? []);
    const idle = span ? idleList.reduce((n, i) => n + intervals(span).reduce((m, x) => m + Math.max(0, Math.min(Date.parse(i.endedAt), Date.parse(x.endedAt)) - Math.max(Date.parse(i.startedAt), Date.parse(x.startedAt))) / 1000, 0), 0) : 0;
    const left = span && s.leaveOutIdle && idle > 0 ? subtractIntervals(intervals(span), idleList) : null;
    const preview: Span | null = left ? (left.length ? { startedAt: left[0].startedAt, endedAt: left[left.length - 1].endedAt, sittings: left } : null) : span;
    const previewSeconds = preview ? intervals(preview).reduce((n, i) => n + (Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000, 0) : 0;
    const hours = s.hoursSet ?? billedHours(previewSeconds);
    const hourlyRate = s.rate ?? project?.hourlyRate ?? 0;
    const plan = rc.ctx && preview ? splitPlan(reviewedActivities(sittings, intervals(preview)), rc.ctx, rc.profile, { billable: s.billable, hourlyRate, day, ...(s.hoursSet !== null ? { hours: s.hoursSet } : {}) }) : [];
    const draft: EntryDraft = { description: s.description, hours, ...s.codes, billable: s.billable, hourlyRate, day };
    const sameDay = sameDayOf(w, project?.id ?? null, day);
    const check: CheckContext = { ...rc, sameDay, splitCount: plan.length, suggestion: single?.description ?? null };
    const drafted = asDrafted ? ((stretch.draft?.source ?? "capture") as DraftSource) : undefined;
    const input: KeepInput = { description: s.description, projectID: null, matter: s.matter.trim() || null, billable: s.billable, ...(drafted ? { drafted } : {}), ...(changed ? { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() } : {}), ...(s.leaveOutIdle && idle > 0 ? { leaveOutIdle: true } : {}), ...(rc.book ? { hours, ...s.codes, hourlyRate } : {}) };
    return { project, rc, day, start, end, changed, missingTime, imported, span, idle, left, preview, previewSeconds, hours, hourlyRate, plan, draft, sameDay, check, findings: checkEntry(draft, check), asDrafted, ...(drafted ? { drafted } : {}), input };
}

// ---------------------------------------------------------------------------
// Approve: keep a row as it is shown
// ---------------------------------------------------------------------------

export type ApproveReason = "changed" | "reviewed" | "tutorial" | "in-progress" | "personal" | "no-matter" | "no-description" | "merge-question" | "imported-overlap" | "kiwi-matters" | "overlap" | "rules" | "no-time" | "refused";

/**
 * Whether a row can be kept as shown. `ok`: what Approve keeps. Otherwise why not, in a sentence for the person,
 * and whether the Keep sheet settles it (`opensSheet`: the button opens the sheet) or something on the row must
 * change first (the button is disabled and says what).
 */
export type ApproveVerdict =
    | { ok: true; input: KeepInput; hours: number; label: string }
    | { ok: false; reason: ApproveReason; message: string; opensSheet: boolean };

const no = (reason: ApproveReason, message: string, opensSheet = false): ApproveVerdict => ({ ok: false, reason, message, opensSheet });
const possessive = (name: string): string => (name.endsWith("s") ? `${name}'` : `${name}'s`);

export const APPROVE_MESSAGES = {
    tutorial: "The sample saves nothing. Press Edit… to see the Keep sheet.",
    changed: "This row changed since it was shown. Review it again.",
    inProgress: "This work is still in progress. It can be kept once you switch away from it.",
    reviewed: "This time has already been reviewed.",
    personal: "Personal time is never kept.",
    noMatter: "Put this on a matter first (Matter ▾), or use Edit… to keep it without one.",
    mergeQuestion: "Answer the question first: Keep separate or Add to entry.",
    noDescription: "Add a description first (the pencil), or write one in Edit…",
    importedOverlap: "Some of this imported time is covered by other time; the sheet keeps what remains.",
    kiwiMatters: "This time belongs to more than one Kiwi matter; choose one in the sheet.",
    noTime: "No captured time is left in this row.",
    overlap: "Part of this time is already kept, or the timer is running.",
} as const;

/** The verdict on one row, against the workspace as it is now. `sittings` are the row's activities; `matter` its matter (null for a stretch on none). */
export function approveCheck(w: Workspace, stretch: Stretch, sittings: readonly Activity[], matter: string | null, now: number): ApproveVerdict {
    const ids = stretch.activityIDs;
    if (ids.some(isTutorialID)) return no("tutorial", APPROVE_MESSAGES.tutorial);
    if (ids.some((id) => id === w.currentActivity?.id)) return no("in-progress", APPROVE_MESSAGES.inProgress);
    const live = ids.map((id) => w.activities.find((a) => a.id === id));
    if (!ids.length || live.some((a) => !a)) return no("changed", APPROVE_MESSAGES.changed);
    if (live.some((a) => a!.disposition !== "pending")) return no("reviewed", APPROVE_MESSAGES.reviewed);
    if (isPersonal(matter) || sittings.some((a) => isPersonal(a.matter))) return no("personal", APPROVE_MESSAGES.personal);
    if (!matter?.trim()) return no("no-matter", APPROVE_MESSAGES.noMatter);
    if (keptMatch(w, ids)) return no("merge-question", APPROVE_MESSAGES.mergeQuestion);
    if (!descriptionOf(sittings)) return no("no-description", APPROVE_MESSAGES.noDescription);
    if (importedCovered(w, ids, now)) return no("imported-overlap", APPROVE_MESSAGES.importedOverlap, true);
    // As keepStretch has it: one row, one Kiwi matter.
    if (new Set(sittings.filter((a) => a.matter === matter && a.kiwiProjectID).map((a) => a.kiwiProjectID)).size > 1) return no("kiwi-matters", APPROVE_MESSAGES.kiwiMatters, true);
    const start = keepStart(w, stretch, sittings, matter, stretch.name);
    const p = keepPreview(w, stretch, sittings, start, start.single);
    if (!p.preview || !p.input.description.trim()) return no("no-time", APPROVE_MESSAGES.noTime);
    if (p.findings.length) return no("rules", `${possessive(p.rc.book?.client ?? "The client")} rules flag this entry: ${p.findings[0].message}`, true);
    if (intervals(p.preview).some((i) => overlaps(w, Date.parse(i.startedAt), Date.parse(i.endedAt)))) return no("overlap", APPROVE_MESSAGES.overlap, true);
    return { ok: true, input: p.input, hours: p.hours, label: p.input.description.trim() };
}

/** The review row these activities are, as the inbox has it now (a matter's day, a stretch, or a day of personal time); null when they are no longer one row. */
export function inboxRowOf(w: Workspace, activityIDs: readonly string[]): { stretch: Stretch; matter: string | null; sittings: Activity[] } | null {
    if (!activityIDs.length) return null;
    const want = new Set(activityIDs);
    const same = (ids: readonly string[]): boolean => ids.length === want.size && ids.every((id) => want.has(id));
    const { groups, stretches, personal } = inboxOf(w.activities);
    const byID = new Map(w.activities.map((a) => [a.id, a]));
    const sittingsOf = (ids: readonly string[]): Activity[] => ids.map((id) => byID.get(id)).filter((a): a is Activity => !!a);
    const g = [...groups, ...personal].find((x) => same(x.activityIDs));
    if (g) return { stretch: matterStretch(g), matter: g.matter, sittings: sittingsOf(g.activityIDs) };
    const st = stretches.find((x) => same(x.activityIDs));
    return st ? { stretch: st, matter: null, sittings: sittingsOf(st.activityIDs) } : null;
}

export type ApproveReport = {
    kept: { activityIDs: string[]; entryID: string; label: string; hours: number }[];
    skipped: { activityIDs: string[]; label: string; reason: ApproveReason; message: string }[];
};

/** At most this many rows in one approval. */
export const APPROVE_MAX_ROWS = 200;

/** What to call a row that could not be read as one: its description, else its document, title or app. */
function labelOf(w: Workspace, ids: readonly string[]): string {
    const acts = ids.map((id) => w.activities.find((a) => a.id === id)).filter((a): a is Activity => !!a);
    return descriptionOf(acts)?.text ?? acts[0]?.document?.name ?? acts[0]?.title ?? acts[0]?.app ?? "A row";
}

/**
 * Approve rows (each a row's activity ids, as the window showed it): every row is checked against the
 * workspace as it is now, oldest first, so a later row sees the entries kept before it. A row that
 * cannot be kept as shown is left exactly as it was and named in the report; it never stops the others.
 */
export function approveRows(w: Workspace, rows: readonly (readonly string[])[], now: number): ApproveReport {
    const report: ApproveReport = { kept: [], skipped: [] };
    const seen = new Set<string>();
    const found: { ids: string[]; row: NonNullable<ReturnType<typeof inboxRowOf>> }[] = [];
    for (const raw of rows.slice(0, APPROVE_MAX_ROWS)) {
        const ids = [...new Set(raw.filter((id) => typeof id === "string" && id))];
        if (!ids.length) continue;
        const repeat = ids.some((id) => seen.has(id));
        for (const id of ids) seen.add(id);
        const row = repeat ? null : inboxRowOf(w, ids);
        if (!row) {
            const verdict = ids.some(isTutorialID) ? no("tutorial", APPROVE_MESSAGES.tutorial) : no("changed", APPROVE_MESSAGES.changed);
            if (!verdict.ok) report.skipped.push({ activityIDs: ids, label: labelOf(w, ids), reason: verdict.reason, message: verdict.message });
            continue;
        }
        found.push({ ids, row });
    }
    found.sort((a, b) => Date.parse(a.row.stretch.startedAt) - Date.parse(b.row.stretch.startedAt));
    for (const { ids, row: first } of found) {
        // Entries kept earlier in this batch may have changed the row (imported time is clipped at each keep): read it again.
        const row = report.kept.length ? inboxRowOf(w, ids) : first;
        if (!row) { report.skipped.push({ activityIDs: ids, label: labelOf(w, ids), reason: "changed", message: APPROVE_MESSAGES.changed }); continue; }
        const { sittings } = row;
        const verdict = approveCheck(w, row.stretch, sittings, row.matter, now);
        const label = descriptionOf(sittings)?.text ?? (row.matter || row.stretch.name);
        if (!verdict.ok) { report.skipped.push({ activityIDs: ids, label, reason: verdict.reason, message: verdict.message }); continue; }
        // A refused keep may have changed the workspace on its way to refusing: put it back whole.
        const before = structuredClone(w) as Workspace;
        try {
            const entry = keepStretch(w, row.stretch.activityIDs, verdict.input, now);
            report.kept.push({ activityIDs: ids, entryID: entry.id, label: verdict.label, hours: verdict.hours });
        } catch (err) {
            const target = w as unknown as Record<string, unknown>;
            for (const key of Object.keys(target)) delete target[key];
            Object.assign(target, before);
            const message = err instanceof Error ? err.message : String(err);
            report.skipped.push(/overlap/i.test(message) ? { activityIDs: ids, label, reason: "overlap", message: APPROVE_MESSAGES.overlap } : { activityIDs: ids, label, reason: "refused", message });
        }
    }
    return report;
}

const SHEET_REASONS = new Set<ApproveReason>(["imported-overlap", "kiwi-matters", "rules"]);
const SHORT_REASONS: Partial<Record<ApproveReason, string>> = {
    changed: "changed since it was shown",
    reviewed: "was already reviewed",
    tutorial: "is the tutorial's sample",
    "in-progress": "is still in progress",
    personal: "is personal time",
    "no-matter": "has no matter",
    "no-description": "has no description",
    "merge-question": "has a question to answer first",
    "no-time": "has no captured time left",
    overlap: "overlaps time you already kept, or the timer is running",
};
const short = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const unstopped = (text: string): string => text.trim().replace(/[.;]+$/, "");

/** The report in a toast: how much was kept, then the first three rows that were not and why, then how many more. */
export function approveSummary(r: ApproveReport): string {
    const hours = r.kept.reduce((n, k) => n + k.hours, 0);
    const kept = r.kept.length ? `Kept ${r.kept.length} ${r.kept.length === 1 ? "entry" : "entries"}, ${hours.toFixed(1)} hr.` : "Nothing was kept.";
    if (!r.skipped.length) return kept;
    const named = r.skipped.slice(0, 3).map((x) => `“${short(x.label)}” ${SHEET_REASONS.has(x.reason) ? `needs the Keep sheet: ${unstopped(x.message)}` : SHORT_REASONS[x.reason] ?? `could not be kept: ${unstopped(x.message)}`}`);
    const more = r.skipped.length - named.length;
    return `${kept} Not kept: ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}
