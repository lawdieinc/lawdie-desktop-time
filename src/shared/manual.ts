/* Time a person puts in or corrects by hand (2026-11-12: "you should be able to modify the time directly, and add
   sittings"). Pure. Capture's rules are about what capture records; this is the person's own statement, so it is
   marked as theirs and still goes through review like any other time:
     - `addManualTime()` adds a closed, pending sitting (`ownerID` MANUAL_OWNER_ID, `endedBy` "manual"): from
       Activity's "Add time" (any day, with or without a matter) or a matter row's "Add sitting" (`like` names a
       sitting of the row, so the new one joins it). The note names the sitting, and is the row's description when the sitting is a row of its own (never drafted over); a
       matter given is the person's, never suggested over. It is kept, or not, through Approve and the Keep sheet,
       where the overlap rules already live.
     - `editActivityTime()` changes a pending sitting's start or end (`timeEdited`). Not imported or calendar time:
       those keep the times they came with, and are narrowed in the Keep sheet.
     - `setRowHours()` is the hours typed on a review row (`billHours` on its first sitting): what the row is kept
       as (`keepStart` reads it) until the person changes or clears it.
   A kept entry's times are `editEntry`'s (`EntryChange.startedAt`/`endedAt`, model.ts). */

import { inboxOf } from "./matters";
import { MANUAL_APP, MANUAL_OWNER_ID, MATTER_MAX, PERSONAL, WorkspaceError, isPersonal, pendingDays, uuid, type Activity, type Workspace } from "./model";

export const isManual = (a: Pick<Activity, "ownerID">): boolean => a.ownerID === MANUAL_OWNER_ID;
export const NOTE_MAX = 300;

export type ManualInput = {
    startedAt: string;
    endedAt: string;
    /** What the work was: the row's description. */
    note?: string;
    matter?: string | null;
    /** A pending sitting of the row this joins: its matter and what ties the row together are copied. */
    like?: string;
};

function bounds(w: Workspace, startedAt: string, endedAt: string, now: number): { start: number; end: number } {
    const start = Date.parse(startedAt), end = Date.parse(endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new WorkspaceError("Enter a start and an end time.");
    if (!(end > start)) throw new WorkspaceError("The end must be after the start.");
    if (end > now + 1000) throw new WorkspaceError("Time cannot be in the future.");
    if (end - start > 86_400_000) throw new WorkspaceError("A sitting cannot be longer than a day.");
    const days = pendingDays(w.preferences);
    if (end < now - days * 86_400_000) throw new WorkspaceError(`Time to review goes after ${days} days, so this is too old to add.`);
    return { start, end };
}

/** A sitting the person adds: pending, theirs, reviewed like captured time. */
export function addManualTime(w: Workspace, input: ManualInput, now: number): Activity {
    const { start, end } = bounds(w, input.startedAt, input.endedAt, now);
    const like = input.like ? w.activities.find((a) => a.id === input.like && a.disposition === "pending") : undefined;
    if (input.like && !like) throw new WorkspaceError("That row has already been reviewed.");
    const note = (input.note ?? "").trim().slice(0, NOTE_MAX);
    const named = (like?.matter ?? input.matter ?? "").trim().slice(0, MATTER_MAX);
    const matter = isPersonal(named) ? PERSONAL : named;
    const a: Activity = {
        id: uuid(), app: MANUAL_APP, ownerID: MANUAL_OWNER_ID, title: note || null,
        startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), endedBy: "manual", disposition: "pending",
        ...(matter ? { matter, matterBy: "person" as const } : {}),
        ...(like?.projectID ? { projectID: like.projectID } : {}),
        ...(like?.kiwiProjectID ? { kiwiProjectID: like.kiwiProjectID } : {}),
        ...(like?.mergeKey ? { mergeKey: like.mergeKey } : {}),
    };
    w.activities.push(a);
    // Alone in its row, the note is the row's description. Joining other sittings it is only this sitting's name, so it never speaks for their work.
    const inbox = inboxOf(w.activities);
    const row = [...inbox.groups, ...inbox.stretches, ...inbox.short].find((r) => r.activityIDs.includes(a.id));
    if (note && row?.activityIDs.length === 1) a.description = note;
    return a;
}

/** Change a pending sitting's start and end. Idle flagged on it is kept only inside the new times. */
export function editActivityTime(w: Workspace, id: string, startedAt: string, endedAt: string, now: number): void {
    const a = w.activities.find((x) => x.id === id);
    if (!a || a.disposition !== "pending") throw new WorkspaceError("This activity has already been reviewed.");
    if (a.origin || a.ownerID.startsWith("calendar:")) throw new WorkspaceError("Imported and calendar time keeps the times it came with. Narrow it in the Keep sheet instead.");
    const { start, end } = bounds(w, startedAt, endedAt, now);
    a.startedAt = new Date(start).toISOString();
    a.endedAt = new Date(end).toISOString();
    if (!isManual(a)) a.timeEdited = true;
    if (a.idle) {
        const idle = a.idle.map((i) => ({ startedAt: new Date(Math.max(Date.parse(i.startedAt), start)).toISOString(), endedAt: new Date(Math.min(Date.parse(i.endedAt), end)).toISOString() })).filter((i) => i.endedAt > i.startedAt);
        if (idle.length) a.idle = idle; else delete a.idle;
    }
}

/** The hours a review row is kept as, typed by the person; null goes back to its time, rounded. */
export function setRowHours(w: Workspace, ids: string[], hours: number | null): void {
    const picked = [...new Set(ids)].map((id) => w.activities.find((a) => a.id === id));
    if (!picked.length || picked.some((a) => !a || a.disposition !== "pending")) throw new WorkspaceError("This activity has already been reviewed.");
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24)) throw new WorkspaceError("Enter hours between 0 and 24.");
    const sorted = (picked as Activity[]).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (const a of sorted) delete a.billHours;
    if (hours !== null) sorted[0].billHours = Math.round(hours * 100) / 100;
}
