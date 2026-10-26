import { describe, expect, it } from "vitest";
import { evidenceFor, modelBody, modelDrafter, modelPrompt, parseCited, rulesDrafter } from "./drafter";
import { editEntry, emptyWorkspace, parseWorkspace, setNarrative, SCHEMA_VERSION, validate, type Evidence, type TimeEntry, type Workspace } from "./model";

const evidence: Record<string, Evidence> = {
    "mtg-kickoff": { id: "mtg-kickoff", kind: "meeting", teams: true, subject: "Kickoff", attendees: ["Priya Raman", "Rosa Delacroix"], transcript: "tx-kickoff" },
    "tx-kickoff": { id: "tx-kickoff", kind: "transcript", meeting: "mtg-kickoff", lines: [{ t: "09:16:02", who: "Rosa Delacroix", text: "Exhibit B is under what Riverbend pays." }] },
    "hvhp-v3": { id: "hvhp-v3", kind: "document", file: "HVHP v3.pdf", title: "Agreement v3" },
};

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
    id: "e1", description: "Teams conference with P. Raman re: rate exhibit.", projectID: null,
    startedAt: "2026-10-26T13:15:00.000Z", endedAt: "2026-10-26T13:51:00.000Z", billable: true, hourlyRate: 1195, source: "desktop", activityID: null,
    raw: "phone call with client", status: "draft",
    parts: [{ text: "Teams conference with ", evidence: ["mtg-kickoff"], slot: "verb" }, { text: "P. Raman", evidence: ["mtg-kickoff"], slot: "participants" }, { text: " re: rate exhibit.", evidence: ["tx-kickoff"], slot: "purpose" }],
    sources: [{ id: "mtg-kickoff", kind: "meeting", label: "Teams meeting: Kickoff" }, { id: "tx-kickoff", kind: "transcript", label: "Teams transcript (sample)" }],
    ...over,
});

const ws = (e: TimeEntry): Workspace => ({ ...emptyWorkspace(), entries: [e], evidence });
const NOW = Date.parse("2026-10-27T00:00:00Z");

describe("narrative drafter", () => {
    it("rules returns the stored parts", async () => {
        const d = await rulesDrafter.draft(entry(), []);
        expect(d.narrative).toBe("Teams conference with P. Raman re: rate exhibit.");
        expect(d.parts).toHaveLength(3);
    });

    it("the model prompt carries the client rules, what was typed and every evidence id", () => {
        const p = modelPrompt(entry(), Object.values(evidence));
        expect(p).toContain("past tense");
        expect(p).toContain('typed: "phone call with client"');
        for (const id of Object.keys(evidence)) expect(p).toContain(`[${id}]`);
        expect(modelBody(entry(), Object.values(evidence), "61407-002").groups[0].id).toBe("e1");
    });

    it("parses cited phrases and drops a part that cites an unknown id", () => {
        const known = new Set(Object.keys(evidence));
        const parts = parseCited("Reviewed agreement v3 [hvhp-v3] with P. Raman [mtg-kickoff, tx-kickoff] and invented things [made-up].", known);
        expect(parts.map((p) => p.text)).toEqual(["Reviewed agreement v3", " with P. Raman", "."]);
        expect(parts[1].evidence).toEqual(["mtg-kickoff", "tx-kickoff"]);
        expect(parts[2].evidence).toEqual([]);
    });

    it("the model drafter answers through the drafts route and fails on an empty answer", async () => {
        const send = async () => ({ drafts: [{ id: "e1", text: "Conferred with P. Raman [mtg-kickoff] re: rates [tx-kickoff]." }] });
        const d = await modelDrafter(send, null).draft(entry(), Object.values(evidence));
        expect(d.drafter).toBe("model");
        expect(d.narrative).toBe("Conferred with P. Raman re: rates.");
        await expect(modelDrafter(async () => ({ drafts: [] }), null).draft(entry(), [])).rejects.toThrow();
    });

    it("collects an entry's evidence with each meeting's transcript", () => {
        expect(evidenceFor(entry({ sources: [{ id: "mtg-kickoff", kind: "meeting", label: "" }], parts: [] }), evidence).map((e) => e.id)).toEqual(["mtg-kickoff", "tx-kickoff"]);
    });
});

describe("entries with narratives", () => {
    it("reads a version 2 workspace and writes it back as the current version", () => {
        const v2 = { ...emptyWorkspace(), schemaVersion: 2 };
        expect(parseWorkspace(JSON.stringify(v2)).schemaVersion).toBe(SCHEMA_VERSION);
        expect(() => parseWorkspace(JSON.stringify({ ...v2, schemaVersion: SCHEMA_VERSION + 1 }))).toThrow(/newer/);
    });

    it("validates parts, sources, status and evidence", () => {
        expect(() => validate(ws(entry()))).not.toThrow();
        expect(() => validate(ws(entry({ status: "maybe" as never })))).toThrow();
        expect(() => validate({ ...ws(entry()), evidence: { x: { id: "y", kind: "email" } } })).toThrow();
    });

    it("an edit keeps what was typed and the sources and marks the parts edited", () => {
        const w = ws(entry());
        const next = editEntry(w, "e1", { description: "Call with Priya about rates." }, NOW);
        expect(next.partsEdited).toBe(true);
        expect(next.raw).toBe("phone call with client");
        expect(next.sources).toHaveLength(2);
        const again = setNarrative(w, "e1", entry().parts!, "rules", NOW);
        expect(again.partsEdited).toBeUndefined();
        expect(again.description).toBe("Teams conference with P. Raman re: rate exhibit.");
    });

    it("confirm settles a suggestion; a flagged entry needs a matter and a narrative", () => {
        const w = ws(entry({ status: "suggested", why: "From history" }));
        expect(editEntry(w, "e1", { confirm: true }, NOW).status).toBeUndefined();
        const p = { id: "p1", name: "61407-002", client: "Northlake", color: "gold", hourlyRate: 1195, archived: false };
        const f = { ...ws(entry({ status: "flagged", why: "No matter" })), projects: [p] };
        expect(editEntry(f, "e1", { confirm: true }, NOW).status).toBe("flagged");
        const done = editEntry(f, "e1", { projectID: "p1", description: "Drafted letter to P. Raman.", confirm: true }, NOW);
        expect(done.status).toBeUndefined();
        expect(done.projectID).toBe("p1");
    });
});
