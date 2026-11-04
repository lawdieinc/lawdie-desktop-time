/* Entries the person types: rows imported from the firm's time system and simple entries
   added on the Time page ("call w/ client", 0.9). Pure, under vitest.

   A typed row is a note about work Time Capture may already have seen. "Expand narrative"
   matches it to that captured entry (src/shared/importMatch.ts: same day and matter, hours
   and words in common) and shows the entry's own drafted narrative, parts and sources. That
   is the rules drafter: deterministic, offline, the same every time.

   Accepting a matched row ("Use this narrative" or "Keep mine") folds it into the captured
   entry. It is the same work, so nothing is added: the entry keeps the hours Time Capture
   recorded, a suggestion the person vouched for is confirmed, and "Keep mine" puts the
   person's words in as the narrative. A row never becomes a second entry, and no two rows
   claim the same entry. Undo puts the entry back exactly as it was. */

import { bestMatch, matchRows, parseHours } from "./importMatch";
import { WorkspaceError, type ImportedRow, type TimeEntry, type Workspace } from "./model";

export type TypedInput = {
    /** YYYY-MM-DD. */
    date: string;
    /** The note as typed. Hours at its start or end (".9 call w/ client", "consent .5") are taken out when `hours` is empty. */
    note: string;
    /** ".9", "0.9", "54m", "1.5h"; empty to take them from the note. */
    hours?: string | number | null;
    projectID?: string | null;
    matter?: string;
    timekeeper?: string;
};

/** An hours token people type: ".9", "0.3", "1.5h", "54m", "90 min". A bare whole number ("Part 2") is not hours. */
const HOURS_TOKEN = /^(\d*\.\d+|\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?))$/i;

/** A note with its hours taken off the start or the end: ".9 call w/ client" is 0.9 hours of "call w/ client". */
export function splitNote(text: string): { note: string; hours: number | null } {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length > 1 && HOURS_TOKEN.test(words[0])) return { note: words.slice(1).join(" "), hours: parseHours(words[0]) };
    if (words.length > 1 && HOURS_TOKEN.test(words[words.length - 1])) return { note: words.slice(0, -1).join(" "), hours: parseHours(words[words.length - 1]) };
    return { note: words.join(" "), hours: null };
}

/** The entries other rows already claim: an entry is matched by one typed row at most. */
export function claimed(w: Workspace, exceptRowID?: string): Set<string> {
    return new Set((w.imported ?? []).filter((r) => r.id !== exceptRowID && r.linked && r.entryID).map((r) => r.entryID as string));
}

const row = (w: Workspace, id: string): ImportedRow => {
    const r = (w.imported ?? []).find((x) => x.id === id);
    if (!r) throw new WorkspaceError("That typed entry no longer exists.");
    return r;
};

/** Add a simple typed entry (Add entry on the Time page). It shows as typed until it is expanded. */
export function addTypedRow(w: Workspace, input: TypedInput, id: string): ImportedRow {
    const split = splitNote(input.note);
    const given = input.hours == null || String(input.hours).trim() === "" ? null : typeof input.hours === "number" ? input.hours : parseHours(String(input.hours));
    const hours = given ?? split.hours;
    const note = given != null ? input.note.trim() : split.note;
    if (!note) throw new WorkspaceError("Type a short note, such as call w/ client.");
    if (hours == null || !(hours > 0) || hours > 24) throw new WorkspaceError("Enter the hours, such as .9, 54m or 1.5h.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new WorkspaceError("Choose the day of the work.");
    const p = input.projectID ? w.projects.find((x) => x.id === input.projectID) : undefined;
    if (input.projectID && !p) throw new WorkspaceError("Choose an existing matter.");
    const r: ImportedRow = {
        id, date: input.date, matter: p ? p.name : (input.matter ?? "").trim(), timekeeper: input.timekeeper ?? w.profile?.name ?? "",
        hours: Math.round(hours * 100) / 100, description: note, entryID: null, decision: null, linked: false, origin: "manual", projectID: p?.id ?? null,
    };
    w.imported = [...(w.imported ?? []), r];
    return r;
}

/** For a row that found nothing: the typed row that already holds the work it would have matched, so the person
 *  sees "same work as ..." rather than "nothing matches". */
function sameAsFor(w: Workspace, r: ImportedRow): string | null {
    if (r.entryID) return null;
    const would = bestMatch(w, r);
    return would ? (w.imported ?? []).find((x) => x.id !== r.id && x.linked && x.entryID === would)?.id ?? null : null;
}

/** Expand one typed row: match it to the captured entry it describes, among those no other row claims. */
export function expandRow(w: Workspace, id: string): ImportedRow {
    const r = row(w, id);
    if (r.decision) undo(w, r);
    r.entryID = bestMatch(w, r, claimed(w, r.id));
    r.linked = true;
    r.sameAs = sameAsFor(w, r);
    return r;
}

/** "Link sources and draft narratives": every imported row not linked yet, one to one, never an entry another row claims. */
export function linkAll(w: Workspace): string[] {
    const open = (w.imported ?? []).filter((r) => r.origin !== "manual" && !r.linked);
    const matched = matchRows(w, open, (n) => open[n].id, claimed(w));
    open.forEach((r, n) => { r.entryID = matched[n].entryID; r.linked = true; });
    for (const r of open) r.sameAs = sameAsFor(w, r);
    return open.map((r) => r.id);
}

const FIELDS = ["description", "status", "why", "partsEdited", "drafted", "typed"] as const;

/** Put the matched entry back as it was before this row's decision, and forget the decision. */
function undo(w: Workspace, r: ImportedRow): void {
    const e = r.entryID ? w.entries.find((x) => x.id === r.entryID) : undefined;
    const p = r.prior;
    if (e && p) {
        const target = e as Record<string, unknown>;
        // A field the entry did not have before is taken off again; a description is always there, so it is always put back.
        for (const f of FIELDS) { if (p[f] == null) delete target[f]; else target[f] = p[f]; }
    }
    delete r.prior;
    r.decision = null;
}

/**
 * The person's choice on an expanded row. "use": the captured entry, with Lawdie's narrative, is the day's entry for
 * this work. "keep": the same entry with the person's words as the narrative. Either way the row folds into the entry
 * (its note is kept on it) and adds no hours; a suggestion is confirmed, since the person's own note vouches for it.
 * null: undo, the entry exactly as it was.
 */
export function decideRow(w: Workspace, id: string, decision: "use" | "keep" | null): void {
    const r = row(w, id);
    if (r.decision) undo(w, r);
    if (!decision) return;
    const e = r.linked && r.entryID ? w.entries.find((x) => x.id === r.entryID) : undefined;
    if (!e) throw new WorkspaceError("No captured work matches this entry, so there is nothing to use. Edit the note and expand it again.");
    const prior: NonNullable<ImportedRow["prior"]> = {};
    for (const f of FIELDS) if (e[f] !== undefined) (prior as Record<string, unknown>)[f] = e[f];
    r.prior = prior;
    e.typed = { note: r.description, hours: r.hours, rowID: r.id, origin: r.origin ?? "import" };
    if (e.status === "suggested") { delete e.status; delete e.why; }
    if (decision === "keep") {
        e.description = r.description.trim();
        if (e.parts?.length) e.partsEdited = true;
        delete e.drafted;
    }
    r.decision = decision;
}

/** Change a typed row's note or hours. Its match and any decision are undone: expand it again. */
export function editTypedRow(w: Workspace, id: string, change: { description?: string; hours?: string | number }): ImportedRow {
    const r = row(w, id);
    if (r.decision) undo(w, r);
    if (change.description !== undefined) {
        if (!change.description.trim()) throw new WorkspaceError("Type a short note.");
        r.description = change.description.trim();
    }
    if (change.hours !== undefined) {
        const h = typeof change.hours === "number" ? change.hours : parseHours(String(change.hours));
        if (!(h > 0) || h > 24) throw new WorkspaceError("Enter the hours, such as .9, 54m or 1.5h.");
        r.hours = Math.round(h * 100) / 100;
    }
    r.entryID = null;
    r.linked = false;
    r.sameAs = null;
    return r;
}

/** Take a typed row off the day; a decision it made is undone first. */
export function removeTypedRow(w: Workspace, id: string): void {
    const r = row(w, id);
    if (r.decision) undo(w, r);
    w.imported = (w.imported ?? []).filter((x) => x.id !== id);
    if (!w.imported.length) delete w.imported;
}

/** "Clear import": the imported rows go, and what their decisions changed is put back. Rows added here stay. */
export function clearImports(w: Workspace): void {
    for (const r of [...(w.imported ?? [])]) if (r.origin !== "manual") removeTypedRow(w, r.id);
}

/** The entry a typed row is folded into, or undefined. */
export const entryOfRow = (w: Workspace, r: ImportedRow): TimeEntry | undefined => (r.entryID ? w.entries.find((e) => e.id === r.entryID) : undefined);
