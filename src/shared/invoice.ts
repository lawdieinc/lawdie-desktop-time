/* The day's bill, from the kept entries and a client's billing rules, as the Time page shows it,
   and the time sheet and invoice made from it. Pure: the main process renders the HTML in a
   hidden window and prints it to PDF, and builds the DOCX (src/main/docx.ts) from the same lines.

   Generic billing: each settled entry bills as recorded at its own rate. A client's rulebook
   (workspace.clientRulebooks, one applied at a time) changes the lines each rule applies to,
   and every change is kept on the line as an effect (which rule, what, before and after) and,
   for words added to a narrative, as a marked segment: what the Time page shows inline, what
   the rules page lists, and what the DOCX writes as tracked changes and comments. */

import { seconds, type ClientRule, type ClientRulebook, type InvoiceTerms, type Project, type TimeEntry, type Workspace } from "./model";
import type { MatterContext } from "./rules";

/** A change a rule made to a line. rate, hours, noCharge: a figure, before and after. split: one entry made several
 *  lines. text: words added to the narrative (`text` says which). kept: checked, and the line stays as it is. */
export type LineEffect = { rule: string; what: "rate" | "hours" | "noCharge" | "split" | "text" | "kept"; before?: string; after?: string; text?: string };
/** A piece of a line's narrative; `ins` names the rule that added it. */
export type Segment = { text: string; ins?: string | null };

/** One billed line. `std*` are the line as the firm's standard terms bill it. */
export type FeeLine = {
    entryID: string; date: string; timekeeper: string;
    description: string; segments: Segment[];
    hours: number; rate: number; amount: number; noCharge: boolean; note: string | null;
    stdHours: number; stdRate: number; stdAmount: number; stdDescription: string;
    effects: LineEffect[];
    /** The rules that changed this line (effects other than kept). */
    changes: string[];
    /** A block-billed entry split into lines: this line's part, of how many, and the entry's full narrative. */
    split?: { part: number; of: number; full: string } | null;
};

/** Billing hours: captured time rounded up to the tenth. */
export const tenths = (minutes: number): number => Math.ceil(Math.round(minutes * 100) / 100 / 6 - 1e-9) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const hrs = (h: number): string => `${h.toFixed(Math.round(h * 100) % 10 ? 2 : 1)} h`;

export const money = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "$1,195" for a round rate, "$358.50" otherwise. */
export const moneyShort = (n: number): string => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : money(n));

/** What a bill covers: one day (the Time page), or a matter over a period (an invoice), days YYYY-MM-DD, `to` inclusive. */
export type BillScope = { day?: string | null; projectID?: string | null; from?: string | null; to?: string | null };

/** Entries that bill: on a matter, settled (no open suggestion or flag), with a narrative, inside the scope. */
export function billable(w: Workspace, scope: string | null | BillScope = null): TimeEntry[] {
    const s: BillScope = typeof scope === "string" ? { day: scope } : scope ?? {};
    const inScope = (e: TimeEntry): boolean => {
        const d = localDay(e.startedAt);
        return (!s.day || d === s.day) && (!s.projectID || e.projectID === s.projectID) && (!s.from || d >= s.from) && (!s.to || d <= s.to);
    };
    return w.entries.filter((e) => e.projectID && (!e.status || e.status === "draft") && e.description.trim() && inScope(e))
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** The local day of an ISO time, YYYY-MM-DD. */
export const localDay = (iso: string): string => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** "October 31, 2026" from YYYY-MM-DD. */
export const longDate = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/**
 * The terms one bill prints: the firm's side from Settings → Billing, the matter's from the project
 * (its number, name, client and bill-to lines), the period's end and the invoice's number. A demo
 * seed's `invoice` stands in for the firm's side when there is no setup. With neither there are
 * plain terms: the timekeeper's name and nothing else.
 */
export function termsFor(w: Workspace, project: Project | null, through: string | null = null, number = ""): InvoiceTerms {
    const b = w.billing, seed = w.invoice;
    const firm = b ? { name: b.firm.name, address: b.firm.address } : seed?.firm ?? { name: "", address: [] };
    const timekeeper = b ? b.timekeeper : seed?.timekeeper ?? { name: w.profile?.name ?? "", title: "" };
    const base: InvoiceTerms = {
        firm, timekeeper,
        billTo: project ? (project.billTo?.length ? project.billTo : project.client ? [project.client] : []) : seed?.billTo ?? [],
        client: project ? project.client : seed?.client ?? "",
        matter: project ? project.matterNumber ?? project.name : seed?.matter ?? "",
        matterName: project ? project.name : seed?.matterName ?? "",
        number: number || seed?.number || "",
        through: through ? longDate(through) : seed?.through ?? "",
        terms: b ? b.terms ?? "" : seed?.terms ?? "",
    };
    const extra: Partial<InvoiceTerms> = b
        ? { ...(b.logo ? { logo: b.logo } : {}), ...(b.folder ? { folder: b.folder } : {}), ...(b.footer ? { footer: b.footer } : {}), ...(b.remit?.length ? { remit: b.remit } : {}), ...(b.contact ? { contact: b.contact } : {}) }
        : seed ? { logo: seed.logo, folder: seed.folder, footer: seed.footer, remit: seed.remit, contact: seed.contact, rateCap: seed.rateCap, rateCapRule: seed.rateCapRule, noChargeActivity: seed.noChargeActivity, noChargeRule: seed.noChargeRule } : {};
    return { ...base, ...extra };
}

/** The workspace's terms with no matter chosen: the seed's, else the firm's side alone (what the Time page's day bill uses). */
export const termsOf = (w: Workspace): InvoiceTerms => w.invoice ?? termsFor(w, null);

/** What the rules know about a matter: its `context` from a seed, else what the person set on it (number, client, code set). */
export function contextOf(p: Project | null | undefined): MatterContext | null {
    if (!p) return null;
    if (p.context) return p.context;
    if (!p.matterNumber && !p.client) return null;
    return { number: p.matterNumber ?? "", client: p.client, ...(p.codeSet ? { codeSet: p.codeSet } : {}), people: [], glossary: {} };
}

const sentence = (t: string): string => { const s = t.trim().replace(/[.;]+$/, ""); return s ? `${s[0].toUpperCase()}${s.slice(1)}.` : s; };
const usDate = (iso: string): string => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };

// ---------------------------------------------------------------------------
// Rulebooks

/** Every client rulebook the workspace carries; an older workspace's single `clientRules` reads as one. */
export function rulebooksOf(w: Workspace): ClientRulebook[] {
    if (w.clientRulebooks?.length) return w.clientRulebooks;
    if (w.clientRules) return [{ key: "client", client: w.clientRules.client, short: w.clientRules.client.split(" ")[0], title: w.clientRules.title, effective: "", doc: "", email: "", rules: w.clientRules.rules }];
    return [];
}
export const bookOf = (w: Workspace, key: string | null | undefined): ClientRulebook | null => (key ? rulebooksOf(w).find((b) => b.key === key) ?? null : null);
/** The rulebook applied on the Time page, or null for generic billing. */
export const appliedBook = (w: Workspace): ClientRulebook | null => bookOf(w, w.billingClient);
/** "Northlake" or "Kestrel": a rulebook's name in file names and the totals line. */
export const shortName = (b: ClientRulebook): string => b.short.split(" ")[0];

/** "Northlake OCG §5.1" or "Engagement letter §3": where a rule comes from, for a line's note and a comment. */
export const citeOf = (r: ClientRule, w: Workspace, book?: ClientRulebook | null): string =>
    (/^engagement|\bOCG\b/i.test(r.section) ? r.section : `${(book?.short ?? w.clientRules?.client ?? "Client").split(" ")[0]} OCG ${r.section}`);

/** The rules in force for the older single-client rules bill: the client's rules that are on, or, without client rules,
 *  the terms' rate cap and no-charge code. */
export function activeRules(w: Workspace, terms: InvoiceTerms): ClientRule[] {
    if (w.clientRules) return w.clientRules.rules.filter((r) => r.enabled);
    const base = { section: "", title: "", quote: "", does: "", enabled: true };
    return [
        ...(terms.rateCap ? [{ ...base, id: "rate", kind: "rateCap" as const, rate: terms.rateCap }] : []),
        ...(terms.noChargeActivity ? [{ ...base, id: "nc", section: terms.noChargeRule ?? "", kind: "noCharge" as const, activityCode: terms.noChargeActivity }] : []),
        { ...base, id: "split", kind: "split" as const }, { ...base, id: "tenths", kind: "tenths" as const },
    ];
}

/** The day's lines: generic with no rulebook, else with the rulebook's rules that are on. */
export function billFor(w: Workspace, terms: InvoiceTerms, book: ClientRulebook | null): FeeLine[] {
    return book ? feeLines(w, terms, book.rules.filter((r) => r.enabled), { book }) : feeLines(w, terms, []);
}

// ---------------------------------------------------------------------------
// What an entry is

/** A call or a video conference: its time was all in a meeting app, or its narrative says so. */
export function isCall(e: TimeEntry): boolean {
    const work = e.work ?? [];
    return (work.length > 0 && work.every((x) => /teams|phone|zoom|webex|facetime|\bmeet\b/i.test(x.app))) || /^(teams|telephone|video|phone)\s+(conference|call)\b/i.test(e.description);
}
/** A conference between firm people (UTBMS A105). */
const isInternal = (e: TimeEntry): boolean => e.activityCode === "A105";

type Task = { text: string; minutes: number | null; hours: number | null; task: string | null; activity: string | null };
/** The tasks of a block-billed entry: its `tasks`, or its narrative split at semicolons with one work stretch each. */
function tasksOf(e: TimeEntry): Task[] | null {
    if (e.tasks && e.tasks.length > 1) {
        return e.tasks.map((t) => ({ text: t.text, minutes: t.stretch != null ? e.work?.[t.stretch]?.minutes ?? null : null, hours: t.hours ?? null, task: t.task ?? null, activity: t.activity ?? null }));
    }
    const parts = e.description.split(/;\s+/);
    if (parts.length > 1 && e.work && e.work.length === parts.length) return parts.map((t, n) => ({ text: t, minutes: e.work![n].minutes, hours: null, task: null, activity: null }));
    return null;
}

// ---------------------------------------------------------------------------
// The lines

/**
 * One line per task. With no rules each entry bills as recorded at its own rate. Each rule
 * changes the lines it applies to: tenths (off: hours to the hundredth), callCap, rateCap,
 * noCharge and notBilled, seniorOnly (checked, kept), split (one line per task, each with its
 * own captured time), blockWithTimes (one line, each task's time written in), codePrefix.
 */
export function feeLines(w: Workspace, terms: InvoiceTerms, rules: readonly ClientRule[] = [], opts: { book?: ClientRulebook | null; day?: string | null; scope?: BillScope | null } = {}): FeeLine[] {
    const book = opts.book ?? null;
    const has = (k: ClientRule["kind"]) => rules.find((r) => r.kind === k);
    // Hours are in tenths unless the client's tenths rule was switched off for this bill.
    const tenthsOff = rules.length > 0 && !has("tenths") && !!(book?.rules ?? w.clientRules?.rules)?.some((r) => r.kind === "tenths" && !r.enabled);
    const hoursOf = (minutes: number): number => (tenthsOff ? round2(minutes / 60) : tenths(minutes));
    const out: FeeLine[] = [];
    for (const e of billable(w, { ...opts.scope, ...(opts.day ? { day: opts.day } : {}) })) {
        const effects: LineEffect[] = [];
        const recorded = e.hours ?? tenths(seconds(e) / 60);
        const stdRate = e.hourlyRate;
        const stdAmount = e.billable ? round2(recorded * stdRate) : 0;
        const minutes = (e.work ?? []).reduce((n, x) => n + x.minutes, 0) || seconds(e) / 60;
        let hours = rules.length ? hoursOf(minutes) : recorded;
        if (rules.length && hours !== recorded) effects.push({ rule: has("tenths")?.id ?? "tenths", what: "hours", before: hrs(recorded), after: hrs(hours) });
        const call = has("callCap");
        if (call?.maxHours != null && isCall(e) && hours > call.maxHours + 1e-9) {
            effects.push({ rule: call.id, what: "hours", before: hrs(hours), after: hrs(call.maxHours) });
            hours = call.maxHours;
        }
        const cap = has("rateCap");
        const rate = cap?.rate && stdRate > cap.rate ? cap.rate : stdRate;
        if (cap && rate !== stdRate) effects.push({ rule: cap.id, what: "rate", before: moneyShort(stdRate), after: moneyShort(rate) });
        const nc = rules.find((r) => r.kind === "noCharge" && r.activityCode && e.activityCode === r.activityCode);
        const nb = rules.find((r) => r.kind === "notBilled" && (r.words ?? []).some((x) => e.description.toLowerCase().includes(x.toLowerCase()) || (e.group ?? "").toLowerCase().includes(x.toLowerCase())));
        const why = nc ?? nb;
        if (why) effects.push({ rule: why.id, what: "noCharge", before: money(stdAmount), after: "No charge" });
        const senior = has("seniorOnly");
        if (senior && !why && isInternal(e)) effects.push({ rule: senior.id, what: "kept", text: `Billable for ${terms.timekeeper.name}, the senior attendee` });
        const noCharge = !!why || !e.billable;
        const note = why ? `No charge per ${citeOf(why, w, book)}` : !e.billable ? "No charge" : null;
        const prefix = has("codePrefix");
        const codeFor = (task: string | null, activity: string | null): string | null =>
            prefix ? ((prefix.code === "activity" ? activity ?? e.activityCode : task ?? e.taskCode) || null) : null;
        const withCode = (code: string | null, segs: Segment[], lineEffects: LineEffect[]): Segment[] => {
            if (!code || !prefix) return segs;
            lineEffects.push({ rule: prefix.id, what: "text", text: `${code} added in front` });
            return [{ text: `${code} `, ins: prefix.id }, ...segs];
        };
        const base = { entryID: e.id, date: usDate(e.startedAt), timekeeper: terms.timekeeper.name, rate, noCharge, note, stdHours: recorded, stdRate, stdAmount, stdDescription: sentence(e.description) };
        const line = (segments: Segment[], h: number, lineEffects: LineEffect[], split: FeeLine["split"] = null): FeeLine => ({
            ...base, segments, description: segments.map((s) => s.text).join(""), hours: h, amount: noCharge ? 0 : round2(h * rate),
            effects: lineEffects, changes: [...new Set(lineEffects.filter((x) => x.what !== "kept").map((x) => x.rule))], split,
        });
        const tasks = tasksOf(e);
        const taskHours = tasks?.map((t) => t.hours ?? (t.minutes != null ? hoursOf(t.minutes) : null)) ?? null;
        const timed = !!tasks && !!taskHours && taskHours.every((h) => h != null);
        const split = has("split");
        const block = has("blockWithTimes");
        if (split && timed) {
            // One line per task, each with the time Time Capture recorded for it.
            const splitEffect: LineEffect = { rule: split.id, what: "split", before: hrs(hours), after: taskHours!.map((h) => hrs(h!)).join(" + ") };
            tasks!.forEach((t, n) => {
                const lineEffects = [...effects, splitEffect];
                out.push(line(withCode(codeFor(t.task, t.activity), [{ text: sentence(t.text) }], lineEffects), taskHours![n]!, lineEffects, { part: n, of: tasks!.length, full: e.description }));
            });
        } else if (block && timed) {
            // One line, each task's time written in after it: "Research ... (0.7); review ... (0.9)."
            const lineEffects = [...effects];
            const segs: Segment[] = [];
            // A later task reads on after the semicolon as the seed wrote it ("; review and revise ..."): a name stays a name.
            tasks!.forEach((t, n) => {
                const text = t.text.trim().replace(/[.;]+$/, "");
                segs.push({ text: n === 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : `; ${text}` });
                segs.push({ text: ` (${taskHours![n]!.toFixed(1)})`, ins: block.id });
            });
            segs.push({ text: "." });
            const sum = round2(taskHours!.reduce((n, h) => n + h!, 0));
            if (sum !== hours) lineEffects.push({ rule: block.id, what: "hours", before: hrs(hours), after: hrs(sum) });
            lineEffects.push({ rule: block.id, what: "text", text: `Each task's time written in: ${taskHours!.map((h) => `(${h!.toFixed(1)})`).join(" and ")}` });
            out.push(line(withCode(codeFor(null, null), segs, lineEffects), sum, lineEffects));
        } else {
            const lineEffects = [...effects];
            out.push(line(withCode(codeFor(null, null), [{ text: sentence(e.description) }], lineEffects), hours, lineEffects));
        }
    }
    return out;
}

export function totals(lines: readonly FeeLine[]): { hours: number; billedHours: number; fees: number } {
    return {
        hours: round2(lines.reduce((n, l) => n + l.hours, 0)),
        billedHours: round2(lines.filter((l) => !l.noCharge).reduce((n, l) => n + l.hours, 0)),
        fees: round2(lines.reduce((n, l) => n + l.amount, 0)),
    };
}

/** What one rule does to today's entries on its own: each entry it touches, the lines before and after, and its effects. */
export function ruleEffects(w: Workspace, terms: InvoiceTerms, rule: ClientRule, book?: ClientRulebook | null): { entryID: string; before: FeeLine[]; after: FeeLine[]; effects: LineEffect[] }[] {
    // The entries as the bill shapes them under the client's other rules that are on (split into tasks, or each task's
    // time written in), so a rule's change shows on the lines the bill prints: a code in front of each split task.
    const shape = (book?.rules ?? []).filter((r) => r.enabled && r.id !== rule.id && (r.kind === "split" || r.kind === "blockWithTimes"));
    const before = feeLines(w, terms, shape, { book });
    const after = feeLines(w, terms, [...shape, { ...rule, enabled: true }], { book });
    const ids = [...new Set(before.map((l) => l.entryID))];
    return ids.map((id) => {
        const a = after.filter((l) => l.entryID === id);
        const seen = new Set<string>();
        const effects = a.flatMap((l) => l.effects).filter((x) => x.rule === rule.id && !seen.has(JSON.stringify(x)) && seen.add(JSON.stringify(x)));
        return { entryID: id, before: before.filter((l) => l.entryID === id), after: a, effects };
    }).filter((x) => x.effects.length);
}

/** The bill without and with a rulebook's rules that are on. */
export function rulesTotals(w: Workspace, terms: InvoiceTerms, book: ClientRulebook | null): { standard: number; withRules: number; hours: number } {
    const t = totals(billFor(w, terms, book));
    return { standard: totals(billFor(w, terms, null)).fees, withRules: t.fees, hours: t.billedHours };
}
