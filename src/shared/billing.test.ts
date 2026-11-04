import { describe, expect, it } from "vitest";
import { emptyWorkspace, invoiceIssued, nextInvoiceNumber, setBilling, setBillingFile, updateProject, validate, WorkspaceError, type Project, type TimeEntry, type Workspace } from "./model";
import { billable, contextOf, termsFor, termsOf } from "./invoice";
import { applyRules } from "./applyRules";
import { logoCandidates, siteURL } from "./logo";

const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: `Matter ${id}`, client: "Acme Inc.", color: "#000", hourlyRate: 500, archived: false, ...extra });
const entry = (id: string, projectID: string, day: string, hours = 1): TimeEntry => ({
    id, description: `Work on ${id}`, projectID, startedAt: `${day}T14:00:00.000Z`, endedAt: `${day}T${String(14 + hours).padStart(2, "0")}:00:00.000Z`,
    billable: true, hourlyRate: 500, source: "desktop", activityID: null, createdAt: `${day}T15:00:00.000Z`, updatedAt: `${day}T15:00:00.000Z`, synced: false,
} as TimeEntry);

function firm(): Workspace {
    const w = emptyWorkspace();
    w.projects.push(project("a", { matterNumber: "104882-0001", billTo: ["Rosa Delacroix, Acme Inc.", "200 Peachtree St"] }), project("b", { client: "Kestrel" }));
    w.entries.push(entry("e1", "a", "2026-10-05"), entry("e2", "a", "2026-10-20", 2), entry("e3", "b", "2026-10-20"), entry("e4", "a", "2026-11-02"));
    setBilling(w, { firm: { name: "  Lawdie LLP ", address: ["100 Main St", "", "Atlanta, GA 30303"] }, timekeeper: { name: "R. Delacroix", title: "Partner" }, terms: "Net 30", remit: ["Check: Lockbox 1"], invoicePrefix: "2026-", nextInvoice: 12 });
    return w;
}

describe("billing set up by a person (Settings → Billing)", () => {
    it("keeps the firm's details trimmed, drops blank lines, and needs the firm's name", () => {
        const w = firm();
        expect(w.billing).toMatchObject({ firm: { name: "Lawdie LLP", address: ["100 Main St", "Atlanta, GA 30303"] }, timekeeper: { name: "R. Delacroix", title: "Partner" }, terms: "Net 30", remit: ["Check: Lockbox 1"], invoicePrefix: "2026-", nextInvoice: 12 });
        expect(w.billing).not.toHaveProperty("contact");
        expect(() => setBilling(w, { firm: { name: " ", address: [] }, timekeeper: { name: "", title: "" } })).toThrow(WorkspaceError);
        expect(() => validate(w)).not.toThrow();
    });

    it("numbers invoices from the prefix and moves the counter on when one is made", () => {
        const w = firm();
        expect(nextInvoiceNumber(w)).toBe("2026-012");
        invoiceIssued(w);
        expect(nextInvoiceNumber(w)).toBe("2026-013");
        expect(nextInvoiceNumber(emptyWorkspace())).toBe("001");
    });

    it("keeps the logo and folder through a save of the text fields, and can drop them", () => {
        const w = firm();
        setBillingFile(w, "logo", "/x/billing-logo.png");
        setBillingFile(w, "folder", "/x/invoices");
        setBilling(w, { ...w.billing!, terms: "Net 45" });
        expect(w.billing).toMatchObject({ logo: "/x/billing-logo.png", folder: "/x/invoices", terms: "Net 45" });
        setBillingFile(w, "logo", null);
        expect(w.billing).not.toHaveProperty("logo");
        expect(() => setBillingFile(emptyWorkspace(), "logo", "/x")).toThrow(WorkspaceError);
    });

    it("puts the matter number, bill-to lines and code set on a matter, and refuses a code set that is not UTBMS", () => {
        const w = firm();
        updateProject(w, "b", { matterNumber: " K-7 ", billTo: ["Tom Ashby", "", "Kestrel"], codeSet: "litigation" });
        expect(w.projects[1]).toMatchObject({ matterNumber: "K-7", billTo: ["Tom Ashby", "Kestrel"], codeSet: "litigation" });
        updateProject(w, "b", { matterNumber: "", billTo: [], codeSet: null });
        expect(w.projects[1]).not.toHaveProperty("matterNumber");
        expect(w.projects[1]).not.toHaveProperty("billTo");
        expect(w.projects[1]).not.toHaveProperty("codeSet");
        expect(() => updateProject(w, "b", { codeSet: "tax" as never })).toThrow(WorkspaceError);
        expect(() => validate(w)).not.toThrow();
    });

    it("gives the rules a matter's number, client and code set when a seed gave it no context", () => {
        expect(contextOf(project("a", { matterNumber: "1", codeSet: "project" }))).toEqual({ number: "1", client: "Acme Inc.", codeSet: "project", people: [], glossary: {} });
        expect(contextOf(project("a", { client: "" }))).toBeNull();
        expect(contextOf(null)).toBeNull();
    });
});

describe("an invoice for one matter over a period", () => {
    it("joins the firm's details with the matter's into the terms the invoice prints", () => {
        const w = firm();
        const t = termsFor(w, w.projects[0], "2026-10-31", nextInvoiceNumber(w));
        expect(t).toMatchObject({ firm: { name: "Lawdie LLP" }, billTo: ["Rosa Delacroix, Acme Inc.", "200 Peachtree St"], client: "Acme Inc.", matter: "104882-0001", matterName: "Matter a", number: "2026-012", through: "October 31, 2026", terms: "Net 30", timekeeper: { name: "R. Delacroix", title: "Partner" }, remit: ["Check: Lockbox 1"] });
        // Without bill-to lines the client's name is the bill-to; without a number the name is the matter.
        expect(termsFor(w, w.projects[1])).toMatchObject({ billTo: ["Kestrel"], matter: "Matter b", through: "", number: "" });
        // No setup and no seed: plain terms, the day bill still works.
        expect(termsOf(emptyWorkspace())).toMatchObject({ firm: { name: "" }, billTo: [], number: "" });
    });

    it("bills only that matter's entries inside the period, to the last day inclusive", () => {
        const w = firm();
        expect(billable(w, { projectID: "a", from: "2026-10-01", to: "2026-10-31" }).map((e) => e.id)).toEqual(["e1", "e2"]);
        expect(billable(w, { projectID: "a", from: "2026-10-20", to: "2026-10-20" }).map((e) => e.id)).toEqual(["e2"]);
        expect(billable(w, "2026-10-20").map((e) => e.id)).toEqual(["e2", "e3"]);
        const bill = applyRules(w, null, "generic", { projectID: "a", from: "2026-10-01", to: "2026-10-31" });
        expect(bill.totals).toEqual({ hours: 3, billedHours: 3, fees: 1500 });
        expect(bill.scope).toEqual({ projectID: "a", from: "2026-10-01", to: "2026-10-31" });
        expect(applyRules(w, "2026-10-20", "generic").totals.fees).toBe(1500);
    });
});

describe("the firm's logo from its website", () => {
    it("reads what a person typed as a site", () => {
        expect(siteURL(" Lawdie.co ")).toBe("https://lawdie.co");
        expect(siteURL("https://www.lawdie.co/about?x=1")).toBe("https://www.lawdie.co");
        expect(siteURL("not a site")).toBeNull();
        expect(siteURL("")).toBeNull();
    });

    it("lists the page's pictures best first: touch icon, share image, sized icons, then the well-known paths; never SVG or data", () => {
        const html = `<html><head>
            <link rel="icon" href="/favicon.svg" type="image/svg+xml">
            <link rel="icon" sizes="32x32" href="/small.png">
            <link rel='icon' sizes='192x192' href='/icon-192.png'>
            <meta property="og:image" content="https://cdn.example.com/share.jpg?w=1200&amp;h=630">
            <link rel="apple-touch-icon" href="/touch.png">
            <meta name="twitter:image" content="data:image/png;base64,AAAA">
            <link rel="apple-touch-icon" href="/touch.png">
        </head></html>`;
        expect(logoCandidates(html, "https://example.com/")).toEqual([
            "https://example.com/touch.png",
            "https://cdn.example.com/share.jpg?w=1200&h=630",
            "https://example.com/icon-192.png",
            "https://example.com/apple-touch-icon.png", "https://example.com/apple-touch-icon-precomposed.png", "https://example.com/logo.png", "https://example.com/favicon.png", "https://example.com/favicon.ico",
            "https://example.com/small.png",
        ]);
        expect(logoCandidates("", "https://example.com")).toHaveLength(5);
    });
});
