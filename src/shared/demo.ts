/* A demo workspace from a seed file (resources/demo/manatt.json, built by the demo repo's
   workflows/manatt/time/make_seed.py), and the stages a presenter's console moves it
   through. Pure, like the model: the main process (src/main/rulesFeed.ts) reads the seed
   and the feed and hands them here.

   The feed is one JSON document — a file or a URL (the lawdie-manatt-time Lambda):
   { epoch, stage, rulebooks: [client rule sets as the billing system exports them] }.
   A new epoch rebuilds the workspace from the seed (reset). A stage adds that stage's
   captured day ("act3": the day after the client's rejection) or takes it out again. Rule
   sets go through upsertRulebook like any rules update, so rules that are new since the
   last version are announced and labelled new where they flag an entry. */

import { emptyWorkspace, type Activity, type DocumentInfo, type Project, type Workspace } from "./model";
import { narrativeFor } from "./narrative";
import { normalizeRuleSet, sourceLabel, upsertRulebook, type MatterContext, type Profile, type Rule } from "./rules";

export type SeedActivity = { n: number; app: string; ownerID: string; title: string | null; start: string; end: string; document?: DocumentInfo | null; screenText?: string | null };
export type SeedStage = { day: string; activities: SeedActivity[] };
export type Seed = {
    seed: string;
    profile: Profile;
    project: { name: string; client: string; hourlyRate: number; context: MatterContext };
    rulebooks: unknown[];
    stages: Record<string, SeedStage>;
};
export type Feed = { epoch: number; stage: string; rulebooks?: unknown[] };

export const BASE_STAGE = "day";

/** A seed file's JSON, checked enough that a bad file fails loudly at launch. */
export function parseSeed(text: string): Seed {
    const s = JSON.parse(text) as Seed;
    if (!s || typeof s.seed !== "string" || !s.project?.context || !s.stages?.[BASE_STAGE] || !Array.isArray(s.rulebooks)) throw new Error("The demo seed file is not a Time Capture seed.");
    return s;
}

/** "2026-10-22" and "08:32" → that wall-clock time on this machine. */
export function localTime(day: string, hhmm: string): number {
    const [y, m, d] = day.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    return new Date(y, m - 1, d, h, mi, 0, 0).getTime();
}

const stageIDs = (stage: string) => `seed-${stage}-`;

/** A stage's captured day as pending activity on the matter, each sitting carrying the day's narrative from capture. */
function stageActivities(seed: Seed, stage: string): Activity[] {
    const st = seed.stages[stage];
    if (!st) return [];
    const list: Activity[] = st.activities.map((a) => ({
        id: `${stageIDs(stage)}${a.n}`, app: a.app, ownerID: a.ownerID, title: a.title,
        ...(a.document ? { document: a.document } : {}), ...(a.screenText ? { screenText: a.screenText } : {}),
        startedAt: new Date(localTime(st.day, a.start)).toISOString(), endedAt: new Date(localTime(st.day, a.end)).toISOString(),
        endedBy: "switched", disposition: "pending", matter: seed.project.name, matterBy: "ai",
    }));
    const text = narrativeFor(list, seed.project.context, seed.profile.name);
    for (const a of list) a.draft = { text: text.slice(0, 500), source: "capture" };
    return list;
}

/** The workspace a seed starts from: the matter, the timekeeper, the rules before Act 3, the base day to review. */
export function seedWorkspace(seed: Seed, epoch: number, now: number): Workspace {
    const w = emptyWorkspace();
    const p: Project = { id: `seed-project-${seed.seed}`, name: seed.project.name, client: seed.project.client, color: "gold", hourlyRate: seed.project.hourlyRate, archived: false, context: seed.project.context };
    w.projects.push(p);
    w.profile = seed.profile;
    w.preferences.captureEnabled = false;
    w.preferences.captureTitles = true;
    w.preferences.captureDocuments = true;
    w.preferences.retentionDays = 90;
    w.rulebooks = [];
    for (const raw of seed.rulebooks) upsertRulebook(w, normalizeRuleSet(raw), now);
    w.activities = stageActivities(seed, BASE_STAGE);
    w.demo = { seed: seed.seed, epoch, stage: BASE_STAGE, day: seed.stages[BASE_STAGE].day };
    return w;
}

/** Move a demo workspace to a stage: add that stage's day (once), or take every later stage's day and the entries kept from it back out. */
export function applyStage(w: Workspace, seed: Seed, stage: string): void {
    if (!w.demo || !seed.stages[stage] || w.demo.stage === stage) return;
    for (const other of Object.keys(seed.stages)) {
        if (other === BASE_STAGE || other === stage) continue;
        const prefix = stageIDs(other);
        const gone = new Set(w.activities.filter((a) => a.id.startsWith(prefix)).map((a) => a.id));
        w.activities = w.activities.filter((a) => !gone.has(a.id));
        w.entries = w.entries.filter((e) => ![e.activityID, ...(e.activityIDs ?? [])].some((id) => id && gone.has(id)));
    }
    if (stage !== BASE_STAGE && !w.activities.some((a) => a.id.startsWith(stageIDs(stage)))) w.activities.push(...stageActivities(seed, stage));
    w.demo = { ...w.demo, stage, day: seed.stages[stage].day };
}

/** What a rules update says when it lands: the client and each new rule, with where it came from. */
export function rulesNotice(client: string, added: Rule[]): string | null {
    if (!added.length) return null;
    const from = [...new Set(added.map((r) => sourceLabel(r, null).replace(/^From /, "")))].join("; ");
    return `${client} updated its billing rules: ${added.length} new ${added.length === 1 ? "rule" : "rules"} from ${from}. ${added.map((r) => r.title).join(". ")}. The next entries are checked against ${added.length === 1 ? "it" : "them"}.`;
}

/**
 * One read of the feed applied to the workspace. Returns what to tell the person, or null.
 * A demo workspace whose epoch differs is rebuilt from the seed first; then the feed's rule
 * sets are taken and the stage applied. A workspace that is not a demo only takes the rules.
 */
export function applyFeed(w: Workspace, seed: Seed | null, feed: Feed, now: number): { workspace: Workspace; notice: string | null } {
    let next = w;
    let reset = false;
    if (seed && (!w.demo || w.demo.epoch !== feed.epoch)) {
        next = seedWorkspace(seed, feed.epoch, now);
        // The first seeding is not a reset worth announcing; a console reset of a running demo is.
        reset = !!w.demo;
    }
    const notices: string[] = [];
    for (const raw of feed.rulebooks ?? []) {
        const book = normalizeRuleSet(raw);
        const { added } = upsertRulebook(next, book, now);
        const said = rulesNotice(book.client, added);
        if (said) notices.push(said);
    }
    if (seed && next.demo) applyStage(next, seed, feed.stage);
    if (reset) notices.unshift(`Demo reset: ${seed!.profile.name}'s captured day is back to review.`);
    return { workspace: next, notice: notices.join(" ") || null };
}

/** The clock a demo runs on: never before the end of its current day, so time kept on a seeded future day is not "in the future". */
export function demoNow(w: Workspace, now: number): number {
    return w.demo?.day ? Math.max(now, localTime(w.demo.day, "23:59")) : now;
}

/** Today in a demo is its seeded day, at the current time of day; elsewhere, now. */
export function viewNow(w: Workspace, now: number): number {
    if (!w.demo?.day) return now;
    const d = new Date(now);
    return localTime(w.demo.day, `${d.getHours()}:${d.getMinutes()}`) + d.getSeconds() * 1000;
}

