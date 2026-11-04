/* Test fixture: Rosa Delacroix's day on 61407-002 as the demo seed writes it, small enough to read. Five entries, a
   suggested phone call and a flagged stretch, with the work Time Capture saw. Used by the invoice and typed-entry tests;
   not part of the app. */

import { tenths } from "../invoice";
import { emptyWorkspace, type InvoiceTerms, type TimeEntry, type Workspace } from "../model";

export const day = "2026-10-26";
export const at = (hhmm: string, plus = 0): string => new Date(new Date(`${day}T${hhmm}:00`).getTime() + plus * 60_000).toISOString();

let n = 0;
const entry = (start: string, minutes: number, description: string, over: Partial<TimeEntry> = {}): TimeEntry => ({
    id: `e${++n}`, description, projectID: "p1", startedAt: at(start), endedAt: at(start, minutes), billable: true, hourlyRate: 1195,
    source: "desktop", activityID: null, hours: tenths(minutes), parts: [{ text: description, evidence: [], slot: null }],
    work: [{ app: "Microsoft Teams", title: description, startedAt: at(start), minutes }], status: "draft", drafted: "kiwi", ...over,
});

/** e1 Teams kickoff, e2 HVHP agreement, e3 T. Navarro conference, e4 research and matrix, e5 Part 2, e6 suggested call, e7 flagged. */
export function rosa(): Workspace {
    n = 0;
    const w = emptyWorkspace();
    w.projects = [{ id: "p1", name: "61407-002 Hudson Valley Health Plan provider agreement", client: "Northlake Behavioral Health", color: "gold", hourlyRate: 1195, archived: false }];
    w.profile = { name: "Rosa Delacroix", timekeeper: "10417" };
    w.entries = [
        entry("09:15", 36, "Teams conference with P. Raman and M. Bell (Northlake) regarding HVHP rates.", { activityCode: "A106",
            work: [{ app: "Microsoft Teams", title: "Northlake / Manatt kickoff (61407-002) | Microsoft Teams", startedAt: at("09:15"), minutes: 36 }] }),
        entry("09:58", 100, "Review and revise HVHP participating provider agreement.", { activityCode: "A103",
            work: [{ app: "Google Chrome", title: "HVHP v3 - Kiwi", startedAt: at("09:58"), minutes: 52 }, { app: "Microsoft Word", title: "HVHP redline.docx", startedAt: at("10:55"), minutes: 48 }] }),
        entry("12:30", 18, "Conference with T. Navarro regarding licensure matrix format.", { activityCode: "A105", work: [{ app: "Microsoft Teams", title: "Rosa / Theo: Northlake licensure matrix", startedAt: at("12:30"), minutes: 18 }] }),
        entry("13:05", 95, "Research telehealth licensure and prescribing rules for six states; prepare licensure and prescribing matrix for MAT program.", { activityCode: "A102",
            work: [{ app: "Google Chrome", title: "research", startedAt: at("13:05"), minutes: 41 }, { app: "Microsoft Excel", title: "matrix.xlsx", startedAt: at("13:52"), minutes: 54 }] }),
        entry("14:55", 26, "Review Northlake 42 CFR Part 2 consent form and BAA template.", { activityCode: "A104",
            work: [{ app: "Adobe Acrobat", title: "Northlake 42 CFR Part 2 Consent and BAA template 61407-002.pdf", startedAt: at("14:55"), minutes: 26 }] }),
        entry("16:10", 15, "Telephone conference with P. Raman regarding California timing.", { status: "suggested", why: "Built from the calendar hold.",
            work: [{ app: "Phone", title: "Call Priya re CA (calendar)", startedAt: at("16:10"), minutes: 15 }] }),
        entry("16:31", 11, "", { status: "flagged", projectID: null, billable: false, drafted: undefined, parts: [],
            work: [{ app: "Microsoft Word", title: "Document1 - Word", startedAt: at("16:31"), minutes: 11 }] }),
    ];
    return w;
}

export const terms: InvoiceTerms = { firm: { name: "Firm", address: [] }, billTo: [], client: "61407", matter: "61407-002", matterName: "x", number: "712418", through: "October 31, 2026",
    rateCap: 1075, noChargeActivity: "A105", noChargeRule: "Northlake OCG §5.1", terms: "Due within 30 days", timekeeper: { name: "R. Delacroix", title: "Partner" } };
