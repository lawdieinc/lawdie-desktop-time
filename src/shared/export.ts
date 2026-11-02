/* Kept time as a CSV a person can open in Excel or hand to billing: one row per kept entry,
   project, date, hours, description. Pure; model.test.ts covers it. */

import { seconds, type Workspace } from "./model";

const localDate = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Quoted when it must be; a leading = + - @ is defused so a spreadsheet never runs it as a formula. */
export function csvField(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The given kept entries (all of them when no ids), oldest first. Hours to two places; a stretch counts only its sittings. */
export function entriesCsv(w: Workspace, ids?: string[]): string {
    const wanted = ids ? new Set(ids) : null;
    const rows = w.entries
        .filter((e) => !wanted || wanted.has(e.id))
        .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
        .map((e) => [
            w.projects.find((p) => p.id === e.projectID)?.name ?? "",
            localDate(e.startedAt),
            (seconds(e) / 3600).toFixed(2),
            e.description,
        ].map(csvField).join(","));
    return ["Project,Date,Hours,Description", ...rows].join("\r\n") + "\r\n";
}
