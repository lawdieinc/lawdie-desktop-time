/* A client's billing rules made in the app (2026-11-04). Before this, a rulebook only arrived
   from a demo seed or the rules feed. Pure: the rulebook and rule records, the ten kinds a rule
   can be with what each needs, the sentence that says what a rule does, and the keep-time rule
   set derived from a rulebook so the Keep sheet checks an entry against rules made here too.
   src/shared/invoice.ts applies the rules to a bill; src/shared/rules.ts checks an entry. */

import { WorkspaceError, type ClientRule, type ClientRulebook, type Workspace } from "./model";
import type { Rule, RuleSet } from "./rules";

export type RuleKind = ClientRule["kind"];
export type RuleCheck = NonNullable<ClientRule["check"]>;

/** What a kind of rule needs from the person besides the client's words. */
export type RuleKindInfo = { kind: RuleKind; label: string; needs: "rate" | "activityCode" | "words" | "maxHours" | "code" | "check" | null; hint: string };

export const RULE_KINDS: readonly RuleKindInfo[] = [
    { kind: "tenths", label: "Tenth-hour increments", needs: null, hint: "Each entry's minutes round up to the next tenth of an hour." },
    { kind: "rateCap", label: "Rate cap", needs: "rate", hint: "No hour bills above this rate (an engagement-letter or panel rate)." },
    { kind: "callCap", label: "Cap on calls", needs: "maxHours", hint: "A call or video conference bills at most this many hours." },
    { kind: "noCharge", label: "No charge by activity code", needs: "activityCode", hint: "Entries with this UTBMS activity code (A105 for internal conferences) stay on the bill at $0.00." },
    { kind: "notBilled", label: "Not billed by words", needs: "words", hint: "Entries whose narrative contains any of these words bill at no charge." },
    { kind: "split", label: "One task per entry", needs: null, hint: "A block-billed entry becomes one line per task, each with its own captured time." },
    { kind: "blockWithTimes", label: "Time written in per task", needs: null, hint: "A block-billed entry stays one line, with each task's time written after it." },
    { kind: "codePrefix", label: "Code in front of the narrative", needs: "code", hint: "Each line starts with its UTBMS task or activity code." },
    { kind: "seniorOnly", label: "Senior attendee bills a conference", needs: null, hint: "An internal conference is billable for the senior attendee only; Lawdie notes it on the line." },
    { kind: "check", label: "A check on every entry", needs: "check", hint: "Lawdie checks each entry and says which pass and which do not; the bill is not changed." },
];

export const RULE_CHECKS: readonly { check: RuleCheck; label: string; hint: string }[] = [
    { check: "vague", label: "No vague narratives", hint: "An entry must say what was done, on what, and with whom." },
    { check: "oneAttendee", label: "One timekeeper per meeting", hint: "Only one timekeeper bills a meeting." },
    { check: "researchCap", label: "Research needs approval over a limit", hint: "Research over the hours given needs the client's written approval." },
    { check: "clerical", label: "No clerical work", hint: "Scanning, copying, organizing and calendaring are overhead." },
    { check: "travel", label: "Travel at a reduced rate", hint: "Travel time bills at half rate." },
    { check: "timekeepers", label: "Approved timekeepers only", hint: "Only the timekeepers listed may bill this client." },
];

const MONEY = (n: number): string => `$${n.toLocaleString("en-US")}`;

/** "Bills no hour above $1,075.": what a rule does, from its kind and figures, when the person wrote nothing themselves. */
export function describeRule(r: Pick<ClientRule, "kind"> & Partial<ClientRule>): string {
    switch (r.kind) {
        case "tenths": return "Rounds each entry's recorded minutes up to the next tenth of an hour.";
        case "rateCap": return r.rate ? `Bills no hour above ${MONEY(r.rate)}.` : "Caps the hourly rate.";
        case "callCap": return r.maxHours ? `Bills a call or video conference at no more than ${r.maxHours} ${r.maxHours === 1 ? "hour" : "hours"}.` : "Caps the hours a call may bill.";
        case "noCharge": return `Keeps entries coded ${r.activityCode ?? "with that activity code"} on the bill at no charge.`;
        case "notBilled": return `Bills at no charge any entry whose narrative mentions ${(r.words ?? []).map((x) => `“${x}”`).join(", ") || "those words"}.`;
        case "split": return "Splits a block-billed entry into one line per task, each with the time Time Capture recorded for it.";
        case "blockWithTimes": return "Writes each task's time into a block-billed entry's narrative.";
        case "codePrefix": return `Puts the UTBMS ${r.code === "activity" ? "activity" : "task"} code in front of each line's narrative.`;
        case "seniorOnly": return "Keeps an internal conference billable for the senior attendee and notes it on the line.";
        case "check": return RULE_CHECKS.find((c) => c.check === r.check)?.hint ?? "Checks each entry against this rule.";
    }
}

const TEXT_MAX = 300;
const QUOTE_MAX = 800;
export const CHECK_WORDS = {
    clerical: ["scan", "copy", "organize", "collate", "calendar", "docket", "clerical", "administrative"],
    travel: ["travel"],
};
const text = (v: unknown, max = TEXT_MAX): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => text(x, 80)).filter(Boolean).slice(0, 20) : []);
const books = (w: Workspace): ClientRulebook[] => (w.clientRulebooks ??= []);

/** "Northlake Behavioral Health, Inc." → "northlake-behavioral-health-inc", made unique among the books. */
function keyFor(w: Workspace, client: string): string {
    const base = client.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
    let key = base;
    for (let n = 2; books(w).some((b) => b.key === key); n++) key = `${base}-${n}`;
    return key;
}

export type RulebookInput = { client: string; title?: string; effective?: string };

/** A new, empty rulebook for a client. Returns its key. */
export function addRulebook(w: Workspace, input: RulebookInput): string {
    const client = text(input.client, 120);
    if (!client) throw new WorkspaceError("Name the client.");
    if (books(w).some((b) => b.client.toLowerCase() === client.toLowerCase())) throw new WorkspaceError(`There is already a rulebook for ${client}.`);
    const key = keyFor(w, client);
    books(w).push({ key, client, short: client.split(/[\s,]+/)[0], title: text(input.title) || `${client} billing rules`, effective: text(input.effective, 40), doc: "", email: "", rules: [] });
    return key;
}

export function updateRulebook(w: Workspace, key: string, input: Partial<RulebookInput>): void {
    const b = books(w).find((x) => x.key === key);
    if (!b) throw new WorkspaceError("That rulebook no longer exists.");
    if (input.client !== undefined) {
        const client = text(input.client, 120);
        if (!client) throw new WorkspaceError("Name the client.");
        if (books(w).some((x) => x.key !== key && x.client.toLowerCase() === client.toLowerCase())) throw new WorkspaceError(`There is already a rulebook for ${client}.`);
        b.client = client;
        b.short = client.split(/[\s,]+/)[0];
    }
    if (input.title !== undefined) b.title = text(input.title) || `${b.client} billing rules`;
    if (input.effective !== undefined) b.effective = text(input.effective, 40);
}

/** The rulebook goes; a bill that applied it goes back to generic. */
export function removeRulebook(w: Workspace, key: string): void {
    const all = books(w);
    const n = all.findIndex((x) => x.key === key);
    if (n < 0) throw new WorkspaceError("That rulebook no longer exists.");
    all.splice(n, 1);
    if (w.billingClient === key) w.billingClient = null;
}

export type ClientRuleInput = { id?: string; kind: RuleKind; title: string; section?: string; quote?: string; does?: string; rate?: number; activityCode?: string; words?: string[]; maxHours?: number; code?: "task" | "activity"; check?: RuleCheck; approved?: string[]; examples?: string[] };

/** "NBH-5": the rulebook's initials and the next number no rule of it has. */
function idFor(b: ClientRulebook): string {
    const initials = b.client.split(/\s+/).map((x) => x[0]).join("").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3) || "R";
    let n = 1;
    while (b.rules.some((r) => r.id === `${initials}-${n}`)) n++;
    return `${initials}-${n}`;
}

/** A rule added to the rulebook, or an existing one (by id) replaced; what its kind needs is checked. Returns the id. */
export function saveClientRule(w: Workspace, key: string, input: ClientRuleInput): string {
    const b = books(w).find((x) => x.key === key);
    if (!b) throw new WorkspaceError("That rulebook no longer exists.");
    const existing = input.id ? b.rules.find((r) => r.id === input.id) : undefined;
    const info = RULE_KINDS.find((k) => k.kind === input.kind);
    if (!info) throw new WorkspaceError("That is not a kind of rule.");
    const title = text(input.title, 120);
    if (!title) throw new WorkspaceError("Give the rule a title.");
    const rule: ClientRule = { id: "", section: text(input.section, 40), title, kind: info.kind, quote: text(input.quote, QUOTE_MAX), does: "", enabled: true };
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    if (info.needs === "rate") { const rate = num(input.rate); if (!rate) throw new WorkspaceError("Enter the rate cap, in dollars an hour."); rule.rate = rate; }
    if (info.needs === "maxHours") { const h = num(input.maxHours); if (!h) throw new WorkspaceError("Enter the most hours a call may bill."); rule.maxHours = h; }
    if (info.needs === "activityCode") { const code = text(input.activityCode, 8).toUpperCase(); if (!/^[A-Z]\d{3}$/.test(code)) throw new WorkspaceError("Enter a UTBMS activity code, such as A105."); rule.activityCode = code; }
    if (info.needs === "words") { const words = list(input.words); if (!words.length) throw new WorkspaceError("Enter at least one word the narrative would contain."); rule.words = words; }
    if (info.needs === "code") rule.code = input.code === "activity" ? "activity" : "task";
    if (info.needs === "check") {
        const check = RULE_CHECKS.find((c) => c.check === input.check);
        if (!check) throw new WorkspaceError("Choose what to check.");
        rule.check = check.check;
        if (check.check === "clerical" || check.check === "travel") {
            const words = list(input.words);
            rule.words = words.length ? words : existing?.check === check.check && existing.words?.length ? [...existing.words] : [...CHECK_WORDS[check.check]];
        }
        if (check.check === "researchCap") rule.maxHours = num(input.maxHours) ?? 5;
        if (check.check === "timekeepers") { const approved = list(input.approved); if (!approved.length) throw new WorkspaceError("List the approved timekeepers."); rule.approved = approved; }
        if (check.check === "vague") { const examples = list(input.examples); if (examples.length) rule.examples = examples; }
    }
    rule.does = text(input.does, QUOTE_MAX) || describeRule(rule);
    if (existing) {
        rule.id = existing.id;
        rule.enabled = existing.enabled;
        if (existing.sources?.length) rule.sources = existing.sources;
        b.rules[b.rules.indexOf(existing)] = rule;
    } else {
        rule.id = idFor(b);
        b.rules.push(rule);
    }
    return rule.id;
}

export function removeClientRule(w: Workspace, key: string, id: string): void {
    const b = books(w).find((x) => x.key === key);
    if (!b) throw new WorkspaceError("That rulebook no longer exists.");
    const n = b.rules.findIndex((r) => r.id === id);
    if (n < 0) throw new WorkspaceError("That rule no longer exists.");
    b.rules.splice(n, 1);
}

/**
 * The keep-time rule set a rulebook implies, so the Keep sheet checks an entry against rules made
 * here (src/shared/rules.ts `checkEntry`). Only the kinds an entry can be checked for on its own
 * map; a rate cap, a call cap and the bill-shaping kinds act on the bill instead.
 */
export function ruleSetOf(book: ClientRulebook): RuleSet {
    const rules: Rule[] = [];
    for (const r of book.rules) {
        if (!r.enabled) continue;
        const map: { check: string; params: Record<string, unknown> } | null =
            r.kind === "tenths" ? { check: "time_increment", params: { incr: 0.1 } }
            : r.kind === "split" ? { check: "block_billing", params: { max_tasks: 1 } }
            : r.kind === "codePrefix" ? { check: "task_codes", params: {} }
            : r.kind === "noCharge" && r.activityCode === "A105" ? { check: "internal_conference", params: {} }
            : r.kind === "check" && r.check === "vague" ? { check: "vague_narrative", params: {} }
            : r.kind === "check" && r.check === "clerical" ? { check: "clerical_work", params: { kw: r.words?.length ? r.words : CHECK_WORDS.clerical } }
            : r.kind === "check" && r.check === "travel" ? { check: "travel_rate", params: { pct: 50 } }
            : r.kind === "check" && r.check === "researchCap" ? { check: "research_threshold", params: { max_hrs: r.maxHours ?? 5 } }
            : null;
        if (!map) continue;
        rules.push({ id: r.id, clause: r.section, title: r.title, text: r.quote || r.does, check: map.check, params: map.params, source: "guidelines", sourceRef: book.title || null, approvedAt: null, atEntry: true });
    }
    return { client: book.client, clientId: book.key, matter: null, guidelines: book.title, version: "app", exportedAt: "", rules };
}
