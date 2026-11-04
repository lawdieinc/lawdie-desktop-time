import { describe, expect, it } from "vitest";
import { activeRules, feeLines, totals } from "./invoice";
import { addTypedRow, claimed, clearImports, decideRow, editTypedRow, expandRow, linkAll, removeTypedRow, splitNote } from "./typed";
import { validate, type Workspace } from "./model";
import { day, rosa, terms } from "./__fixtures__/rosaDay";

/** Add a note on the matter and expand it; the id of the entry it matched, or null. */
const expand = (w: Workspace, note: string, id: string, hours?: string): string | null => {
    addTypedRow(w, { date: day, note, hours, projectID: "p1" }, id);
    return expandRow(w, id).entryID;
};
const billed = (w: Workspace) => totals(feeLines(w, terms, activeRules(w, terms)));

describe("typed notes", () => {
    it("takes hours off the start or the end of a note, never a bare whole number", () => {
        expect(splitNote(".9 call w/ client")).toEqual({ note: "call w/ client", hours: 0.9 });
        expect(splitNote("theo .3")).toEqual({ note: "theo", hours: 0.3 });
        expect(splitNote("consent .5")).toEqual({ note: "consent", hours: 0.5 });
        expect(splitNote("call PR re CA .25")).toEqual({ note: "call PR re CA", hours: 0.25 });
        expect(splitNote("54m research")).toEqual({ note: "research", hours: 0.9 });
        expect(splitNote("1.5h HVHP agmt")).toEqual({ note: "HVHP agmt", hours: 1.5 });
        expect(splitNote("Part 2 consent")).toEqual({ note: "Part 2 consent", hours: null });
    });

    it("expands each of the presenter's four notes to the captured entry it describes", () => {
        const w = rosa();
        expect(expand(w, ".9 call w/ client", "t1")).toBe("e1");   // the Teams kickoff with P. Raman and M. Bell
        expect(expand(w, "theo .3", "t2")).toBe("e3");             // the conference with T. Navarro
        expect(expand(w, "consent .5", "t3")).toBe("e5");          // the Part 2 consent and BAA review
        expect(expand(w, "call PR re CA .25", "t4")).toBe("e6");   // the suggested phone call with P. Raman about California
        expect(() => validate(w)).not.toThrow();
    });

    it("matches the same way whatever order the notes are expanded in", () => {
        const w = rosa();
        expect(expand(w, "call PR re CA .25", "a")).toBe("e6");
        expect(expand(w, "call w/ client", "b", "0.9")).toBe("e1");
    });

    it("takes the hours from the hours field when it is filled in", () => {
        const w = rosa();
        const r = addTypedRow(w, { date: day, note: "call w/ client", hours: "54m", projectID: "p1" }, "t");
        expect(r).toMatchObject({ hours: 0.9, description: "call w/ client", origin: "manual", linked: false, entryID: null });
        expect(() => addTypedRow(w, { date: day, note: "call", projectID: "p1" }, "u")).toThrow(/hours/);
        expect(() => addTypedRow(w, { date: day, note: "  ", hours: ".5" }, "v")).toThrow(/note/);
    });

    it("never lets two notes claim the same captured entry", () => {
        const w = rosa();
        expect(expand(w, ".9 call w/ client", "t1")).toBe("e1");
        // The kickoff is taken. No other entry is a call naming the client, so the second note finds nothing
        // rather than the kickoff again or the internal conference with T. Navarro.
        expect(claimed(w, "t2").has("e1")).toBe(true);
        expect(expand(w, ".9 call w/ client", "t2")).toBeNull();
        expect(w.imported!.find((r) => r.id === "t2")!.sameAs).toBe("t1"); // shown as "same work as the note above"
        // A note that is clearly the suggested call still finds it.
        expect(expand(w, "call PR re CA .25", "t3")).toBe("e6");
    });

    it("says nothing matches when no captured work of that day and matter has anything in common", () => {
        const w = rosa();
        expect(expand(w, ".5 lunch with partners", "t")).toBeNull();
        expect(() => decideRow(w, "t", "use")).toThrow(/No captured work/);
    });
});

describe("accepting a typed note", () => {
    it("adds no hours: the note folds into the entry it matched, which keeps the hours Time Capture recorded", () => {
        const w = rosa();
        const before = billed(w);
        const lines = feeLines(w, terms, activeRules(w, terms)).length;
        expand(w, ".9 call w/ client", "t1");
        decideRow(w, "t1", "use");
        expect(billed(w)).toEqual(before);
        expect(feeLines(w, terms, activeRules(w, terms))).toHaveLength(lines);
        expect(w.entries).toHaveLength(7);
        const e1 = w.entries.find((e) => e.id === "e1")!;
        expect(e1.hours).toBe(0.6); // recorded, not the 0.9 typed
        expect(e1.typed).toMatchObject({ note: "call w/ client", hours: 0.9, rowID: "t1", origin: "manual" });
    });

    it("confirms a suggested entry the person's note vouches for, and bills it once", () => {
        const w = rosa();
        const before = billed(w);
        expand(w, "call PR re CA .25", "t4");
        decideRow(w, "t4", "use");
        const after = billed(w);
        // The suggested call is now on the bill at its recorded 0.3 h, once: not 0.25 typed plus 0.3 captured.
        expect(after.billedHours).toBeCloseTo(before.billedHours + 0.3, 5);
        expect(after.fees).toBeCloseTo(before.fees + 0.3 * 1075, 2);
        expect(w.entries.find((e) => e.id === "e6")!.status).toBeUndefined();
        // Deciding again, or switching to Keep mine, never adds it twice.
        decideRow(w, "t4", "use");
        decideRow(w, "t4", "keep");
        expect(billed(w).billedHours).toBeCloseTo(after.billedHours, 5);
    });

    it("Keep mine puts the person's words in as the narrative and keeps the sources; Undo puts the entry back exactly", () => {
        const w = rosa();
        const original = structuredClone(w.entries.find((e) => e.id === "e6")!);
        expand(w, "call PR re CA .25", "t4");
        decideRow(w, "t4", "keep");
        const e6 = w.entries.find((e) => e.id === "e6")!;
        expect(e6).toMatchObject({ description: "call PR re CA", partsEdited: true });
        expect(e6.drafted).toBeUndefined();
        expect(e6.parts).toEqual(original.parts);
        decideRow(w, "t4", null);
        expect(w.entries.find((e) => e.id === "e6")).toEqual(original);
        expect(w.imported!.find((r) => r.id === "t4")).toMatchObject({ decision: null, linked: true, entryID: "e6" });
    });

    it("editing a note undoes its decision and asks for it to be expanded again", () => {
        const w = rosa();
        const original = structuredClone(w.entries.find((e) => e.id === "e1")!);
        expand(w, ".9 call w/ client", "t1");
        decideRow(w, "t1", "keep");
        const r = editTypedRow(w, "t1", { description: "call w/ P. Raman and M. Bell", hours: "36m" });
        expect(r).toMatchObject({ linked: false, entryID: null, decision: null, hours: 0.6 });
        expect(w.entries.find((e) => e.id === "e1")).toEqual(original);
        expect(expandRow(w, "t1").entryID).toBe("e1");
    });

    it("removing a note, or clearing an import, puts back what it changed; notes added here survive a clear", () => {
        const w = rosa();
        const original = structuredClone(w.entries);
        expand(w, "call PR re CA .25", "manual");
        decideRow(w, "manual", "use");
        w.imported!.push({ id: "imp", date: day, matter: "61407-002", timekeeper: "RD", hours: 0.5, description: "consent", entryID: null, decision: null, linked: false, origin: "import" });
        expect(linkAll(w)).toEqual(["imp"]);
        decideRow(w, "imp", "keep");
        clearImports(w);
        expect(w.imported!.map((r) => r.id)).toEqual(["manual"]);
        expect(w.entries.find((e) => e.id === "e5")).toEqual(original.find((e) => e.id === "e5"));
        removeTypedRow(w, "manual");
        expect(w.imported).toBeUndefined();
        expect(w.entries).toEqual(original);
    });

    it("links all imported rows without taking an entry a note already claims", () => {
        const w = rosa();
        expand(w, ".9 call w/ client", "mine");
        const row = (id: string, description: string, hours: number) => ({ id, date: day, matter: "Northlake", timekeeper: "RD", hours, description, entryID: null, decision: null, linked: false, origin: "import" as const });
        w.imported!.push(row("i1", "phone call with client", 0.9), row("i2", "w/ Theo re matrix", 0.3));
        linkAll(w);
        const byID = new Map(w.imported!.map((r) => [r.id, r.entryID]));
        expect(byID.get("mine")).toBe("e1");
        expect(byID.get("i1")).not.toBe("e1");
        expect(byID.get("i2")).toBe("e3");
        expect(() => validate(w)).not.toThrow();
    });
});
