/* Entries typed into the firm's time system (an iTimeKeep export: date, matter, timekeeper,
   hours, description), matched back to the work Time Capture saw. Pure, under vitest.

   Each row is scored against the captured entries of its day and matter: how close the hours
   are, and how many of the typed words appear in the entry's narrative, work titles and the
   subjects of its sources (with a few shorthand words widened: "agmt" is an agreement, a
   "call" is a conference). Rows and entries pair one to one, best score first. */

import { seconds, type ImportedRow, type TimeEntry, type Workspace } from "./model";

export type TypedRow = Omit<ImportedRow, "id" | "entryID" | "decision">;

/** CSV text as rows of cells (quotes, doubled quotes and newlines inside quotes handled). */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ",") { row.push(cell); cell = ""; }
        else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
        else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
}

/** A table (header row first) as typed rows; columns found by name, in any order and case. */
export function typedRows(table: string[][]): TypedRow[] {
    if (!table.length) return [];
    const head = table[0].map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const c = { date: col("date", "work date"), matter: col("matter"), tk: col("timekeeper"), hours: col("hours"), desc: col("description", "narrative") };
    if (c.hours < 0 || c.desc < 0) throw new Error("The file needs at least an hours column and a description column.");
    return table.slice(1).map((r) => ({
        date: normalizeDate(r[c.date] ?? ""), matter: (r[c.matter] ?? "").trim(), timekeeper: (r[c.tk] ?? "").trim(),
        hours: Number(String(r[c.hours] ?? "").replace(/[^0-9.]/g, "")) || 0, description: (r[c.desc] ?? "").trim(),
    })).filter((r) => r.description || r.hours);
}

/** "10/26/2026", "2026-10-26" or an Excel serial day as YYYY-MM-DD. */
export function normalizeDate(v: string): string {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (us) { const y = us[3].length === 2 ? `20${us[3]}` : us[3]; return `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`; }
    if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000); return d.toISOString().slice(0, 10); }
    return s;
}

const STOP = new Set(["the", "and", "for", "with", "of", "to", "a", "an", "on", "in", "re", "regarding", "about", "from", "per"]);
/** Shorthand people type, widened to the words a narrative uses. */
const WIDEN: Record<string, string[]> = {
    agmt: ["agreement"], agrmt: ["agreement"], call: ["conference", "telephone", "teams", "call"], phone: ["telephone", "conference", "call"],
    mtg: ["meeting", "conference"], meeting: ["conference", "meeting"], email: ["email", "emailed", "outlook"], memo: ["memorandum", "memo"],
    research: ["research", "researched"], consent: ["consent"], redline: ["revise", "redline"], review: ["review", "reviewed"],
};
const stem = (w: string): string => w.slice(0, 5);
const words = (t: string): string[] => (t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** The local day of an ISO time, YYYY-MM-DD. */
const localDay = (iso: string): string => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** What an entry is about, as one bag of word stems: narrative, work titles, its sources' subjects and files, the client. */
function entryStems(w: Workspace, e: TimeEntry): Set<string> {
    const ev = w.evidence ?? {};
    const client = w.projects.find((p) => p.id === e.projectID)?.client ?? "";
    const texts = [e.description, ...(e.work ?? []).map((x) => `${x.app} ${x.title}`), ...(e.sources ?? []).map((s) => {
        const x = ev[s.id];
        return x ? [x.subject, x.file, x.title, ...(x.attendees ?? [])].filter(Boolean).join(" ") : s.label;
    })];
    const out = new Set(texts.flatMap(words).map(stem));
    if (client) out.add("client");
    return out;
}

/** Billing hours of an entry: as recorded, else its time rounded up to the tenth. */
export const recordedHours = (e: TimeEntry): number => e.hours ?? Math.ceil(seconds(e) / 360) / 10;

/** 0..1: the share of typed words found in the entry (shorthand widened), weighted with how close the hours are. */
export function score(w: Workspace, row: TypedRow, e: TimeEntry, bag = entryStems(w, e)): number {
    const typed = words(row.description);
    if (!typed.length) return 0;
    const found = typed.filter((t) => [t, ...(WIDEN[t] ?? [])].some((x) => bag.has(stem(x)))).length / typed.length;
    if (!found) return 0;
    const h = recordedHours(e);
    const hours = row.hours && h ? 1 - Math.min(1, Math.abs(row.hours - h) / Math.max(row.hours, h)) : 0;
    return 0.65 * found + 0.35 * hours;
}

/** Whether an entry is on the row's matter: its project's name or client names it. No matter on the row matches any. */
const onMatter = (w: Workspace, row: TypedRow, e: TimeEntry): boolean => {
    if (!row.matter) return true;
    const p = w.projects.find((x) => x.id === e.projectID);
    const m = row.matter.toLowerCase();
    return !!p && (p.name.toLowerCase().includes(m) || p.client.toLowerCase().includes(m) || (p.context?.number ?? "").toLowerCase() === m);
};

/** The rows, each paired with at most one entry of its day and matter, best scores first. */
export function matchRows(w: Workspace, rows: readonly TypedRow[], makeID: (n: number) => string): ImportedRow[] {
    const candidates = w.entries.filter((e) => e.status !== "dismissed");
    const bags = new Map(candidates.map((e) => [e.id, entryStems(w, e)]));
    const pairs: { r: number; e: TimeEntry; s: number }[] = [];
    rows.forEach((row, r) => {
        for (const e of candidates) {
            if (row.date && localDay(e.startedAt) !== row.date) continue;
            if (!onMatter(w, row, e)) continue;
            const s = score(w, row, e, bags.get(e.id));
            if (s >= 0.3) pairs.push({ r, e, s });
        }
    });
    pairs.sort((a, b) => b.s - a.s);
    const taken = new Set<string>(), matched = new Map<number, string>();
    for (const p of pairs) if (!matched.has(p.r) && !taken.has(p.e.id)) { matched.set(p.r, p.e.id); taken.add(p.e.id); }
    return rows.map((row, n) => ({ ...row, id: makeID(n), entryID: matched.get(n) ?? null, decision: null }));
}
