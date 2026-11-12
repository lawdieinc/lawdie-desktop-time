import { describe, expect, it } from "vitest";
import { emptyWorkspace, PERSONAL, type Activity, type Project, type TimeEntry, type Workspace } from "./model";
import { addRulebook, saveClientRule } from "./clientRulebooks";
import { fold, searchWorkspace, snippetOf, SNIPPET_CHARS } from "./search";

const EPOCH = Date.parse("2026-11-10T15:00:00.000Z");
const iso = (s: number) => new Date(EPOCH + s * 1000).toISOString();
let n = 0;
const ID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const activity = (over: Partial<Activity> = {}): Activity => ({ id: ID(), app: "Word", ownerID: "com.microsoft.Word", title: "Lease v3.docx", startedAt: iso(0), endedAt: iso(600), endedBy: "switched", disposition: "pending", ...over });
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: `Matter ${id}`, client: "Acme Inc.", color: "#000", hourlyRate: 500, archived: false, ...extra });
const entry = (id: string, projectID: string | null, description: string, startedAt = iso(0), extra: Partial<TimeEntry> = {}): TimeEntry => ({
    id, description, projectID, startedAt, endedAt: new Date(Date.parse(startedAt) + 3_600_000).toISOString(), billable: true, hourlyRate: 500, source: "desktop", activityID: null, ...extra,
} as TimeEntry);

function workspace(): Workspace {
    const w = emptyWorkspace();
    w.projects.push(project("p1", { name: "Whitfield v. Harmon", client: "Whitfield Holdings", matterNumber: "104882-0001", aliases: ["Harmon litigation"] }),
        project("p2", { name: "Northlake lease", client: "Northlake Behavioral Health", archived: true }));
    return w;
}
const kinds = (w: Workspace, q: string) => searchWorkspace(w, q).map((g) => g.kind);
const titles = (w: Workspace, q: string, kind: string) => searchWorkspace(w, q).find((g) => g.kind === kind)?.hits.map((h) => h.title) ?? [];

describe("searching the workspace", () => {
    it("finds nothing for a blank query", () => {
        expect(searchWorkspace(workspace(), "   ")).toEqual([]);
    });

    it("finds a matter by name, number, client or an old name, ignoring case and accents, and opens it", () => {
        const w = workspace();
        for (const q of ["whitfield", "104882", "HOLDINGS", "harmon lit", "WHÎTFIELD"]) expect(titles(w, q, "matter")).toEqual(["Whitfield v. Harmon"]);
        expect(searchWorkspace(w, "whitfield")[0].hits[0].target).toEqual({ route: "matters", project: "p1" });
        expect(searchWorkspace(w, "northlake")[0].hits[0].detail).toContain("archived");
    });

    it("needs every word, in any order", () => {
        const w = workspace();
        expect(titles(w, "harmon whitfield", "matter")).toEqual(["Whitfield v. Harmon"]);
        expect(titles(w, "whitfield northlake", "matter")).toEqual([]);
    });

    it("ranks a name that starts with the query above one that has it inside, and the name above the details", () => {
        const w = emptyWorkspace();
        w.projects.push(project("a", { name: "Lease review for Acme" }), project("b", { name: "Acme lease" }), project("c", { name: "Other", client: "Acme" }));
        expect(titles(w, "acme", "matter")).toEqual(["Acme lease", "Lease review for Acme", "Other"]);
    });

    it("finds time waiting for review by matter, document, summary, meeting or screen text, and opens its row", () => {
        const w = workspace();
        const a = activity({ matter: "Whitfield v. Harmon", summary: { text: "Revised the indemnity clause", source: "kiwi" } });
        const b = activity({ title: "Inbox", app: "Outlook", screenText: `${"x ".repeat(80)}the deposition schedule for Harmon ${"y ".repeat(80)}`, startedAt: iso(4000), endedAt: iso(4600) });
        const c = activity({ title: "Zoom", app: "Zoom", meeting: { id: "m1", subject: "Settlement call", with: ["Dana Ortiz"], provider: "google", online: null }, startedAt: iso(9000), endedAt: iso(9600) });
        w.activities.push(a, b, c);
        expect(titles(w, "indemnity", "review")).toEqual(["Whitfield v. Harmon"]);
        expect(titles(w, "lease v3", "review")).toEqual(["Whitfield v. Harmon"]);
        expect(titles(w, "settlement", "review")).toEqual(["Settlement call"]);
        expect(titles(w, "ortiz", "review")).toEqual(["Settlement call"]);
        const hit = searchWorkspace(w, "deposition").find((g) => g.kind === "review")!.hits[0];
        expect(hit.target).toEqual({ route: "activity", row: b.id });
        expect(hit.snippet).toContain("deposition schedule");
        expect(hit.snippet!.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2);
    });

    it("never finds Personal time, reviewed sittings or the tutorial's sample", () => {
        const w = workspace();
        w.activities.push(activity({ matter: PERSONAL, matterBy: "person", title: "Football pool" }), activity({ title: "Football kept", disposition: "kept" }), activity({ id: "tutorial-1", title: "Football sample" }));
        expect(searchWorkspace(w, "football")).toEqual([]);
    });

    it("finds kept time by description, matter or code and opens its day; a dismissed entry is not found", () => {
        const w = workspace();
        w.entries.push(entry("e1", "p1", "Drafted motion to compel", "2026-11-03T15:00:00.000Z", { taskCode: "L210" }), entry("e2", null, "Drafted letter"), entry("e3", "p1", "Drafted nothing", iso(0), { status: "dismissed" }));
        expect(titles(w, "drafted", "entry")).toEqual(["Drafted letter", "Drafted motion to compel"]);
        expect(titles(w, "whitfield compel", "entry")).toEqual(["Drafted motion to compel"]);
        expect(titles(w, "l210", "entry")).toEqual(["Drafted motion to compel"]);
        // The matter is already the line under the title: no snippet repeats it.
        expect(searchWorkspace(w, "whitfield compel").find((g) => g.kind === "entry")!.hits[0].snippet).toBeNull();
        const hit = searchWorkspace(w, "compel").find((g) => g.kind === "entry")!.hits[0];
        expect(hit.target).toMatchObject({ route: "today", entry: "e1" });
        expect((hit.target as { day: string }).day).toMatch(/^2026-11-0[34]$/); // local day of the entry
    });

    it("finds a client's rulebook and its rules by their words, and opens the rule", () => {
        const w = workspace();
        const key = addRulebook(w, { client: "Northlake Behavioral Health" });
        const id = saveClientRule(w, key, { kind: "tenths", title: "Tenth-hour increments", section: "§4.1", quote: "Time is recorded in tenths of an hour." });
        expect(titles(w, "tenths", "rule")).toEqual(["Tenth-hour increments"]);
        expect(searchWorkspace(w, "recorded in tenths").find((g) => g.kind === "rule")!.hits[0].target).toEqual({ route: "rules", book: key, rule: id });
        expect(titles(w, "northlake", "rule")[0]).toBe("Northlake Behavioral Health rules");
        expect(kinds(w, "northlake")).toEqual(["matter", "rule"]);
    });

    it("finds an invoice by number or matter and opens its matter", () => {
        const w = workspace();
        w.invoices = [{ number: "INV-0042", projectID: "p1", client: "Whitfield Holdings", matter: "104882-0001", from: "2026-10-01", to: "2026-10-31", mode: "generic", issuedAt: iso(0), total: 1200, entryIDs: [] }];
        expect(titles(w, "0042", "invoice")).toEqual(["Invoice INV-0042"]);
        expect(searchWorkspace(w, "inv-0042")[0].hits[0].target).toEqual({ route: "matters", project: "p1" });
    });

    it("shows five a group and counts the rest, newest first", () => {
        const w = emptyWorkspace();
        for (let i = 0; i < 8; i++) w.entries.push(entry(`e${i}`, null, `Call ${i}`, iso(i * 7200)));
        const g = searchWorkspace(w, "call")[0];
        expect(g.hits.map((h) => h.title)).toEqual(["Call 7", "Call 6", "Call 5", "Call 4", "Call 3"]);
        expect(g.more).toBe(3);
    });
});

describe("snippets", () => {
    it("folds accents and case", () => expect(fold("  Ébauche  DU  Contrat ")).toBe("ebauche du contrat"));
    it("keeps a short field whole and cuts a long one around the match", () => {
        expect(snippetOf(["Short text here"], ["text"])).toBe("Short text here");
        const long = `${"a".repeat(200)} needle ${"b".repeat(200)}`;
        const s = snippetOf([long], ["needle"])!;
        expect(s.startsWith("…") && s.endsWith("…") && s.includes("needle")).toBe(true);
        expect(snippetOf(["nothing"], ["needle"])).toBeNull();
    });
});
