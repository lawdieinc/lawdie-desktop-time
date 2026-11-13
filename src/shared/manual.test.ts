import { describe, expect, it } from "vitest";
import { MANUAL_OWNER_ID, PERSONAL, editEntry, emptyWorkspace, keepStretch, seconds, validate, type Activity, type Workspace } from "./model";
import { inboxOf } from "./matters";
import { approveRows, inboxRowOf, keepPreview, keepStart } from "./keep";
import { summaryRequest } from "./summaries";
import { addManualTime, editActivityTime, isManual, setRowHours } from "./manual";

const T0 = new Date(2026, 10, 10, 9, 0, 0).getTime();
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const NOW = T0 + 8 * 3_600_000;
const act = (id: string, from: number, to: number, over: Partial<Activity> = {}): Activity => ({ id, app: "Microsoft Word", ownerID: "com.microsoft.Word", title: "Lease.docx", startedAt: at(from), endedAt: at(to), endedBy: "switched", disposition: "pending", matter: "Acme lease", matterBy: "ai", ...over });
function day(): Workspace {
    const w = emptyWorkspace();
    w.projects.push({ id: "p", name: "Acme lease", client: "", color: "gold", hourlyRate: 450, archived: false });
    w.activities.push(act("a1", 0, 20, { description: "Revised the lease" }), act("a2", 50, 60));
    return validate(w);
}
const hoursOf = (w: Workspace, ids: string[]): number => { const r = inboxRowOf(w, ids)!; const s = keepStart(w, r.stretch, r.sittings, r.matter, ""); return keepPreview(w, r.stretch, r.sittings, s, s.single).hours; };

describe("adding time by hand", () => {
    it("lands in review as the person's own row, described and on their matter", () => {
        const w = emptyWorkspace();
        const a = addManualTime(w, { startedAt: at(0), endedAt: at(45), note: "  Call with opposing counsel ", matter: "Whitfield v. Harmon" }, NOW);
        expect(a).toMatchObject({ ownerID: MANUAL_OWNER_ID, app: "Added by you", endedBy: "manual", disposition: "pending", matter: "Whitfield v. Harmon", matterBy: "person", description: "Call with opposing counsel" });
        expect(isManual(a)).toBe(true);
        validate(w);
        const { groups } = inboxOf(w.activities);
        expect(groups.map((g) => [g.matter, g.seconds])).toEqual([["Whitfield v. Harmon", 45 * 60]]);
        // Approved like captured time, as one entry.
        const r = approveRows(w, [[a.id]], NOW);
        expect(r.kept.map((k) => k.hours)).toEqual([0.8]);
        expect(w.entries[0]).toMatchObject({ description: "Call with opposing counsel", startedAt: at(0), endedAt: at(45) });
    });

    it("with no matter waits as a stretch, and is never sent for a sitting summary", () => {
        const w = emptyWorkspace();
        const a = addManualTime(w, { startedAt: at(0), endedAt: at(30), note: "Reviewed the file" }, NOW);
        expect(a.matter).toBeUndefined();
        expect(inboxOf(w.activities).stretches.map((s) => s.name)).toEqual(["Reviewed the file"]);
        expect(summaryRequest(w)).toBeNull();
    });

    it("refuses an end before the start, the future, more than a day, and time too old to review", () => {
        const w = emptyWorkspace();
        for (const [from, to] of [[30, 30], [40, 20], [0, 9 * 60], [0, 25 * 60], [-200 * 1440, -200 * 1440 + 60]]) expect(() => addManualTime(w, { startedAt: at(from), endedAt: at(to) }, NOW)).toThrow();
        expect(w.activities).toEqual([]);
    });

    it("typed as Personal is personal time", () => {
        const w = emptyWorkspace();
        expect(addManualTime(w, { startedAt: at(0), endedAt: at(30), matter: "personal" }, NOW).matter).toBe(PERSONAL);
    });

    it("a sitting added to a matter's row joins it, and its time counts once where it overlaps", () => {
        const w = day();
        const call = addManualTime(w, { startedAt: at(90), endedAt: at(120), note: "Client call", like: "a1" }, NOW);
        // Its note names the sitting; the row keeps its own description.
        expect(call).toMatchObject({ title: "Client call", matter: "Acme lease" });
        expect(call.description).toBeUndefined();
        addManualTime(w, { startedAt: at(10), endedAt: at(30), like: "a1" }, NOW); // ten minutes of it already captured
        const { groups } = inboxOf(validate(w).activities);
        expect(groups).toHaveLength(1);
        expect(groups[0].activityIDs).toHaveLength(4);
        const r = approveRows(w, [groups[0].activityIDs], NOW);
        expect(seconds(w.entries.find((e) => e.id === r.kept[0].entryID)!)).toBe((30 + 10 + 30) * 60);
        expect(() => addManualTime(w, { startedAt: at(0), endedAt: at(5), like: "a1" }, NOW)).toThrow(); // the row is reviewed
    });
});

describe("changing a sitting's time", () => {
    it("moves its start and end, marks it, and keeps only the idle inside", () => {
        const w = day();
        w.activities[0].idle = [{ startedAt: at(2), endedAt: at(14) }];
        editActivityTime(w, "a1", at(5), at(40), NOW);
        expect(w.activities[0]).toMatchObject({ startedAt: at(5), endedAt: at(40), timeEdited: true, idle: [{ startedAt: at(5), endedAt: at(14) }] });
        validate(w);
        expect(hoursOf(w, ["a1", "a2"])).toBe(0.8); // 35 + 10 minutes
    });

    it("refuses reviewed, imported and calendar time, and impossible times", () => {
        const w = day();
        w.activities.push(act("c1", 100, 130, { ownerID: "calendar:google", endedBy: "calendar" }), act("k1", 200, 230, { disposition: "kept" }));
        expect(() => editActivityTime(w, "c1", at(100), at(120), NOW)).toThrow();
        expect(() => editActivityTime(w, "k1", at(200), at(220), NOW)).toThrow();
        expect(() => editActivityTime(w, "a1", at(20), at(10), NOW)).toThrow();
        expect(() => editActivityTime(w, "a1", at(0), at(9 * 60), NOW)).toThrow();
        expect(w.activities[0]).toMatchObject({ startedAt: at(0), endedAt: at(20) });
    });
});

describe("hours typed on a review row", () => {
    it("are what the row is kept as until cleared", () => {
        const w = day();
        expect(hoursOf(w, ["a1", "a2"])).toBe(0.5);
        setRowHours(w, ["a2", "a1"], 1.25);
        expect(validate(w).activities.map((a) => a.billHours)).toEqual([1.25, undefined]);
        expect(hoursOf(w, ["a1", "a2"])).toBe(1.25);
        setRowHours(w, ["a1", "a2"], 0.7);
        const copy = structuredClone(w);
        expect(approveRows(copy, [["a1", "a2"]], NOW).kept[0].hours).toBe(0.7);
        expect(copy.entries[0].hours).toBe(0.7);
        setRowHours(w, ["a1", "a2"], null);
        expect(hoursOf(w, ["a1", "a2"])).toBe(0.5);
        for (const h of [0, -1, 25, NaN]) expect(() => setRowHours(w, ["a1"], h)).toThrow();
    });
});

describe("changing a kept entry's times", () => {
    it("takes new bounds for one sitting, trims several, and never overlaps other kept time", () => {
        const w = day();
        const one = keepStretch(w, ["a1"], { description: "Lease", projectID: null, matter: "Acme lease", billable: true }, NOW);
        const other = keepStretch(w, ["a2"], { description: "More lease", projectID: null, matter: "Acme lease", billable: true }, NOW);
        expect(editEntry(w, one.id, { startedAt: at(-10), endedAt: at(30) }, NOW)).toMatchObject({ startedAt: at(-10), endedAt: at(30) });
        expect(() => editEntry(w, one.id, { endedAt: at(55) }, NOW)).toThrow(/overlaps/);
        expect(() => editEntry(w, one.id, { startedAt: at(40), endedAt: at(30) }, NOW)).toThrow();
        expect(() => editEntry(w, other.id, { endedAt: at(9 * 60) }, NOW)).toThrow(/future/);
        expect(w.entries.find((e) => e.id === one.id)).toMatchObject({ startedAt: at(-10), endedAt: at(30) });
    });

    it("trims an entry of several sittings to the new bounds", () => {
        const w = day();
        const e = keepStretch(w, ["a1", "a2"], { description: "Lease", projectID: null, matter: "Acme lease", billable: true }, NOW);
        expect(e.sittings).toHaveLength(2);
        const next = editEntry(w, e.id, { startedAt: at(10), endedAt: at(55) }, NOW);
        expect(next.sittings).toEqual([{ startedAt: at(10), endedAt: at(20) }, { startedAt: at(50), endedAt: at(55) }]);
        expect(seconds(next)).toBe(15 * 60);
    });
});
