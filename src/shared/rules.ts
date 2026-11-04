/* A client's billing rules, checked when a time entry is written or edited. Pure.

   The rules come from the billing system (Lawdie billing exports each client's approved
   rules; src/main/rulesFeed.ts pulls them), so a rule approved there after a client
   rejects an invoice reaches this app and the next entry is checked against it. Each
   finding cites the rule's clause and, when the rule came from the client's rejection or a
   client note rather than the guidelines, says so. Most findings carry a fix: accepting it
   changes the entry (the narrative, the hours, the codes, the rate, the billable flag), or
   splits a block-billed day into one entry per task by the captured time of each.

   The wire format is the billing lane's rules-export.json: { client, clientId, matter,
   guidelines, version, exportedAt, timekeepers?, rules: [{ id, clause, title, text, check,
   template?, params, source, sourceRef, approvedAt, act, atEntry }] }. Check types are
   named after the billing engine's templates (BLK01 → block_billing), so either may be
   given. A rule with an unknown check, or one marked atEntry: false, is listed but checked
   at pre-bill only. */

import type { Activity, Workspace } from "./model";
import { tasksOf, type Task } from "./narrative";

export type Person = {
    name: string;
    /** Whose side they are on; "firm" people are colleagues (an internal conference). */
    side: "firm" | "client" | "counterparty" | "other";
    role?: string;
    /** Other ways capture may write the name ("Simon Achterberg" for "Dr. Simon Achterberg"). */
    aliases?: string[];
    /** A role, not a person ("Corvane counsel"): written as given. */
    label?: boolean;
    /** Their billing rate, for a rule that moves work to their rate. */
    rate?: number;
};

export type MatterContext = {
    /** "104882-0001". */
    number: string;
    client: string;
    clientId?: string;
    /** The UTBMS code set the client wants: project (P), counseling (C) or litigation (L). */
    codeSet?: "project" | "counseling" | "litigation";
    defaultTask?: string;
    /** The matter's main document, for a narrative that must name one. */
    document?: string;
    people: Person[];
    /** Part of a file name → what to call it in a narrative ("Corvane_DLA" → "Corvane data license agreement"). */
    glossary: Record<string, string>;
};

export type Profile = { name: string; timekeeper: string; title?: string; rate?: number };

export type RuleSource = "guidelines" | "client-note" | "rejection" | "firm";

export type Rule = {
    id: string;
    clause: string;
    title: string;
    /** The rule in the client's words. */
    text: string;
    check: string;
    template?: string;
    params: Record<string, unknown>;
    source: RuleSource;
    /** Where it came from in words: "Lauren Mbeki's rejection of invoice 2026-1031, Nov 4". */
    sourceRef: string | null;
    approvedAt: string | null;
    atEntry: boolean;
};

export type RuleSet = {
    client: string;
    clientId: string;
    matter: string | null;
    guidelines: string;
    version: string;
    exportedAt: string;
    rules: Rule[];
    /** Timekeepers' approved rates for this client (a rate freeze), and who work may move to. */
    timekeepers?: { id: string; name: string; rate: number }[];
    /** When this app took it, and the rules that were not in the version before (shown as new). */
    receivedAt?: string;
    newRuleIds?: string[];
};

/** The billing engine's template ids, as check types. */
const TEMPLATE_CHECKS: Record<string, string> = {
    INC01: "time_increment", BLK01: "block_billing", INV02: "task_codes", NB01: "internal_conference", PH01: "separate_phase",
    NB07: "research_threshold", TRV01: "travel_rate", TK06: "clerical_work", RTE02: "rate_freeze", NAR01: "vague_narrative",
    NAR02: "vague_narrative", A3: "vague_narrative", RTE05: "task_rate_cap", INC03: "merge_short_emails", NAR04: "name_document",
    NAR03: "name_participants", EXP06: "expense_receipt",
};
/** Other spellings of the same checks. */
const CHECK_ALIASES: Record<string, string> = {
    increment: "time_increment", task_code_required: "task_codes", rate_cap: "task_rate_cap", research_rate_cap: "task_rate_cap",
    short_email_merge: "merge_short_emails", min_email_entry: "merge_short_emails", document_named: "name_document", identify_document: "name_document",
    name_the_document: "name_document",
};
export const CHECKS = new Set(["time_increment", "block_billing", "task_codes", "internal_conference", "separate_phase", "research_threshold", "travel_rate", "clerical_work", "rate_freeze", "vague_narrative", "task_rate_cap", "merge_short_emails", "name_document", "name_participants"]);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback);
const SOURCES = new Set<RuleSource>(["guidelines", "client-note", "rejection", "firm"]);
/** The billing engine's source stages (rules-export.json `source.stage`) as this app's sources. */
const STAGES: Record<string, RuleSource> = { guidelines: "guidelines", ocg: "guidelines", client_note: "client-note", "client-note": "client-note", note: "client-note", rejection: "rejection", firm: "firm" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Lauren Mbeki's email" and 2026-10-16 → "Lauren Mbeki's email, Oct 16"; a doc that already names its day stays. */
function sourceRefOf(doc: string, date: string): string | null {
    if (!doc) return null;
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
    if (!d || new RegExp(`\\b(${MONTHS.join("|")})\\b`).test(doc)) return doc;
    return `${doc}, ${MONTHS[Number(d[2]) - 1]} ${Number(d[3])}`;
}

/** A rules export (or one of the feed's rule sets) as this app holds it; throws when it is not one.
 *  Takes both this app's camelCase and the billing engine's export (client: {id, name},
 *  check_type, parameters, applies_at_entry, source: {stage, doc, date}). */
export function normalizeRuleSet(raw: unknown): RuleSet {
    const r = (raw ?? {}) as Record<string, unknown>;
    const list = Array.isArray(r.rules) ? (r.rules as Record<string, unknown>[]) : null;
    const clientObj = r.client && typeof r.client === "object" ? (r.client as Record<string, unknown>) : null;
    const clientId = str(r.clientId ?? r.client_id ?? clientObj?.id);
    if (!list || !clientId) throw new Error("The rules feed sent something that is not a client's rule set.");
    const rules: Rule[] = list.filter((x) => str(x.status, "active") === "active").map((x) => {
        const template = str(x.template) || (TEMPLATE_CHECKS[str(x.check_type)] ? str(x.check_type) : "") || undefined;
        const rawCheck = str(x.check ?? x.check_type ?? x.checkType);
        const check = CHECK_ALIASES[rawCheck] ?? (CHECKS.has(rawCheck) || rawCheck === "expense_receipt" ? rawCheck : (template && TEMPLATE_CHECKS[template]) || rawCheck || "other");
        const src = x.source && typeof x.source === "object" ? (x.source as Record<string, unknown>) : null;
        const source = src ? STAGES[str(src.stage)] ?? "guidelines" : (str(x.source, "guidelines") as RuleSource);
        return {
            id: str(x.id ?? x.iid), clause: str(x.clause), title: str(x.title ?? x.name) || str(x.text).split(/[.:]/)[0].slice(0, 80),
            text: str(x.text), check, ...(template ? { template } : {}),
            params: (x.params ?? x.parameters ?? {}) as Record<string, unknown>,
            source: SOURCES.has(source) ? source : "guidelines",
            sourceRef: str(x.sourceRef ?? x.source_ref) || (src && source !== "guidelines" ? sourceRefOf(str(src.doc), str(src.date)) : null),
            approvedAt: str(x.approvedAt ?? x.approved_at ?? src?.date) || null,
            atEntry: (x.atEntry ?? x.at_entry ?? x.applies_at_entry) !== false,
        };
    }).filter((x) => x.id && x.text);
    const timekeepers = Array.isArray(r.timekeepers) ? (r.timekeepers as Record<string, unknown>[]).map((t) => ({ id: str(t.id ?? t.tk_id), name: str(t.name), rate: Number(t.rate ?? t.approved_rate ?? 0) })).filter((t) => t.id && Number.isFinite(t.rate)) : undefined;
    const matters = Array.isArray(r.matters) ? (r.matters as unknown[]).map((m) => str(m)).filter(Boolean) : [];
    return {
        client: str(clientObj?.name ?? r.client ?? r.client_name, clientId), clientId, matter: str(r.matter) || (matters.length === 1 ? matters[0] : null), guidelines: str(r.guidelines, "Billing guidelines"),
        version: str(r.version, "1"), exportedAt: str(r.exportedAt ?? r.exported_at), rules, ...(timekeepers ? { timekeepers } : {}),
    };
}

/** A new rule set replaces the client's old one; rules it did not have before are marked new. */
export function upsertRulebook(w: Workspace, next: RuleSet, now: number): { added: Rule[]; removed: Rule[]; changed: boolean } {
    const books = (w.rulebooks ??= []);
    const at = books.findIndex((b) => b.clientId === next.clientId);
    const before = at >= 0 ? books[at] : null;
    if (before && before.version === next.version && JSON.stringify(before.rules) === JSON.stringify(next.rules)) return { added: [], removed: [], changed: false };
    const had = new Set(before?.rules.map((x) => x.id) ?? []);
    const has = new Set(next.rules.map((x) => x.id));
    const added = before ? next.rules.filter((x) => !had.has(x.id)) : [];
    const removed = before ? before.rules.filter((x) => !has.has(x.id)) : [];
    const book: RuleSet = { ...next, receivedAt: new Date(now).toISOString(), newRuleIds: before ? [...new Set([...(before.newRuleIds ?? []).filter((id) => has.has(id)), ...added.map((x) => x.id)])] : [] };
    if (at >= 0) books[at] = book; else books.push(book);
    return { added, removed, changed: true };
}

/** The firm's own time entry standard: a rule set under this client id applies to every matter. */
export const FIRM_RULES = "firm";

/** The rule set for a matter: its client's (by client id, else by name), with the firm's standard after it. */
export function rulebookFor(w: Workspace, ctx: MatterContext | null | undefined, clientName?: string | null): RuleSet | null {
    const books = w.rulebooks ?? [];
    const client = books.find((b) => b.clientId !== FIRM_RULES && ctx?.clientId && b.clientId === ctx.clientId)
        ?? books.find((b) => { const n = (ctx?.client ?? clientName ?? "").trim().toLowerCase(); return b.clientId !== FIRM_RULES && !!n && b.client.trim().toLowerCase() === n; })
        ?? null;
    const firm = books.find((b) => b.clientId === FIRM_RULES) ?? null;
    if (!client || !firm) return client ?? firm;
    return { ...client, rules: [...client.rules, ...firm.rules.filter((r) => !client.rules.some((c) => c.id === r.id))] };
}

/** "Lauren Mbeki's rejection of invoice 2026-1031" for a rule from a rejection; the clause for the guidelines. */
export function sourceLabel(rule: Rule, book: RuleSet | null): string {
    if (rule.source === "rejection") return rule.sourceRef ? `From ${rule.sourceRef}` : "From the client's rejection";
    if (rule.source === "client-note") return rule.sourceRef ? `From ${rule.sourceRef}` : "From a client note";
    if (rule.source === "firm") return `${rule.sourceRef ?? "Firm time entry standard"}${rule.clause ? ` ${rule.clause}` : ""}`;
    return `${book?.guidelines ?? "Billing guidelines"} ${rule.clause}`.trim();
}

/** A rule the client added after a rejection or in a note: what the app labels new. */
export const fromClient = (rule: Rule): boolean => rule.source === "rejection" || rule.source === "client-note";

// ---------------------------------------------------------------------------
// Checking an entry
// ---------------------------------------------------------------------------

/** What a rule looks at: an entry being kept or edited. */
export type EntryDraft = {
    id?: string;
    description: string;
    hours: number;
    taskCode?: string;
    activityCode?: string;
    billable: boolean;
    hourlyRate: number;
    /** Local day, YYYY-MM-DD. */
    day: string;
};

export type EntryChange = Partial<Pick<EntryDraft, "description" | "hours" | "taskCode" | "activityCode" | "billable" | "hourlyRate">>;

export type Fix = {
    /** The button: "Split into 5 entries by captured time", "Bill 0.4 h". */
    label: string;
    change: EntryChange;
    /** Split the entry into one per captured task. */
    split?: boolean;
    /** Fold the entry into this kept entry (one email entry for the day). */
    foldInto?: string;
};

export type Finding = {
    rule: Rule;
    /** What is wrong with this entry, in a sentence. */
    message: string;
    /** The clause and where the rule came from. */
    cite: string;
    /** The rule came from the client after the guidelines (a rejection or a note). */
    fromClient: boolean;
    /** Not in the rule set the app had before the last update. */
    isNew: boolean;
    fixes: Fix[];
};

export type CheckContext = {
    book: RuleSet | null;
    ctx: MatterContext | null;
    profile: Profile | null;
    /** Other entries kept on the same matter and day (for one email entry a day). */
    sameDay?: EntryDraft[];
    /** The narrative the captured activity gives, offered for a vague one. */
    suggestion?: string | null;
    /** How many captured tasks the entry holds: a block-billed entry splits into these. */
    splitCount?: number;
};

const TASK_VERBS = /^(review|revise|draft|prepare|research|call|calls|email|emails|e-mail|conference|confer|meet|meeting|attend|analy[sz]e|discuss|edit|redline|finalize|outline|negotiate|correspond|telephone|travel|organize|scan|file|update|summarize|work)\b/i;
const VAGUE = ["work on", "attention to", "review file", "follow up", "follow-up", "prepare", "research", "conference", "analysis", "email", "emails", "call", "review", "draft", "revise"];
const DOCUMENT_NOUNS = /\b(agreement|exhibit|memo|memorandum|letter|amendment|addendum|schedule|checklist|policy|license|licence|contract|baa|brief|motion|questionnaire|term sheet|issues list|statement of work|sow|nda|redline of the|signature pages?|deck|report|opinion)\b/i;
const REVIEW_VERBS = /^(draft|revise|review|redline|prepare|finalize|edit|mark up|markup|proofread|update)\b/i;

const PROJECT_TASKS = new Set(["P100", "P200", "P210", "P220", "P230", "P240", "P250", "P260", "P270", "P280", "P300", "P400", "P500", "P600", "P700", "P800"]);
const COUNSELING_TASKS = new Set(["C100", "C200", "C300", "C400"]);
const LITIGATION_TASK = /^L\d{3}$/;
const ACTIVITIES = new Set(["A101", "A102", "A103", "A104", "A105", "A106", "A107", "A108", "A109", "A110", "A111"]);

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const tenths = (h: number) => Math.abs(Math.round(h * 10) - h * 10) < 1e-6;
export const roundUpToTenth = (h: number) => Math.ceil(h * 10 - 1e-6) / 10;
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const listParam = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback);
const numParam = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** The tasks a narrative lists: parts split on ";" always and on "," when the client counts commas, each starting with a task verb. */
export function taskCount(description: string, separators = ";"): number {
    const parts = description.split(separators.includes(",") ? /[;,]/ : /;/).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) return parts.length;
    const verbs = parts.filter((p) => TASK_VERBS.test(p)).length;
    return separators.includes(",") ? (verbs === parts.length ? parts.length : description.split(";").filter((p) => p.trim()).length) : parts.length;
}

const isResearch = (d: EntryDraft) => /^research\b/i.test(d.description.trim()) || /\bresearch(ed|ing)?\b/i.test(d.description) || d.activityCode === "A102";
const isEmail = (d: EntryDraft) => /^(e-?mails?|correspond)/i.test(d.description.trim());

/** The codes a narrative suggests, for a fix that adds them. */
export function suggestCodes(d: EntryDraft, ctx: MatterContext | null): { taskCode: string; activityCode: string } {
    const text = d.description.trim();
    const set = ctx?.codeSet ?? "project";
    const task = set === "counseling" ? (isResearch(d) ? "C200" : "C300") : set === "litigation" ? "L120" : isResearch(d) ? "P300" : ctx?.defaultTask ?? "P500";
    const firm = (ctx?.people ?? []).some((p) => p.side === "firm" && text.toLowerCase().includes(p.name.split(/\s+/).pop()!.toLowerCase()));
    const activity = isResearch(d) ? "A102" : /^(draft|revise|redline|edit|prepare|finalize)/i.test(text) ? "A103" : /^review/i.test(text) ? "A104"
        : /^(conference|meet|call|telephone|email|emails|correspond)/i.test(text) ? (firm ? "A105" : /mbeki|client/i.test(text) || (ctx?.people ?? []).some((p) => p.side === "client" && text.includes(p.name.split(/\s+/).pop()!)) ? "A106" : "A107") : "A111";
    return { taskCode: d.taskCode && validTask(d.taskCode, set) ? d.taskCode : task, activityCode: d.activityCode && ACTIVITIES.has(d.activityCode) ? d.activityCode : activity };
}

function validTask(code: string, set: MatterContext["codeSet"]): boolean {
    if (set === "counseling") return COUNSELING_TASKS.has(code);
    if (set === "litigation") return LITIGATION_TASK.test(code);
    return PROJECT_TASKS.has(code);
}

/** Every finding of the client's rules on one entry, in the rule set's order. */
export function checkEntry(d: EntryDraft, c: CheckContext): Finding[] {
    const book = c.book;
    if (!book) return [];
    const out: Finding[] = [];
    const firstNames = (c.ctx?.people ?? []);
    for (const rule of book.rules) {
        if (!rule.atEntry || !CHECKS.has(rule.check)) continue;
        const p = rule.params;
        const add = (message: string, fixes: Fix[] = []) => out.push({ rule, message, cite: sourceLabel(rule, book), fromClient: fromClient(rule), isNew: (book.newRuleIds ?? []).includes(rule.id), fixes });
        const text = d.description.trim();
        switch (rule.check) {
            case "time_increment": {
                const incr = numParam(p.incr, 0.1);
                if (incr === 0.1 ? !tenths(d.hours) : Math.abs(Math.round(d.hours / incr) * incr - d.hours) > 1e-6) {
                    const up = incr === 0.1 ? roundUpToTenth(d.hours) : Math.ceil(d.hours / incr - 1e-6) * incr;
                    add(`${d.hours} h is not in tenths of an hour.`, [{ label: `Bill ${up.toFixed(1)} h`, change: { hours: up } }]);
                }
                break;
            }
            case "block_billing": {
                const n = taskCount(text, str(p.separators, ";"));
                if (n > numParam(p.max_tasks, 1)) {
                    const split = (c.splitCount ?? 0) >= 2;
                    add(`Lists ${n} tasks in one entry.`, split ? [{ label: `Split into ${c.splitCount} entries by captured time`, change: {}, split: true }] : []);
                }
                break;
            }
            case "task_codes": {
                const set = c.ctx?.codeSet ?? "project";
                const bad = !d.taskCode || !validTask(d.taskCode, set) || !d.activityCode || !ACTIVITIES.has(d.activityCode);
                if (bad) {
                    const s = suggestCodes(d, c.ctx);
                    const what = !d.taskCode && !d.activityCode ? "No UTBMS task or activity code." : !d.taskCode || !validTask(d.taskCode, set) ? `Task code ${d.taskCode || "missing"} is not in the ${set} code set.` : `Activity code ${d.activityCode || "missing"} is not a UTBMS activity code.`;
                    add(what, [{ label: `Use ${s.taskCode} / ${s.activityCode}`, change: s }]);
                }
                break;
            }
            case "internal_conference": {
                if (!d.billable) break;
                if (!/\b(conference|confer|meeting|meet|call|discuss(ion)?|chat)\b/i.test(text)) break;
                const named = firstNames.filter((x) => x.name !== c.profile?.name && !x.label && text.toLowerCase().includes(x.name.split(/\s+/).pop()!.toLowerCase()));
                if (named.length && named.every((x) => x.side === "firm")) add(`A conference with ${named.map((x) => x.name).join(" and ")} is between firm timekeepers.`, [{ label: "Mark no charge", change: { billable: false } }]);
                break;
            }
            case "separate_phase": {
                const kw = listParam(p.kw, []);
                const task = str(p.task);
                if (task && kw.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) && d.taskCode !== task) {
                    add(`${str(p.label, "This work")} goes under task code ${task}${d.taskCode ? `, not ${d.taskCode}` : ""}.`, [{ label: `Use ${task}`, change: { taskCode: task } }]);
                }
                break;
            }
            case "research_threshold": {
                const max = numParam(p.max_hrs, 5);
                const total = d.hours + (c.sameDay ?? []).filter((o) => o.id !== d.id && isResearch(o)).reduce((n, o) => n + o.hours, 0);
                if (isResearch(d) && total > max) add(`${total.toFixed(1)} h of research is over ${max.toFixed(1)} h and needs the client's written approval first.`, [{ label: `Bill ${Math.max(0, max - (total - d.hours)).toFixed(1)} h`, change: { hours: Math.max(0, max - (total - d.hours)) } }]);
                break;
            }
            case "travel_rate": {
                const pct = numParam(p.pct, 50);
                const full = c.profile?.rate ?? d.hourlyRate;
                if (/^travel\b/i.test(text) && d.hourlyRate > full * pct / 100 + 0.01) add(`Travel is billed at ${pct}% of the rate.`, [{ label: `Bill at ${money(full * pct / 100)}/h`, change: { hourlyRate: Math.round(full * pct) / 100 } }]);
                break;
            }
            case "clerical_work": {
                const kw = listParam(p.kw, ["scan", "copy", "organize", "collate", "calendar", "docket"]);
                if (d.billable && kw.some((k) => new RegExp(`^${k}`, "i").test(text))) add("Clerical work is firm overhead.", [{ label: "Mark no charge", change: { billable: false } }]);
                break;
            }
            case "rate_freeze": {
                const approved = book.timekeepers?.find((t) => t.id === c.profile?.timekeeper)?.rate;
                if (approved !== undefined && d.hourlyRate > approved + 0.01) add(`${money(d.hourlyRate)}/h is above the frozen rate of ${money(approved)}/h.`, [{ label: `Bill at ${money(approved)}/h`, change: { hourlyRate: approved } }]);
                break;
            }
            case "vague_narrative": {
                const terms = listParam(p.terms, VAGUE);
                const min = numParam(p.min_words, 4);
                const lowerText = text.toLowerCase().replace(/[.]+$/, "");
                const vague = words(text).length < min || terms.some((t) => lowerText === t || (lowerText.startsWith(t + " ") && words(lowerText.slice(t.length)).length <= 2));
                if (vague) add(`"${text || "(empty)"}" does not say what was done, on what, or why.`, c.suggestion && c.suggestion !== text ? [{ label: "Use the narrative from capture", change: { description: c.suggestion } }] : []);
                break;
            }
            case "name_document": {
                if (!REVIEW_VERBS.test(text) || DOCUMENT_NOUNS.test(text)) break;
                const doc = c.ctx?.document;
                const fixed = doc ? (/\bdraft\b/i.test(text.replace(REVIEW_VERBS, "")) ? text.replace(/(?<=\s)draft\b/i, doc) : text.replace(REVIEW_VERBS, (v) => `${v} ${doc}`)) : null;
                const sugg = c.suggestion && DOCUMENT_NOUNS.test(c.suggestion) ? c.suggestion : null;
                add("A drafting entry must name the document.", fixed ? [{ label: "Name the document", change: { description: fixed } }] : sugg ? [{ label: "Use the narrative from capture", change: { description: sugg } }] : []);
                break;
            }
            case "name_participants": {
                if (/^(call|conference|meet|meeting|email|emails|telephone)\b/i.test(text) && !/\bwith\b|\bre\b/i.test(text)) add("Calls, emails and meetings name the other party and the topic.", c.suggestion ? [{ label: "Use the narrative from capture", change: { description: c.suggestion } }] : []);
                break;
            }
            case "task_rate_cap": {
                const task = str(p.task).trim() || "research";
                const cap = numParam(p.cap, 0);
                const ofKind = task === "research" ? isResearch(d) : new RegExp(`\\b${task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
                if (cap > 0 && ofKind && d.billable && d.hourlyRate > cap + 0.01) {
                    const fixes: Fix[] = [{ label: `Bill at ${money(cap)}/h, the cap`, change: { hourlyRate: cap } }];
                    const to = str(p.reassign_to).toLowerCase();
                    const who = to ? (book.timekeepers ?? []).find((t) => t.name.toLowerCase().includes(to)) ?? (c.ctx?.people ?? []).filter((x) => x.rate).map((x) => ({ name: x.name, rate: x.rate! })).find((x) => x.name.toLowerCase().includes(to)) : undefined;
                    if (who && who.rate < cap) fixes.push({ label: `Bill at ${who.name.split(/\s+/)[0]}'s rate, ${money(who.rate)}/h`, change: { hourlyRate: who.rate } });
                    add(`${task[0].toUpperCase()}${task.slice(1)} at ${money(d.hourlyRate)}/h is above the ${money(cap)}/h cap.`, fixes);
                }
                break;
            }
            case "merge_short_emails": {
                const max = numParam(p.max_hrs, 0.1);
                if (!isEmail(d) || d.hours > max + 1e-6) break;
                const other = (c.sameDay ?? []).find((o) => o.id !== d.id && o.id && isEmail(o) && o.hours <= max + 1e-6);
                if (other) add(`Emails of ${max} h or less are billed as one entry for the day.`, [{ label: "Fold into the day's email entry", change: { hours: Math.round((other.hours + d.hours) * 10) / 10, description: other.description }, foldInto: other.id }]);
                break;
            }
        }
    }
    return out;
}

/** An entry with a fix applied. */
export const applyFix = (d: EntryDraft, fix: Fix): EntryDraft => ({ ...d, ...fix.change });

/** The rules that looked at this entry and found nothing: what "meets the client's rules" lists. */
export function rulesMet(d: EntryDraft, c: CheckContext): Rule[] {
    const flagged = new Set(checkEntry(d, c).map((f) => f.rule.id));
    return (c.book?.rules ?? []).filter((r) => r.atEntry && CHECKS.has(r.check) && !flagged.has(r.id));
}

// ---------------------------------------------------------------------------
// Splitting a matter's day into one entry per task
// ---------------------------------------------------------------------------

export type PlanLine = { activityIDs: string[]; seconds: number; task: Task; draft: EntryDraft; /** Fold this line into a kept entry (one email entry a day) instead of keeping it apart. */ foldInto?: string };

/** One line per captured task, in time order: its narrative from capture, its own minutes rounded up to the tenth, its codes. */
export function splitPlan(activities: readonly Activity[], ctx: MatterContext | null, profile: Profile | null, base: { billable: boolean; hourlyRate: number; day: string }): PlanLine[] {
    return tasksOf(activities, ctx, profile?.name ?? null).map((t) => ({
        activityIDs: t.activityIDs, seconds: t.seconds, task: t,
        draft: { description: t.text, hours: Math.max(0.1, roundUpToTenth(t.seconds / 3600)), taskCode: t.taskCode, activityCode: t.activityCode, billable: base.billable, hourlyRate: base.hourlyRate, day: base.day },
    }));
}
