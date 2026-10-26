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

/** What each column is called in real exports and hand-kept sheets. The first that fits a header cell wins. */
const COLUMNS: [keyof Columns, RegExp][] = [
    ["hours", /^(hrs?|hours?|time|duration|qty|billed hours|hrs\.?)$|\bhours?\b|\bhrs\b/],
    ["matter", /matter|client/],
    ["timekeeper", /atty|attorney|timekeeper|^tk$|lawyer|^who$|professional|initials/],
    ["date", /^(work )?date$|^day$|\bdate\b/],
    ["description", /what|desc|narr|task|activity|work done|notes?|details?|entry/],
];
type Columns = { date: number; matter: number; timekeeper: number; hours: number; description: number };

/** The header row and its columns: the first row in the first fifteen that names at least an hours and a description column. */
function findHeader(table: string[][]): { at: number; c: Columns } | null {
    for (let at = 0; at < Math.min(15, table.length); at++) {
        const c: Columns = { date: -1, matter: -1, timekeeper: -1, hours: -1, description: -1 };
        table[at].forEach((cell, i) => {
            const h = cell.trim().toLowerCase();
            if (!h) return;
            const hit = COLUMNS.find(([key, re]) => c[key] < 0 && re.test(h));
            if (hit) c[hit[0]] = i;
        });
        if (c.hours >= 0 && c.description >= 0) return { at, c };
    }
    return null;
}

/** ".9", "0.3", "1.5h", "1.5 hrs", "90m", "90 min", "1:30" as hours. */
export function parseHours(v: string): number {
    const s = v.trim().toLowerCase().replace(/,/g, ".");
    const clock = s.match(/^(\d+):(\d{2})$/);
    if (clock) return Math.round((Number(clock[1]) + Number(clock[2]) / 60) * 100) / 100;
    const m = s.match(/^(\d*\.?\d+)\s*(m|min|mins|minutes?)$/);
    if (m) return Math.round((Number(m[1]) / 60) * 100) / 100;
    const h = s.match(/^(\d*\.?\d+)\s*(h|hr|hrs|hours?)?$/);
    return h ? Number(h[1]) : 0;
}

/**
 * A table as typed rows: the header found wherever it is (a title row and blank rows above
 * are fine), columns found by their usual names in any order, blank rows and total rows
 * skipped, hours and dates read in the forms people type. `year` completes a date with none.
 */
export function typedRows(table: string[][], year = new Date().getFullYear()): TypedRow[] {
    const head = findHeader(table);
    if (!head) throw new Error("The file needs a header row with an hours column and a description column.");
    const { at, c } = head;
    const cell = (r: string[], i: number): string => (i >= 0 ? String(r[i] ?? "").trim() : "");
    return table.slice(at + 1)
        .filter((r) => r.some((x) => String(x ?? "").trim()) && !r.some((x) => /^\s*(grand\s+)?totals?\b/i.test(String(x ?? ""))))
        .map((r) => ({ date: normalizeDate(cell(r, c.date), year), matter: cell(r, c.matter), timekeeper: cell(r, c.timekeeper), hours: parseHours(cell(r, c.hours)), description: cell(r, c.description) }))
        .filter((r) => r.description || r.hours);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y: number | string, m: number | string, d: number | string): string => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** "10/26/2026", "10/26", "Oct 26", "October 26, 2026", "26 Oct", "2026-10-26" or an Excel serial day as YYYY-MM-DD. */
export function normalizeDate(v: string, year = new Date().getFullYear()): string {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const us = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (us) return iso(us[3] ? (us[3].length === 2 ? `20${us[3]}` : us[3]) : year, us[1], us[2]);
    const md = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i);
    if (md && MONTHS.includes(md[1].slice(0, 3).toLowerCase())) return iso(md[3] ?? year, MONTHS.indexOf(md[1].slice(0, 3).toLowerCase()) + 1, md[2]);
    const dm = s.match(/^(\d{1,2})\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/i);
    if (dm && MONTHS.includes(dm[2].slice(0, 3).toLowerCase())) return iso(dm[3] ?? year, MONTHS.indexOf(dm[2].slice(0, 3).toLowerCase()) + 1, dm[1]);
    if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000); return d.toISOString().slice(0, 10); }
    return s;
}

const STOP = new Set(["the", "and", "for", "with", "of", "to", "a", "an", "on", "in", "re", "regarding", "about", "from", "per", "w"]);
/** Shorthand people type, widened to the words a narrative uses. */
const WIDEN: Record<string, string[]> = {
    agmt: ["agreement"], agrmt: ["agreement"], call: ["conference", "telephone", "call"], phone: ["telephone", "conference", "call"],
    mtg: ["meeting", "conference"], meeting: ["conference", "meeting"], email: ["email", "emailed", "outlook"], memo: ["memorandum", "memo"],
    research: ["research", "researched"], redline: ["revise", "redline"], rev: ["review", "revise"], conf: ["conference"], draft: ["draft", "prepare"],
};
/** Two-letter state codes, as the words a narrative spells out. */
const STATES: Record<string, string> = { ny: "york", nj: "jersey", ca: "california", tx: "texas", fl: "florida", il: "illinois", ma: "massachusetts", dc: "columbia" };
const words = (t: string): string[] => (t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** The local day of an ISO time, YYYY-MM-DD. */
const localDay = (iso: string): string => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

type Bag = { words: Set<string>; list: string[]; text: string };
/** What an entry is about: the words of its narrative, work titles, its sources' subjects, files and attendees, and the client. */
function entryBag(w: Workspace, e: TimeEntry): Bag {
    const ev = w.evidence ?? {};
    const client = w.projects.find((p) => p.id === e.projectID)?.client ?? "";
    const texts = [e.description, ...(e.work ?? []).map((x) => `${x.app} ${x.title}`), ...(e.sources ?? []).map((s) => {
        const x = ev[s.id];
        return x ? [x.subject, x.file, x.title, ...(x.attendees ?? [])].filter(Boolean).join(" ") : s.label;
    })];
    const set = new Set(texts.flatMap(words));
    // "client" in a note means work with the client: the narrative names the client ("(Northlake)"), not just its matter.
    const clientWord = client.split(/\s+/)[0]?.replace(/[^a-z0-9]/gi, "");
    if (clientWord && new RegExp(`\\b${clientWord}\\b`, "i").test(e.description)) set.add("client");
    return { words: set, list: [...set], text: texts.join(" ") };
}

/** Whether one typed word is in the entry: the word, a word it starts (three letters or more), its shorthand, a state code, or initials of a name. */
function found(t: string, bag: Bag): boolean {
    if (t.length === 2 && STATES[t]) return bag.words.has(STATES[t]);
    if (t.length === 2 && /^[a-z]{2}$/.test(t)) {
        // "PR" is P. Raman or Priya Raman: initials of a capitalized name in the entry's text.
        const [a, b] = t.toUpperCase();
        return new RegExp(`\\b${a}[a-z]*\\.?\\s+${b}[a-z]+`).test(bag.text) || bag.words.has(t);
    }
    return [t, ...(WIDEN[t] ?? [])].some((x) => bag.words.has(x) || (x.length >= 3 && bag.list.some((y) => y.startsWith(x))) || (x.length >= 6 && bag.list.some((y) => y.startsWith(x.slice(0, 5)))));
}

/** Billing hours of an entry: as recorded, else its time rounded up to the tenth. */
export const recordedHours = (e: TimeEntry): number => e.hours ?? Math.ceil(seconds(e) / 360) / 10;

/** 0..1: the share of typed words found in the entry, weighted with how close the hours are. */
export function score(w: Workspace, row: TypedRow, e: TimeEntry, bag = entryBag(w, e)): number {
    const typed = words(row.description);
    if (!typed.length) return 0;
    const share = typed.filter((t) => found(t, bag)).length / typed.length;
    const h = recordedHours(e);
    const hours = row.hours && h ? 1 - Math.min(1, Math.abs(row.hours - h) / Math.max(row.hours, h)) : 0;
    // Most of what was typed must be there, or a good part of it with hours that agree. Half a note with the wrong
    // hours ("call w/ client" against a 0.3 h internal conference) is not enough to say it is this work.
    if (share < 0.6 && !(share >= 0.4 && hours >= 0.75)) return 0;
    return 0.65 * share + 0.35 * hours;
}

/** Whether an entry is on the row's matter: the matter picked for it (Add entry), else a project whose name or client
 *  names the typed matter. No matter on the row matches any. */
const onMatter = (w: Workspace, row: TypedRow, e: TimeEntry): boolean => {
    if (row.projectID) return e.projectID === row.projectID;
    if (!row.matter) return true;
    const p = w.projects.find((x) => x.id === e.projectID);
    const m = row.matter.toLowerCase();
    return !!p && (p.name.toLowerCase().includes(m) || p.client.toLowerCase().includes(m) || (p.context?.number ?? "").toLowerCase() === m);
};

/** Every row and captured entry that could be the same work, scored: same day, same matter, enough in common. */
function pairsFor(w: Workspace, rows: readonly TypedRow[], exclude: ReadonlySet<string>): { r: number; e: TimeEntry; s: number }[] {
    const candidates = w.entries.filter((e) => e.status !== "dismissed" && !exclude.has(e.id));
    const bags = new Map(candidates.map((e) => [e.id, entryBag(w, e)]));
    const pairs: { r: number; e: TimeEntry; s: number }[] = [];
    rows.forEach((row, r) => {
        for (const e of candidates) {
            if (row.date && localDay(e.startedAt) !== row.date) continue;
            if (!onMatter(w, row, e)) continue;
            const s = score(w, row, e, bags.get(e.id));
            if (s >= 0.3) pairs.push({ r, e, s });
        }
    });
    // Best first; equal scores fall back to the earlier entry, so a match never depends on the file's order.
    return pairs.sort((a, b) => b.s - a.s || Date.parse(a.e.startedAt) - Date.parse(b.e.startedAt));
}

/** The rows, each paired with at most one entry of its day and matter, best scores first. `exclude` names entries
 *  already claimed by other rows, which are never matched again. */
export function matchRows(w: Workspace, rows: readonly TypedRow[], makeID: (n: number) => string, exclude: ReadonlySet<string> = new Set()): ImportedRow[] {
    const taken = new Set<string>(), matched = new Map<number, string>();
    for (const p of pairsFor(w, rows, exclude)) if (!matched.has(p.r) && !taken.has(p.e.id)) { matched.set(p.r, p.e.id); taken.add(p.e.id); }
    return rows.map((row, n) => ({ ...row, id: makeID(n), entryID: matched.get(n) ?? null, decision: null }));
}

/** The one captured entry a single row describes, or null: the best match among the entries no other row claims. */
export function bestMatch(w: Workspace, row: TypedRow, exclude: ReadonlySet<string> = new Set()): string | null {
    return pairsFor(w, [row], exclude)[0]?.e.id ?? null;
}
