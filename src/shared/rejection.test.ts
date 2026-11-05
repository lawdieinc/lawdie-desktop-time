import { describe, expect, it } from "vitest";
import { emptyWorkspace, issueInvoice, validate, WorkspaceError, type Project, type TimeEntry } from "./model";
import { recordRejection, rejectionProposals, resubmits } from "./rejection";
import { billable } from "./invoice";

const NOTE = `Thanks for the invoice. A few things before we can pay it.
1. The 9/3 entry lists four tasks in one line; we need one task per entry.
2. Research is billed at $1,195 an hour; our engagement letter caps research at $450.
3. The 9/18 conference with P. Natarajan is an internal conference and should not be charged.
4. Several entries (e.g. "Review file") are too vague to approve.
Please resubmit.`;

const project = (id: string, client: string): Project => ({ id, name: `Matter ${id}`, client, color: "#000", hourlyRate: 1195, archived: false });
const entry = (id: string, projectID: string): TimeEntry => ({
    id, description: `Work ${id}`, projectID, startedAt: "2026-10-20T14:00:00.000Z", endedAt: "2026-10-20T15:00:00.000Z",
    billable: true, hourlyRate: 1195, source: "desktop", activityID: null, createdAt: "2026-10-20T15:00:00.000Z", updatedAt: "2026-10-20T15:00:00.000Z", synced: false,
} as TimeEntry);

describe("a client's rejection", () => {
    it("reads the rules the note states, one per sentence, each quoting it", () => {
        const p = rejectionProposals(NOTE);
        expect(p.map((x) => [x.rule.kind, x.rule.check ?? x.rule.rate ?? x.rule.activityCode ?? null])).toEqual([["split", null], ["rateCap", 450], ["noCharge", "A105"], ["check", "vague"]]);
        expect(p[0].sentence).toBe("1. The 9/3 entry lists four tasks in one line; we need one task per entry.".split("; ")[1]);
        expect(p[1].rule.title).toBe("Rate cap on research");
        expect(p[1].rule.quote).toContain("$450");
        expect(rejectionProposals("Looks good, thanks.")).toEqual([]);
        expect(rejectionProposals("Please cap calls at 0.5 hours. Bill in tenths of an hour.").map((x) => [x.rule.kind, x.rule.maxHours ?? null])).toEqual([["callCap", 0.5], ["tenths", null]]);
    });

    it("sends the invoice's entries back as flagged with the client's words, and puts the approved rules on the client's rulebook", () => {
        const w = emptyWorkspace();
        w.projects.push(project("a", "Acme Inc."));
        w.entries.push(entry("e1", "a"), entry("e2", "a"), entry("e3", "a"));
        issueInvoice(w, { number: "2026-041", projectID: "a", client: "Acme Inc.", matter: "Matter a", from: "2026-10-01", to: "2026-10-31", mode: "generic", issuedAt: "2026-11-01T12:00:00.000Z", total: 3585, entryIDs: ["e1", "e2"] });
        expect(billable(w).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
        const approved = rejectionProposals(NOTE).filter((p) => p.rule.kind !== "check").map((p) => p.rule);
        const r = recordRejection(w, { number: "2026-041", by: "Rosa Delacroix", note: NOTE, at: "2026-11-04T12:00:00.000Z" }, approved);
        expect(r).toEqual({ flagged: 2, ruleIDs: ["AI-1", "AI-2", "AI-3"], rulebookKey: "acme-inc" });
        expect(w.entries.map((e) => e.status ?? null)).toEqual(["flagged", "flagged", null]);
        expect(w.entries[0].why).toMatch(/^Sent back by Rosa Delacroix: Thanks for the invoice/);
        expect(billable(w).map((e) => e.id)).toEqual(["e3"]);
        const book = w.clientRulebooks![0];
        expect(book.client).toBe("Acme Inc.");
        expect(book.rules.map((x) => [x.id, x.kind, x.section])).toEqual([["AI-1", "split", "Rejection of invoice 2026-041"], ["AI-2", "rateCap", "Rejection of invoice 2026-041"], ["AI-3", "noCharge", "Rejection of invoice 2026-041"]]);
        expect(book.rules[1].quote).toContain("engagement letter caps research at $450");
        expect(w.invoices![0].rejection).toMatchObject({ by: "Rosa Delacroix", ruleIDs: ["AI-1", "AI-2", "AI-3"] });
        expect(resubmits(w, "a")?.number).toBe("2026-041");
        expect(resubmits(w, "b")).toBeNull();
        expect(() => recordRejection(w, { number: "2026-041", by: "", note: "again", at: "2026-11-04T12:00:00.000Z" }, [])).toThrow(WorkspaceError);
        expect(() => recordRejection(w, { number: "nope", by: "", note: "x", at: "2026-11-04T12:00:00.000Z" }, [])).toThrow(WorkspaceError);
        expect(() => validate(w)).not.toThrow();
        // Once the next invoice goes out for the matter, nothing is being resubmitted any more.
        issueInvoice(w, { number: "2026-042", projectID: "a", client: "Acme Inc.", matter: "Matter a", from: "2026-10-01", to: "2026-10-31", mode: "acme-inc", issuedAt: "2026-11-05T12:00:00.000Z", total: 3000, entryIDs: ["e1", "e2"] });
        expect(resubmits(w, "a")).toBeNull();
    });
});
