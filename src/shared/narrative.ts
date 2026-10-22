/* The local drafter: a billing narrative from what capture saw, without a model. Pure and
   deterministic, so the same day always drafts the same entries (a demo on stage, a test).
   It reads each sitting's app, document, title, Office excerpt and on-screen text against
   the matter's context (people and what its documents are called) and names one task per
   sitting: an email with someone, a call, a revision of a named document, research. Sittings
   on the same task join; a matter's day joined into one line is block billing, which the
   client's rules then split by the captured time of each task (src/shared/rules.ts). */

import type { Activity } from "./model";
import type { MatterContext, Person } from "./rules";

export type TaskKind = "email" | "call" | "draft" | "review" | "research" | "other";

export type Task = {
    /** Same key, same task: sittings with one key become one entry when a day is split. */
    key: string;
    kind: TaskKind;
    /** The narrative, starting with a capitalised task verb. */
    text: string;
    taskCode: string;
    activityCode: string;
    /** Only firm people took part (a call with a colleague). */
    internal: boolean;
};

const has = (re: RegExp, ...texts: (string | null | undefined)[]) => texts.some((t) => !!t && re.test(t));

export function kindOf(a: Pick<Activity, "app" | "document" | "title">): TaskKind {
    const app = a.app.toLowerCase();
    if (/outlook|^mail$|apple mail|thunderbird/.test(app)) return "email";
    if (/teams|zoom|webex|facetime|ringcentral|phone|meet/.test(app)) return "call";
    if (/word|pages|docs/.test(app)) return "draft";
    if (/acrobat|preview|pdf|reader/.test(app)) {
        const name = a.document?.name ?? a.title ?? "";
        return /c\.?f\.?r\b|u\.?s\.?c\b|\bcode\b|guidance|regulation|statute|\bact\b|§|cal\.|opinion|treatise/i.test(name) ? "research" : "review";
    }
    return "other";
}

/** "Lauren Mbeki" → "L. Mbeki", "Dr. Simon Achterberg" → "Dr. S. Achterberg"; a label such as "Corvane counsel" stays. */
export function shortName(p: Person): string {
    if (p.label) return p.name;
    const parts = p.name.trim().split(/\s+/);
    const title = /^(dr|prof|mr|ms|mrs|hon)\.?$/i.test(parts[0]) ? parts.shift() + " " : "";
    if (parts.length < 2) return title + parts.join(" ");
    return `${title}${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

/** The people of the matter named in these texts, in the order the context lists them. */
export function peopleIn(ctx: MatterContext | null, ...texts: (string | null | undefined)[]): Person[] {
    const hay = texts.filter(Boolean).join("\n").toLowerCase();
    return (ctx?.people ?? []).filter((p) => {
        const names = [p.name, ...(p.aliases ?? [])].map((n) => n.toLowerCase());
        return names.some((n) => hay.includes(n)) || (!p.label && hay.includes(p.name.split(/\s+/).pop()!.toLowerCase() + ","));
    });
}

const lower = (s: string) => (s && !/^[A-Z]{2,}|^[A-Z]\.|^Dr\./.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const joinAnd = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** An email subject as a topic: no RE:/FW:, no matter number, no trailing dash. */
export function topicOfSubject(subject: string, ctx: MatterContext | null): string {
    let t = subject.replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, "");
    if (ctx?.number) t = t.split(ctx.number).join("");
    return t.replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, "").replace(/\s{2,}/g, " ");
}

/** What a document is called: the matter's glossary first (longest match), then its file name tidied. Versions as "(v5)". */
export function documentTitle(fileName: string, ctx: MatterContext | null): string {
    const base = fileName.replace(/\.(docx?|pdf|xlsx?|pptx?|rtf|txt|pages)$/i, "");
    const version = base.match(/[_\s-]v(\d+)\b/i)?.[1];
    const key = Object.keys(ctx?.glossary ?? {}).filter((k) => base.toLowerCase().includes(k.toLowerCase())).sort((a, b) => b.length - a.length)[0];
    const name = key ? ctx!.glossary[key] : base.replace(/[_]+/g, " ").replace(/\s+v\d+$/i, "").replace(/\bCFR\b/g, "C.F.R.").trim();
    return version ? `${name} (v${version})` : name;
}

/** "Section 4.2 Permitted Purposes" → "section 4.2 (permitted purposes)", at most two, from an excerpt or the screen. */
export function sectionsIn(...texts: (string | null | undefined)[]): string[] {
    const out: string[] = [];
    for (const m of texts.filter(Boolean).join("\n").matchAll(/(?:Section|§)\s*(\d+(?:\.\d+)*)\s*[(\-–:.]?\s*([A-Z][A-Za-z\- ]{2,40}?)?(?=[.;\n)]|$)/g)) {
        const label = `section ${m[1]}${m[2] ? ` (${m[2].trim().toLowerCase()})` : ""}`;
        if (!out.some((x) => x.startsWith(`section ${m[1]}`))) out.push(label);
        if (out.length === 2) break;
    }
    return out;
}

const TOPIC_NOISE = /^(call|meeting|chat|microsoft teams|teams|zoom|in call|calling|participants?:?.*|\d+:\d+.*)$/i;

/** One sitting as a task. */
export function taskOf(a: Activity, ctx: MatterContext | null, me: string | null = null): Task {
    const kind = kindOf(a);
    const task = ctx?.defaultTask ?? "P500";
    const docName = a.document?.name ?? null;
    if (kind === "email") {
        const subject = docName ?? a.title?.split(/\s[-–|]\s/)[0] ?? "email";
        const people = peopleIn(ctx, a.document?.excerpt, subject, a.screenText).filter((p) => p.name !== me);
        const other = people.find((p) => p.side !== "firm") ?? people[0];
        const topic = topicOfSubject(subject, ctx);
        const internal = !!other && other.side === "firm";
        const code = !other ? "A108" : other.side === "client" ? "A106" : other.side === "firm" ? "A105" : other.side === "counterparty" ? "A107" : "A108";
        return { key: `email:${other?.name ?? topic}`, kind, text: `Emails with ${other ? shortName(other) : "counsel"} re ${lower(topic)}`, taskCode: task, activityCode: code, internal };
    }
    if (kind === "call") {
        const title = (a.title ?? "").split("|")[0].trim();
        const people = peopleIn(ctx, a.title, a.screenText).filter((p) => p.name !== me);
        const outside = people.filter((p) => p.side !== "firm");
        const internal = people.length > 0 && outside.length === 0;
        const names = (outside.length ? [...outside.filter((p) => p.label), ...outside.filter((p) => !p.label)] : people).map(shortName);
        const lines = [title, ...(a.screenText ?? "").split("\n")].map((l) => l.trim()).filter((l) => l && !TOPIC_NOISE.test(l) && !peopleIn(ctx, l).length);
        const topic = lines[0]?.replace(/^[^:]*:\s*/, "") ?? "";
        const verb = internal ? "Conference with" : "Call with";
        const text = `${verb} ${names.length ? joinAnd(names) : "counsel"}${topic ? ` re ${lower(topic)}` : ""}`;
        // Keyed by who took part: every Teams window is titled "Microsoft Teams", and two calls with different people are two tasks.
        return { key: `call:${names.join(",") || title}`, kind, text, taskCode: internal ? "P300" : task, activityCode: internal ? "A105" : outside.some((p) => p.side === "client") ? "A106" : "A107", internal };
    }
    if (kind === "draft" || kind === "review") {
        const file = docName ?? a.title ?? a.app;
        const title = documentTitle(file, ctx);
        const sections = sectionsIn(a.document?.excerpt, a.screenText);
        const revising = kind === "draft" && (/[_\s-]v\d+/i.test(file) || has(/track(ed)? changes|redline|comments/i, a.document?.excerpt, a.screenText));
        const verb = kind === "review" ? "Review" : revising ? "Revise" : "Draft";
        const text = `${verb} ${title}${sections.length ? ` re ${joinAnd(sections)}` : ""}`;
        return { key: `doc:${title.replace(/\s*\(v\d+\)$/, "")}`, kind, text, taskCode: task, activityCode: kind === "review" ? "A104" : "A103", internal: false };
    }
    if (kind === "research") {
        const title = documentTitle(docName ?? a.title ?? a.app, ctx);
        return { key: `research:${title}`, kind, text: `Research ${title}`, taskCode: "P300", activityCode: "A102", internal: false };
    }
    const what = docName ?? a.title ?? a.app;
    return { key: `other:${what}`, kind, text: `Work in ${a.app} on ${what}`, taskCode: task, activityCode: "A111", internal: false };
}

/** Sittings on the same task joined: emails with one person gather their topics, a document its sections. */
export function tasksOf(activities: readonly Activity[], ctx: MatterContext | null, me: string | null = null): (Task & { activityIDs: string[]; seconds: number })[] {
    const out = new Map<string, Task & { activityIDs: string[]; seconds: number; topics: string[] }>();
    for (const a of [...activities].sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt))) {
        const t = taskOf(a, ctx, me);
        const secs = Math.max(0, (Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000);
        const topic = t.text.includes(" re ") ? t.text.slice(t.text.indexOf(" re ") + 4) : "";
        const found = out.get(t.key);
        if (!found) { out.set(t.key, { ...t, activityIDs: [a.id], seconds: secs, topics: topic.split(/, | and /).filter(Boolean) }); continue; }
        found.activityIDs.push(a.id);
        found.seconds += secs;
        for (const x of topic.split(/, | and /)) if (x && !found.topics.includes(x)) found.topics.push(x);
        if (t.kind === "draft" && t.text.startsWith("Revise")) found.text = found.text.replace(/^Draft /, "Revise ");
        const head = found.text.includes(" re ") ? found.text.slice(0, found.text.indexOf(" re ")) : found.text;
        found.text = found.topics.length ? `${head} re ${joinAnd(found.topics)}` : head;
    }
    return [...out.values()].map(({ topics: _topics, ...t }) => t);
}

/** The narrative of a whole row: one task as written, several joined with semicolons (block billing until split). */
export function narrativeFor(activities: readonly Activity[], ctx: MatterContext | null, me: string | null = null): string {
    const tasks = tasksOf(activities, ctx, me);
    return tasks.map((t, n) => (n === 0 ? t.text : lower(t.text))).join("; ");
}
