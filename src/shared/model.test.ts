import { describe, expect, it } from "vitest";
import {
    closeActivity, deleteEntry, dismissActivities, emptyWorkspace, keepActivity, keepStretch, markSynced, migrateV1, observe, parseWorkspace, prune,
    recover, saveEntry, seconds, secondsWithin, startTimer, stopTimer, stretchSpan, stretchesOf, syncBatches, syncRequest, validate, WorkspaceError, type Activity, type TimeEntry, type Workspace,
} from "./model";
import { applyDrafts, applyInsights, applyMatters, draftRequest, inboxOf, insightRequest, knownMatters, matterRequest, toReview } from "./matters";
import { SCREEN_TEXT_MAX, archiveProject, screenRecordingAttempt, cleanDocument, cleanScreenText, redact, mergeProjects, parseScreenText, setMatter, updateProject } from "./model";
import { activeCall, callApp, parseMacRecording, parseWindowsRecording } from "./calls";
import { KiwiClient, KiwiFailure, PRODUCTS, destinationLabel, isDestination, normalizeServerURL, productsFor, type Product } from "./kiwi";

// The Swift app's 20 core checks, carried over as the contract this engine keeps.

const EPOCH = 1_780_000_000_000; // 2026-05-28T20:26:40Z
const at = (s: number) => EPOCH + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
const WORD = { app: "Microsoft Word", ownerID: "com.microsoft.Word", title: null as string | null };
const PREVIEW = { app: "Preview", ownerID: "com.apple.Preview", title: null };

function capturing(): Workspace {
    const w = emptyWorkspace();
    w.preferences.captureEnabled = true;
    return w;
}
const activity = (over: Partial<Activity> = {}): Activity => ({ id: "a-" + Math.random(), app: "Word", ownerID: "com.microsoft.Word", title: null, startedAt: iso(0), endedAt: iso(600), endedBy: "switched", disposition: "pending", ...over });
const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({ id: "e-" + Math.random(), description: "Work", projectID: null, startedAt: iso(0), endedAt: iso(600), billable: false, hourlyRate: 0, source: "manual", activityID: null, ...over });

describe("capture", () => {
    it("requires opt-in, and titles require a separate opt-in", () => {
        const w = emptyWorkspace();
        observe(w, { ...WORD, title: "Secret" }, at(0), 0);
        expect(w.currentActivity).toBeNull();
        w.preferences.captureEnabled = true;
        observe(w, { ...WORD, title: "Secret" }, at(5), 0);
        expect(w.currentActivity?.title).toBeNull();
        w.preferences.captureTitles = true;
        observe(w, { ...WORD, title: "Document" }, at(10), 0);
        expect(w.currentActivity?.title).toBe("Document");
        expect(w.activities[0].title).toBeNull();
    });

    it("leaves browsers to the browser extension: a switch to one ends the segment and records nothing, titles or not", () => {
        const w = capturing();
        w.preferences.captureTitles = true;
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0);
        observe(w, { app: "Google Chrome", ownerID: "com.google.Chrome", title: "PACER – Whitfield v. Acme" }, at(10), 0);
        observe(w, { app: "Google Chrome", ownerID: "com.google.Chrome", title: "PACER – Whitfield v. Acme" }, at(15), 0);
        observe(w, { app: "msedge", ownerID: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", title: "Portal" }, at(20), 0);
        expect(w.currentActivity).toBeNull();
        expect(w.activities.map((a) => [a.app, a.endedBy])).toEqual([["Microsoft Word", "browser"]]);
        expect(JSON.stringify(w)).not.toContain("PACER");
    });

    it("reads on-screen text only when switched on, keeps the first read for the segment, and never splits on it", () => {
        const w = capturing();
        const ACROBAT = { app: "Acrobat", ownerID: "com.adobe.Acrobat.Pro", title: null };
        observe(w, { ...ACROBAT, screenText: "Exhibit A – design marks" }, at(0), 0);
        expect(w.currentActivity?.screenText).toBeUndefined();
        w.preferences.captureScreenText = true;
        observe(w, { ...PREVIEW, screenText: null }, at(5), 0);
        observe(w, { ...PREVIEW, screenText: "PRINCESS PILLOW LLC\nTrademark licence\n\nTrademark licence" }, at(10), 0);
        observe(w, { ...PREVIEW, screenText: "page 2 after scrolling" }, at(15), 0);
        expect(w.currentActivity?.screenText).toBe("PRINCESS PILLOW LLC\nTrademark licence");
        observe(w, WORD, at(20), 0);
        expect(w.activities.at(-1)).toMatchObject({ app: "Preview", screenText: "PRINCESS PILLOW LLC\nTrademark licence" });
    });

    it("takes personal details out of what was read, on this computer, and keeps what names the work", () => {
        // The shape of a real note the first live read picked up (made-up numbers; 4111… passes Luhn).
        const note = "Card details:\nNumber: 4111 1111 1111 1111\nExpiration date: 06/29\nCVC: 154\nCVV 987";
        expect(cleanScreenText(note)).toBe("Card details:\nNumber: [card]\nExpiration date: 06/29\nCVC: [redacted]\nCVV [redacted]");
        expect(redact("SSN 123-45-6789 · call (555) 123-4567 or +1 555 987 6543 · acct #: 00123456789 · Password: hunter2 · routing number: 021000021"))
            .toBe("SSN [ssn] · call [phone] or [phone] · acct #: [redacted] · Password: [redacted] · routing number: [redacted]");
        expect(redact("From dana.ortiz@princesspillow.com re invoice 9921")).toBe("From [email]@princesspillow.com re invoice 9921");
        expect(redact("Hardware UUID: 253C6F20-724C-5310-9720-D18F4624485D · ref 55209400296610")).toBe("Hardware UUID: [id] · ref [number]");
        // What names the work survives: case and matter numbers, dates, amounts, ordinary words.
        const work = "Whitfield v. Acme, 1:26-cv-01182 · matter 2026-144 · filed 2026-10-16 · $12,500.00 · pin the memo · password reset email";
        expect(redact(work)).toBe(work);
        expect(cleanDocument({ name: "Pay.docx", path: null, excerpt: "Wire to account number: 123456789 by Friday" })?.excerpt).toBe("Wire to account number: [redacted] by Friday");
    });

    it("bounds what a reader printed and tells an Accessibility refusal apart", () => {
        expect(parseScreenText("TEXT=Whitfield v. Acme\r\n  Docket   1:26-cv-01182 \n\nWhitfield v. Acme\n")).toEqual({ text: "Whitfield v. Acme\nDocket 1:26-cv-01182", untrusted: false });
        expect(parseScreenText("UNTRUSTED\n")).toEqual({ text: null, untrusted: true });
        expect(parseScreenText("TEXT=\n")).toEqual({ text: null, untrusted: false });
        expect(parseScreenText("garbage")).toEqual({ text: null, untrusted: false });
        expect(cleanScreenText("x".repeat(5000))).toHaveLength(SCREEN_TEXT_MAX);
    });

    it("a switch produces a bounded neutral segment", () => {
        const w = capturing();
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0); observe(w, PREVIEW, at(10), 0);
        expect(w.activities).toHaveLength(1);
        expect(w.activities[0]).toMatchObject({ endedBy: "switched", startedAt: iso(0), endedAt: iso(10) });
        expect(w.currentActivity?.app).toBe("Preview");
        expect(w.entries).toEqual([]);
    });

    it("an excluded app, the app itself, and a Windows executable on the list close the previous segment without capturing", () => {
        const w = capturing();
        observe(w, WORD, at(0), 0); observe(w, { app: "Passwords", ownerID: "com.apple.Passwords", title: null }, at(5), 0);
        expect(w.currentActivity).toBeNull();
        expect(w.activities).toHaveLength(1);
        expect(w.activities[0].endedBy).toBe("excluded");
        observe(w, WORD, at(8), 0);
        observe(w, { app: "Lawdie Time Capture", ownerID: "C:\\x\\lawdie.exe", title: null, isSelf: true }, at(12), 0);
        expect(w.currentActivity).toBeNull();
        expect(w.activities[1].endedBy).toBe("switched"); // coming to this app is not "a private app"
        observe(w, { app: "1Password", ownerID: "C:\\Program Files\\1Password\\1Password.exe", title: null }, at(15), 0);
        expect(w.currentActivity).toBeNull();
    });

    it("idle stops the timer at the last input and does not restart billing; capture goes on while the window is in front", () => {
        const w = capturing();
        w.preferences.idleMinutes = 1;
        startTimer(w, { description: "Draft", projectID: null, billable: true }, at(0));
        for (let s = 0; s <= 85; s += 5) observe(w, WORD, at(s), Math.max(0, s - 30));
        observe(w, WORD, at(90), 60);
        expect(w.timer).toBeNull();
        expect(w.entries[0].endedAt).toBe(iso(30));
        // An hour reading, no input: one segment, all of it.
        for (let s = 95; s <= 3600; s += 5) observe(w, WORD, at(s), s);
        expect(w.activities).toHaveLength(0);
        expect(w.currentActivity!.startedAt).toBe(iso(0));
        expect(w.currentActivity!.endedAt).toBe(iso(3600));
        expect(w.timer).toBeNull();
    });

    it("sleep stops the timer and capture", () => {
        const w = capturing();
        startTimer(w, { description: "Work", projectID: null, billable: false }, at(0));
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0); observe(w, WORD, at(9), 0, true);
        expect(w.timer).toBeNull(); expect(w.currentActivity).toBeNull();
        expect(w.entries[0].endedAt).toBe(iso(9));
        expect(w.activities[0].endedBy).toBe("suspended");
    });

    it("crash recovery never counts downtime", () => {
        const w = capturing();
        startTimer(w, { description: "Work", projectID: null, billable: false }, at(0));
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0);
        recover(w, at(8 * 3600));
        expect(w.entries[0].endedAt).toBe(iso(5));
        expect(w.activities[0]).toMatchObject({ endedAt: iso(5), endedBy: "crash-recovered" });
        expect(w.timer).toBeNull(); expect(w.currentActivity).toBeNull();
    });

    it("an unobserved gap is not time worked", () => {
        const w = capturing();
        startTimer(w, { description: "Work", projectID: null, billable: false }, at(0));
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0); observe(w, WORD, at(600), 0);
        expect(w.entries[0].endedAt).toBe(iso(5));
        expect(w.activities[0].endedAt).toBe(iso(5));
        expect(w.currentActivity?.startedAt).toBe(iso(600));
    });

    it("keeps Office document details only when switched on, and a new document is new work", () => {
        const w = capturing();
        const doc = { name: "Whitfield motion.docx", path: "/x/Whitfield motion.docx", excerpt: "Re:   Whitfield v. Meridian\n Matter 2026-014" };
        observe(w, { ...WORD, document: doc }, at(0), 0);
        expect(w.currentActivity?.document).toBeNull();
        w.preferences.captureDocuments = true;
        observe(w, { ...WORD, document: doc }, at(5), 0);
        expect(w.currentActivity?.document).toEqual({ name: "Whitfield motion.docx", path: "/x/Whitfield motion.docx", excerpt: "Re: Whitfield v. Meridian Matter 2026-014" });
        // A probe that failed once does not end the segment or lose what it knew.
        observe(w, { ...WORD, document: null }, at(10), 0);
        expect(w.currentActivity?.document?.name).toBe("Whitfield motion.docx");
        expect(w.activities).toEqual([]);
        // A different document is a different stretch of work.
        observe(w, { ...WORD, document: { name: "Lease.docx", path: null, excerpt: null } }, at(15), 0);
        expect(w.activities).toHaveLength(1);
        expect(w.activities[0].document?.name).toBe("Whitfield motion.docx");
        expect(w.currentActivity?.document).toEqual({ name: "Lease.docx", path: null, excerpt: null });
        const req = syncRequest(w, "t");
        expect(req.activities[0]).toMatchObject({ document_name: "Whitfield motion.docx", document_path: "/x/Whitfield motion.docx", excerpt: "Re: Whitfield v. Meridian Matter 2026-014" });
    });

    it("brief activity is discarded", () => {
        const w = capturing();
        observe(w, WORD, at(0), 0); closeActivity(w, at(1), "switched");
        expect(w.activities).toEqual([]);
    });
});

describe("timer and entries", () => {
    it("one timer at a time, with the rate frozen at start", () => {
        const w = emptyWorkspace();
        w.projects = [{ id: "p", name: "Matter", client: "", color: "gold", hourlyRate: 350, archived: false }];
        startTimer(w, { description: "Work", projectID: "p", billable: true }, at(0));
        expect(() => startTimer(w, { description: "Other", projectID: null, billable: false }, at(1))).toThrow();
        w.projects[0].hourlyRate = 500;
        stopTimer(w, at(3600));
        expect(w.entries[0].hourlyRate).toBe(350);
    });

    it("review is explicit and idempotent", () => {
        const w = emptyWorkspace();
        const a = activity(); w.activities = [a];
        keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700));
        expect(w.entries).toHaveLength(1);
        expect(w.activities[0].disposition).toBe("kept");
        expect(w.entries[0].activityID).toBe(a.id);
        expect(() => keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700))).toThrow();
    });

    it("overlaps are rejected; adjacent and self-edits are allowed", () => {
        const w = emptyWorkspace();
        const e = entry({ description: "One" });
        saveEntry(w, e, at(3600)); saveEntry(w, e, at(3600));
        expect(w.entries).toHaveLength(1);
        expect(() => saveEntry(w, entry({ startedAt: iso(599), endedAt: iso(800) }), at(3600))).toThrow();
        saveEntry(w, entry({ startedAt: iso(600), endedAt: iso(800) }), at(3600));
        startTimer(w, { description: "Running", projectID: null, billable: false }, at(900));
        expect(() => saveEntry(w, entry({ startedAt: iso(850), endedAt: iso(950) }), at(3600))).toThrow();
    });

    it("invalid and future entries are rejected", () => {
        const w = emptyWorkspace();
        for (const bad of [entry({ description: " " }), entry({ startedAt: iso(100), endedAt: iso(0) }), entry({ endedAt: iso(1000) }), entry({ hourlyRate: -10 })]) {
            expect(() => saveEntry(w, bad, at(600))).toThrow();
        }
    });

    it("a failed review does not mark the activity kept", () => {
        const w = emptyWorkspace();
        w.entries = [entry({ description: "Existing" })];
        const a = activity(); w.activities = [a];
        expect(() => keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700))).toThrow();
        expect(w.activities[0].disposition).toBe("pending");
        expect(w.entries).toHaveLength(1);
    });

    it("retention removes activity, never entries", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 7;
        w.activities = [activity({ endedAt: iso(60) })];
        w.entries = [entry({ endedAt: iso(60) })];
        prune(w, at(8 * 86400));
        expect(w.activities).toEqual([]);
        expect(w.entries).toHaveLength(1);
    });
});

describe("stretches", () => {
    const seg = (id: string, start: number, end: number, name: string, app = "Microsoft Word", extra: Partial<Activity> = {}): Activity =>
        ({ id, app, ownerID: `com.${app.replace(/\s/g, "")}`, title: null, document: { name, path: null, excerpt: null }, startedAt: iso(start), endedAt: iso(end), endedBy: "switched", disposition: "pending", ...extra });

    it("groups sittings on one document within the gap into one stretch, across other documents' sittings, and sets short hops apart", () => {
        const acts = [
            seg("a", 0, 600, "Hollis letter.docx"),
            seg("b", 600, 900, "Brantley schedule.xlsx", "Microsoft Excel"),
            seg("c", 900, 1500, "Hollis letter.docx"),
            seg("d", 1500, 1530, "Slack", "Slack", { document: null, title: "Slack" }),
            seg("e", 1530, 1800, "Brantley schedule.xlsx", "Microsoft Excel"),
            seg("f", 1800 + 20 * 60, 1800 + 20 * 60 + 300, "Hollis letter.docx"), // 20 minutes later: a new stretch
            seg("g", 100, 400, "Kept already.docx", "Microsoft Word", { disposition: "kept" }),
        ];
        const { stretches, short } = stretchesOf(acts);
        expect(stretches.map((st) => [st.name, st.sittings, st.seconds])).toEqual([
            ["Hollis letter.docx", 1, 300],
            ["Brantley schedule.xlsx", 2, 570],
            ["Hollis letter.docx", 2, 1200],
        ]);
        expect(stretches[2].activityIDs).toEqual(["a", "c"]);
        expect(stretches[2]).toMatchObject({ startedAt: iso(0), endedAt: iso(1500), endedBy: "switched" });
        expect(short.map((st) => [st.name, st.seconds])).toEqual([["Slack", 30]]);
    });

    it("reviews unnamed mail as one stretch per app, not one per message, so an hour of email is not a pile of short hops", () => {
        const mail = (id: string, start: number, end: number, subject: string) => seg(id, start, end, subject, "Microsoft Outlook", { ownerID: "com.microsoft.Outlook", document: null, title: subject });
        const acts = [mail("m1", 0, 40, "RE: Latitude SPA"), mail("m2", 40, 70, "Lunch?"), mail("m3", 70, 120, "FW: Board pack"), seg("w", 120, 400, "Latitude SPA.docx"), mail("m4", 400, 430, "RE: Latitude SPA")];
        const { stretches, short } = stretchesOf(acts);
        expect(stretches.map((st) => [st.name, st.sittings, st.seconds, st.document])).toEqual([["Latitude SPA.docx", 1, 280, { name: "Latitude SPA.docx", path: null, excerpt: null }], ["Microsoft Outlook", 4, 150, null]]);
        expect(short).toEqual([]);
    });

    it("keeps a stretch as one entry whose sittings alone count and alone block overlap, and reopens all of them on delete", () => {
        const w = emptyWorkspace();
        w.activities = [seg("a", 0, 600, "Hollis letter.docx"), seg("b", 600, 900, "Brantley schedule.xlsx", "Microsoft Excel"), seg("c", 900, 1500, "Hollis letter.docx")];
        const hollis = stretchesOf(w.activities).stretches.find((st) => st.sittings === 2)!;
        const entry = keepStretch(w, hollis.activityIDs, { description: "Drafted the Hollis letter", projectID: null, billable: true }, at(2000));
        expect(entry).toMatchObject({ startedAt: iso(0), endedAt: iso(1500), activityID: "a", activityIDs: ["a", "c"] });
        expect(entry.sittings).toEqual([{ startedAt: iso(0), endedAt: iso(600) }, { startedAt: iso(900), endedAt: iso(1500) }]);
        expect(seconds(entry)).toBe(1200);
        expect(secondsWithin(entry, at(500), at(1000))).toBe(200);
        expect(w.activities.filter((a) => a.disposition === "kept").map((a) => a.id)).toEqual(["a", "c"]);
        // The Excel sitting sits in the gap: it is still free to keep.
        const excel = keepActivity(w, "b", { description: "Schedule", projectID: null, billable: true }, at(2000));
        expect(excel.sittings).toBeUndefined();
        expect(seconds(excel)).toBe(300);
        // But nothing may land on a sitting.
        expect(() => saveEntry(w, { ...excel, id: "x", startedAt: iso(1000), endedAt: iso(1100) }, at(2000))).toThrow(WorkspaceError);
        // The wire request carries the worked seconds, which both servers honour.
        expect(syncRequest(w, "t").entries.find((e) => e.id === entry.id)?.seconds).toBe(1200);
        // Sittings must stay inside the span and in order.
        expect(() => saveEntry(w, { ...entry, id: "y", sittings: [{ startedAt: iso(0), endedAt: iso(2000) }] }, at(3000))).toThrow(WorkspaceError);
        deleteEntry(w, entry.id);
        expect(w.activities.filter((a) => a.disposition === "pending").map((a) => a.id)).toEqual(["a", "c"]);
        // A person can settle the span before keeping: several sittings are clipped to it,
        // a single sitting takes the span as given (the work may have started before capture).
        deleteEntry(w, excel.id);
        const trimmed = keepStretch(w, ["a", "c"], { description: "Hollis", projectID: null, billable: true, startedAt: iso(300), endedAt: iso(1200) }, at(3000));
        expect(trimmed.sittings).toEqual([{ startedAt: iso(300), endedAt: iso(600) }, { startedAt: iso(900), endedAt: iso(1200) }]);
        expect(seconds(trimmed)).toBe(600);
        deleteEntry(w, trimmed.id);
        const widened = keepStretch(w, ["b"], { description: "Schedule", projectID: null, billable: true, startedAt: iso(560), endedAt: iso(900) }, at(3000));
        expect(widened).toMatchObject({ startedAt: iso(560), endedAt: iso(900) });
        expect(seconds(widened)).toBe(340);
        expect(() => keepStretch(w, ["a", "c"], { description: "x", projectID: null, billable: true, startedAt: iso(600), endedAt: iso(900) }, at(3000))).toThrow(/No captured time/);
        expect(() => keepStretch(w, ["a", "c"], { description: "x", projectID: null, billable: true, startedAt: iso(900), endedAt: iso(300) }, at(3000))).toThrow(/after the start/);
        expect(stretchSpan([{ startedAt: iso(0), endedAt: iso(600) }, { startedAt: iso(900), endedAt: iso(1500) }], at(1000), at(1200))).toEqual({ startedAt: iso(1000), endedAt: iso(1200) });
        deleteEntry(w, widened.id);
        // Dismissing a stretch dismisses every sitting; a stretch cannot be kept twice.
        dismissActivities(w, ["a", "c"]);
        expect(w.activities.map((a) => a.disposition)).toEqual(["dismissed", "pending", "dismissed"]); // b was deleted back to pending above
        expect(() => keepStretch(w, ["a", "c"], { description: "x", projectID: null, billable: true }, at(3000))).toThrow(WorkspaceError);
    });
});

describe("matters", () => {
    const doc = (name: string) => ({ name, path: null, excerpt: null });
    // Adam's Friday: Princess Pillow in Outlook, Word and Acrobat, bounced away from and back to.
    const friday = (): Workspace => {
        const w = emptyWorkspace();
        w.activities = [
            activity({ id: "o1", app: "Microsoft Outlook", document: doc("RE: Princess Pillow licence"), startedAt: iso(0), endedAt: iso(60) }),
            activity({ id: "w1", app: "Microsoft Word", document: doc("Princess Pillow licence v3.docx"), startedAt: iso(60), endedAt: iso(240) }),
            activity({ id: "x1", app: "Microsoft Excel", document: doc("Harbor rent roll.xlsx"), startedAt: iso(240), endedAt: iso(900) }),
            activity({ id: "o2", app: "Microsoft Outlook", document: doc("RE: Princess Pillow licence"), startedAt: iso(900), endedAt: iso(904) }),
            activity({ id: "p1", app: "Acrobat", title: "Pillow exhibit A.pdf", startedAt: iso(904), endedAt: iso(934) }),
            activity({ id: "f1", app: "Finder", title: null, startedAt: iso(934), endedAt: iso(940) }),
        ];
        return w;
    };

    it("asks only about finished, unreviewed, unnamed activity with something to read, and teaches with the person's names", () => {
        const w = friday();
        w.currentActivity = activity({ id: "now", document: doc("Live.docx") });
        w.activities.push(activity({ id: "k", disposition: "kept", document: doc("Kept.docx") }), activity({ id: "d", disposition: "dismissed", document: doc("Gone.docx") }));
        w.activities.push(activity({ id: "taught", disposition: "kept", document: doc("Harbor lease.docx"), matter: "Harbor Lease Renewal", matterBy: "person" }));
        const request = matterRequest(w)!;
        expect(request.ids).toEqual(["o1", "w1", "x1", "o2", "p1"]); // not the segment in progress, not reviewed, not Finder with nothing to read
        const body = request.body;
        expect(body.known_matters).toEqual(["Harbor Lease Renewal"]);
        expect(body.examples).toEqual([expect.objectContaining({ document: "Harbor lease.docx", matter: "Harbor Lease Renewal" })]);
        expect(JSON.stringify(body)).not.toContain("Live.docx");
        expect(matterRequest(w, 2)!.ids).toEqual(["o1", "w1"]);
        // On-screen text alone is something to read, and it is sent.
        w.activities.push(activity({ id: "t1", app: "Microsoft Teams", screenText: "Princess Pillow – licence call" }));
        expect(matterRequest(w)!.body.activities.find((a) => a.id === "t1")?.screen_text).toBe("Princess Pillow – licence call");
    });

    it("applies the answer only to what was asked and is still open, never over a person, and asks nothing twice", () => {
        const w = friday();
        w.projects.push({ id: "p", name: "Harbor Lease Renewal", client: "", color: "gold", hourlyRate: 0, archived: false });
        const ids = matterRequest(w)!.ids;
        setMatter(w, ["o2"], "Princess Pillow"); // the person answered while Kiwi was asking
        const named = applyMatters(w, ids, { assignments: [
            { activity_id: "o1", matter: " Princess   Pillow " },
            { activity_id: "w1", matter: "Princess Pillow" },
            { activity_id: "x1", matter: "harbor lease renewal" },
            { activity_id: "o2", matter: "Something else" },
            { activity_id: "f1", matter: "Not asked" },
            { activity_id: 7, matter: "junk" },
        ] });
        expect(named).toBe(3);
        const by = (id: string) => w.activities.find((a) => a.id === id)!;
        expect([by("o1").matter, by("w1").matter, by("x1").matter]).toEqual(["Princess Pillow", "Princess Pillow", "Harbor Lease Renewal"]);
        expect([by("o2").matter, by("o2").matterBy]).toEqual(["Princess Pillow", "person"]);
        expect([by("p1").matter, by("p1").matterBy]).toEqual([null, "ai"]); // skipped: answered as none, not asked again
        expect(by("f1").matter).toBeUndefined();
        expect(matterRequest(w)).toBeNull();
        // An answer that is not an answer changes nothing; those are asked again.
        const fresh = friday();
        expect(applyMatters(fresh, ["o1"], { nope: true })).toBe(0);
        expect(fresh.activities[0].matter).toBeUndefined();
        expect(knownMatters(w)).toEqual(["Harbor Lease Renewal", "Princess Pillow"]);
    });

    it("shows a matter's day as one row across apps, short hops included, and the rest as stretches", () => {
        const w = friday();
        applyMatters(w, matterRequest(w)!.ids, { assignments: ["o1", "w1", "o2", "p1"].map((id) => ({ activity_id: id, matter: "Princess Pillow" })).concat([{ activity_id: "x1", matter: null as unknown as string }]) });
        const inbox = inboxOf(w.activities);
        expect(inbox.groups).toHaveLength(1);
        const g = inbox.groups[0];
        expect([g.matter, g.seconds, g.sittings, g.apps]).toEqual(["Princess Pillow", 60 + 180 + 4 + 30, 4, ["Microsoft Outlook", "Microsoft Word", "Acrobat"]]);
        expect(g.documents.map((d) => [d.name, d.activityIDs.length])).toEqual([["Princess Pillow licence v3.docx", 1], ["RE: Princess Pillow licence", 2], ["Pillow exhibit A.pdf", 1]]);
        expect(inbox.stretches.map((st) => st.activityIDs)).toEqual([["x1"]]);
        expect(inbox.short.map((st) => st.activityIDs)).toEqual([["f1"]]);
        expect(toReview(w.activities)).toBe(2);
        // "Not this matter" sends a document back to review on its own.
        setMatter(w, ["p1"], null);
        expect(inboxOf(w.activities).groups[0].sittings).toBe(3);
        expect(inboxOf(w.activities).short.flatMap((st) => st.activityIDs)).toContain("p1");
    });

    it("puts a matter whose whole day is under a minute with the brief touches, not in its own row", () => {
        const w = friday();
        applyMatters(w, matterRequest(w)!.ids, { assignments: [{ activity_id: "o2", matter: "Brookman" }, { activity_id: "o1", matter: "Princess Pillow" }] });
        const inbox = inboxOf(w.activities);
        expect(inbox.groups.map((g) => g.matter)).toEqual(["Princess Pillow"]);
        expect(inbox.short.find((st) => st.name === "Brookman")?.activityIDs).toEqual(["o2"]);
    });

    it("keeps a matter's day as one entry on the project of that name, made once and reused in any case", () => {
        const w = friday();
        const first = keepStretch(w, ["o1", "w1", "o2", "p1"], { description: "Licence", projectID: null, matter: "Princess Pillow", billable: true }, at(2000));
        expect(seconds(first)).toBe(60 + 180 + 4 + 30);
        expect(w.projects.map((p) => p.name)).toEqual(["Princess Pillow"]);
        expect(first.projectID).toBe(w.projects[0].id);
        expect(w.activities.find((a) => a.id === "w1")).toMatchObject({ disposition: "kept", matter: "Princess Pillow", matterBy: "person" });
        const second = keepStretch(w, ["x1"], { description: "More", projectID: null, matter: "princess pillow", billable: true }, at(2000));
        expect(second.projectID).toBe(first.projectID);
        expect(w.projects).toHaveLength(1);
        expect(syncRequest(w, "test").entries[0].project_name).toBe("Princess Pillow");
        const none = keepStretch(w, ["f1"], { description: "Nothing", projectID: null, matter: "  ", billable: false }, at(2000));
        expect(none.projectID).toBeNull();
    });

    it("renames, re-rates, merges and archives a matter without touching kept times or the rates they were kept at", () => {
        const w = friday();
        applyMatters(w, matterRequest(w)!.ids, { assignments: [{ activity_id: "o2", matter: "Princess Pillow" }, { activity_id: "x1", matter: "Princess Pillow Licence" }] });
        const kept = keepStretch(w, ["o1", "w1"], { description: "Licence", projectID: null, matter: "Princess Pillow", billable: true }, at(2000));
        const pp = w.projects[0];
        updateProject(w, pp.id, { hourlyRate: 450, client: " Princess Pillow LLC " });
        expect([w.entries[0].hourlyRate, pp.client]).toEqual([0, "Princess Pillow LLC"]); // rates freeze at save
        expect(keepStretch(w, ["p1"], { description: "Exhibit", projectID: null, matter: "princess pillow", billable: true }, at(2000)).hourlyRate).toBe(450);
        updateProject(w, pp.id, { name: "Princess Pillow – Licensing" });
        expect(w.activities.find((a) => a.id === "o2")).toMatchObject({ matter: "Princess Pillow – Licensing", matterBy: "person" }); // pending follows the rename
        const dup = keepStretch(w, ["x1"], { description: "Dup", projectID: null, matter: "Princess Pillow Licence", billable: true }, at(2000));
        expect(() => updateProject(w, dup.projectID!, { name: "princess pillow – licensing" })).toThrow(/Merge them instead/);
        expect(() => updateProject(w, pp.id, { hourlyRate: -1 })).toThrow(WorkspaceError);
        mergeProjects(w, dup.projectID!, pp.id);
        expect(w.projects.map((p) => p.name)).toEqual(["Princess Pillow – Licensing"]);
        expect(w.entries.every((e) => e.projectID === pp.id)).toBe(true);
        expect(w.entries.find((e) => e.id === kept.id)).toMatchObject({ startedAt: kept.startedAt, endedAt: kept.endedAt, hourlyRate: 0 });
        expect(w.activities.find((a) => a.id === "x1")!.matter).toBe("Princess Pillow – Licensing");
        archiveProject(w, pp.id, true);
        expect(keepStretch(w, ["f1"], { description: "New", projectID: null, matter: "Princess Pillow – Licensing", billable: false }, at(2000)).projectID).not.toBe(pp.id); // an archived matter is not reused
        expect(() => archiveProject(w, pp.id, false)).toThrow(/Merge them instead/);
        expect(() => validate(w)).not.toThrow();
    });

    it("carries an AI draft to the row that shows it and marks an entry kept with the draft as written", () => {
        const w = friday();
        const draft = { text: "Revised trademark licence; correspondence re royalty schedule", source: "sample" as const };
        for (const a of w.activities) if (["o1", "w1"].includes(a.id)) { a.matter = "Princess Pillow"; a.draft = draft; }
        expect(inboxOf(w.activities).groups[0].draft).toEqual(draft);
        const kept = keepStretch(w, ["o1", "w1"], { description: draft.text, projectID: null, matter: "Princess Pillow", billable: true, drafted: "sample" }, at(2000));
        expect(kept.drafted).toBe("sample");
        expect(keepStretch(w, ["x1"], { description: "Typed by hand", projectID: null, billable: true }, at(2000)).drafted).toBeUndefined();
        w.activities[5].draft = { text: "", source: "sample" };
        expect(() => validate(w)).toThrow(WorkspaceError);
    });

    it("asks for a draft per row that lacks one, follows the person's wording, and applies answers to the row's open sittings only", () => {
        const w = friday();
        applyMatters(w, matterRequest(w)!.ids, { assignments: ["o1", "w1", "o2", "p1"].map((id) => ({ activity_id: id, matter: "Princess Pillow" })) });
        w.entries.push(entry({ source: "desktop", description: "Reviewed rent roll", endedAt: iso(-100), startedAt: iso(-200) }), entry({ source: "desktop", description: "AI wrote this", drafted: "kiwi", endedAt: iso(-100), startedAt: iso(-150) }));
        const req = draftRequest(w)!;
        expect(req.rows.map((r) => r.matter)).toEqual(["Princess Pillow", null]); // the matter row, and Excel's stretch (Finder is a short hop)
        expect(req.body.groups[0].activities.map((a) => a.document)).toEqual(["RE: Princess Pillow licence", "Princess Pillow licence v3.docx", "RE: Princess Pillow licence", null]);
        expect(req.body.examples).toEqual([{ matter: null, description: "Reviewed rent roll" }]); // only what a person wrote
        expect(applyDrafts(w, req.rows, { drafts: [{ id: req.rows[0].id, text: "  Revised trademark licence (v3)  " }, { id: "nope", text: "x" }] })).toBe(1);
        expect(inboxOf(w.activities).groups[0].draft).toEqual({ text: "Revised trademark licence (v3)", source: "kiwi" });
        // Drafted rows are not asked again; the one Kiwi skipped is, unless the session already tried it.
        expect(draftRequest(w)!.rows.map((r) => r.id)).toEqual(["x1"]);
        expect(draftRequest(w, new Set(["x1:1"]))).toBeNull();
        expect(applyDrafts(w, req.rows, "garbage")).toBe(0);
    });

    it("asks for a matter's insight when its time changed and the last one is over an hour old, never over a sample", () => {
        const w = friday();
        const kept = keepStretch(w, ["o1", "w1"], { description: "Licence", projectID: null, matter: "Princess Pillow", billable: true }, at(2000));
        const pp = w.projects[0];
        const now = at(3000);
        const req = insightRequest(w, now)!;
        expect(req.matters).toHaveLength(1);
        expect(req.matters[0]).toMatchObject({ id: pp.id, name: "Princess Pillow", entries: [{ description: "Licence", seconds: 240, billable: true }] });
        expect(applyInsights(w, { insights: [{ id: pp.id, summary: "Licensing work.", points: ["4m kept.", 7] }, { id: "nope", summary: "x" }] }, now)).toBe(1);
        expect(pp.insight).toMatchObject({ summary: "Licensing work.", points: ["4m kept."], source: "kiwi" });
        expect(insightRequest(w, now + 2 * 3_600_000)).toBeNull(); // nothing changed since
        w.entries.find((e) => e.id === kept.id)!.endedAt = new Date(now + 60_000).toISOString();
        expect(insightRequest(w, now + 30 * 60_000)).toBeNull(); // changed, but within the hour
        expect(insightRequest(w, now + 2 * 3_600_000)!.matters).toHaveLength(1);
        pp.insight = { summary: "s", points: [], generatedAt: iso(0), source: "sample" };
        expect(insightRequest(w, now + 2 * 3_600_000)).toBeNull();
        expect(applyInsights(w, { insights: [{ id: pp.id, summary: "over a sample" }] }, now)).toBe(0);
        expect(() => validate(w)).not.toThrow();
    });

    it("refuses a workspace with a malformed matter", () => {
        const w = friday();
        w.activities[0].matterBy = "robot" as never;
        expect(() => validate(w)).toThrow(WorkspaceError);
        const v = friday();
        v.projects.push({ id: "p", name: "Harbor", client: "", color: "gold", hourlyRate: 0, archived: false, insight: { summary: "s", points: ["a"], generatedAt: iso(0), source: "sample" } });
        expect(() => validate(v)).not.toThrow();
        v.projects[0].insight = { summary: "s", points: "a" as never, generatedAt: iso(0), source: "sample" };
        expect(() => validate(v)).toThrow(WorkspaceError);
    });
});

describe("Kiwi sync", () => {
    it("builds the wire request Kiwi's cleanSyncBody accepts, without the in-progress segment", () => {
        const w = emptyWorkspace();
        w.projects = [{ id: "p", name: "Whitfield v. Meridian", client: "Whitfield", color: "gold", hourlyRate: 350, archived: false }];
        const a = activity({ id: "a1", app: "Microsoft Word", title: "Motion.docx", endedAt: iso(1200), disposition: "kept" });
        w.activities = [a];
        w.currentActivity = activity({ app: "Preview" });
        w.entries = [entry({ id: "4fd1c8a2-3b7e-4c1d-9a2f-1b3c4d5e6f70", description: "Prepare motion", projectID: "p", endedAt: iso(1200), billable: true, hourlyRate: 350, source: "desktop", activityID: "a1" })];
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://lawdie.co/kiwi-api", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["gone"] }], autoSync: true };
        const req = syncRequest(w, "0.3.0", "America/New_York");
        expect(Object.keys(req).sort()).toEqual(["activities", "app_version", "deleted_entry_ids", "entries", "time_zone"]);
        expect(req.time_zone).toBe("America/New_York");
        expect(req.activities).toEqual([{ id: "a1", app: "Microsoft Word", bundle_id: "com.microsoft.Word", title: "Motion.docx", document_name: null, document_path: null, excerpt: null, started_at: iso(0), ended_at: iso(1200), seconds: 1200, ended_by: "switched", disposition: "kept" }]);
        expect(req.entries[0]).toEqual({ id: "4fd1c8a2-3b7e-4c1d-9a2f-1b3c4d5e6f70", description: "Prepare motion", project_name: "Whitfield v. Meridian", client_name: "Whitfield", started_at: iso(0), ended_at: iso(1200), seconds: 1200, billable: true, hourly_rate: 350, source: "desktop", activity_id: "a1" });
        expect(req.deleted_entry_ids).toEqual(["gone"]);
        expect(JSON.stringify(req)).not.toContain("ldt_");
    });

    it("deleting an entry reopens its activity and records a tombstone only when connected", () => {
        const w = emptyWorkspace();
        const a = activity(); w.activities = [a];
        const kept = keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700));
        deleteEntry(w, kept.id);
        expect(w.entries).toEqual([]);
        expect(w.activities[0].disposition).toBe("pending");
        expect(w.sync).toBeNull();
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }, { product: "crm", serverURL: "https://crm.test/api", deviceID: "e", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }], autoSync: true };
        saveEntry(w, entry({ id: kept.id, description: "Again" }), at(700));
        deleteEntry(w, kept.id); deleteEntry(w, kept.id); deleteEntry(w, "nothing");
        expect(w.sync.targets.map((t) => t.deletedEntryIDs)).toEqual([[kept.id], [kept.id]]);
    });

    it("clears only the deletions Kiwi acknowledged", () => {
        const w = emptyWorkspace();
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: "boom", deletedEntryIDs: ["seen", "later"] }, { product: "crm", serverURL: "https://crm.test/api", deviceID: "e", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["seen", "later"] }], autoSync: true };
        markSynced(w, at(10), ["seen"], "kiwi");
        expect(w.sync.targets[0]).toMatchObject({ deletedEntryIDs: ["later"], lastSyncedAt: iso(10), lastError: null });
        expect(w.sync.targets[1]).toMatchObject({ deletedEntryIDs: ["seen", "later"], lastSyncedAt: null });
        expect(syncRequest(w, "t", null, w.sync.targets[1]).deleted_entry_ids).toEqual(["seen", "later"]);
        markSynced(w, at(11), ["seen", "later"]);
        expect(w.sync.targets.map((t) => t.deletedEntryIDs)).toEqual([[], []]);
    });

    it("batches under Kiwi's limit with deletions first", () => {
        const w = emptyWorkspace();
        w.activities = Array.from({ length: 1201 }, (_, i) => activity({ id: `a${i}` }));
        w.entries = Array.from({ length: 7 }, (_, i) => entry({ id: `e${i}`, startedAt: iso(i * 1000), endedAt: iso(i * 1000 + 600) }));
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["x", "y"] }], autoSync: true };
        const batches = syncBatches(syncRequest(w, "t"));
        expect(batches.map((b) => b.activities.length)).toEqual([500, 500, 201]);
        expect(batches.map((b) => b.entries.length)).toEqual([7, 0, 0]);
        expect(batches.map((b) => b.deleted_entry_ids.length)).toEqual([2, 0, 0]);
    });

    it("normalises the server URL and refuses junk", () => {
        expect(normalizeServerURL(" https://lawdie.co/kiwi-api/ ")).toBe("https://lawdie.co/kiwi-api");
        expect(normalizeServerURL("http://localhost:4100")).toBe("http://localhost:4100");
        for (const junk of ["", "lawdie.co", "ftp://x", "file:///tmp", "https://"]) expect(normalizeServerURL(junk)).toBeNull();
        expect(() => new KiwiClient("nope", "ldt_x")).toThrow(KiwiFailure);
    });

    it("reads Kiwi's refusals as what they are", async () => {
        const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
        await expect(new KiwiClient("https://k.test", "t", respond(401, { code: "device_revoked" })).hello()).rejects.toMatchObject({ code: "device_revoked" });
        await expect(new KiwiClient("https://k.test", "t", respond(401, { code: "invalid_device_token" })).hello()).rejects.toMatchObject({ code: "invalid_token" });
        await expect(new KiwiClient("https://k.test", "t", respond(503, {})).hello()).rejects.toMatchObject({ code: "migration_pending" });
        await expect(new KiwiClient("https://k.test", "t", respond(413, {})).hello()).rejects.toMatchObject({ code: "too_large" });
        const ok = await new KiwiClient("https://k.test", "t", respond(200, { ok: true, device: { id: "d", name: "Mac" }, user: { email: "a@b" } })).hello();
        expect(ok.device.name).toBe("Mac");
    });

    it("names the destination in what it says, so a CRM user is never told about Kiwi", async () => {
        const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
        const crm = new KiwiClient(PRODUCTS.crm.defaultServerURL, "t", respond(401, { code: "device_revoked" }), 30_000, PRODUCTS.crm.label);
        expect(crm.baseURL).toBe("https://crm-api.lawdie.co/api");
        await expect(crm.hello()).rejects.toThrow(/disconnected in Lawdie CRM/);
        await expect(new KiwiClient("https://k.test", "t", respond(503, {})).hello()).rejects.toThrow(/^Kiwi is not ready/);
        expect(() => new KiwiClient("nope", "t", fetch, 30_000, "Lawdie CRM")).toThrow(/Lawdie CRM server address, such as https:\/\/crm-api\.lawdie\.co\/api/);
        expect(isDestination("crm") && isDestination("kiwi") && !isDestination("other")).toBe(true);
        expect(destinationLabel([])).toBe("Kiwi");
    });

    it("reads a 0.4.x workspace (one product, flat) as one target, and refuses an unknown product", () => {
        const w = emptyWorkspace();
        const flat = { destination: "crm", serverURL: "https://crm-api.lawdie.co/api", deviceID: "d", deviceName: "PC", accountEmail: "a@b", autoSync: false, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["z"] };
        const back = parseWorkspace(JSON.stringify({ ...w, sync: flat }));
        expect(back.sync).toEqual({ targets: [{ product: "crm", serverURL: flat.serverURL, deviceID: "d", deviceName: "PC", accountEmail: "a@b", lastSyncedAt: null, lastError: null, deletedEntryIDs: ["z"] }], autoSync: false });
        const { destination: _d, ...older } = flat;
        expect(parseWorkspace(JSON.stringify({ ...w, sync: older })).sync?.targets[0].product).toBe("kiwi");
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://k", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }, { product: "crm", serverURL: "https://c/api", deviceID: "e", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }], autoSync: true };
        expect(parseWorkspace(JSON.stringify(w)).sync).toEqual(w.sync);
        expect(() => validate({ ...w, sync: { ...w.sync!, targets: [{ ...w.sync!.targets[0], product: "elsewhere" as Product }] } })).toThrow(WorkspaceError);
        expect(() => validate({ ...w, sync: { ...w.sync!, targets: [w.sync!.targets[0], w.sync!.targets[0]] } })).toThrow(WorkspaceError);
        expect(productsFor("both")).toEqual(["kiwi", "crm"]);
        expect(destinationLabel(["kiwi", "crm"])).toBe("Kiwi and Lawdie CRM");
        expect(isDestination("both") && !isDestination("elsewhere")).toBe(true);
    });
});

describe("files", () => {
    it("reads a workspace the Swift app wrote (reference-date seconds, bundleID) and keeps everything", () => {
        const swift = {
            schemaVersion: 1,
            projects: [{ id: "P1", name: "Matter", client: "Client", color: "gold", hourlyRate: 350, archived: false }],
            entries: [{ id: "E1", description: "Draft", projectID: "P1", startedAt: 812492800, endedAt: 812496400, billable: true, hourlyRate: 350, source: "desktop", activityID: "A1" }],
            activities: [{ id: "A1", app: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92", startedAt: 812492800, endedAt: 812496400, endedBy: "paused", disposition: "kept" }],
            preferences: { captureEnabled: true, captureTitles: false, idleMinutes: 3, retentionDays: 14, excludedBundleIDs: ["com.apple.Passwords"] },
        };
        const w = parseWorkspace(JSON.stringify(swift));
        expect(w.schemaVersion).toBe(2);
        expect(w.activities[0]).toMatchObject({ ownerID: "com.todesktop.230313mzl4w4u92", startedAt: "2026-09-30T20:26:40.000Z", endedAt: "2026-09-30T21:26:40.000Z", disposition: "kept" });
        expect(w.entries[0]).toMatchObject({ projectID: "P1", startedAt: "2026-09-30T20:26:40.000Z", billable: true });
        expect(w.preferences).toMatchObject({ captureEnabled: true, excludedOwnerIDs: ["com.apple.Passwords"] });
        expect(w.sync).toBeNull();
    });

    it("refuses a newer schema and invalid data, and fills in what an older v2 file lacks", () => {
        expect(() => parseWorkspace(JSON.stringify({ schemaVersion: 99 }))).toThrow(/newer/);
        expect(() => parseWorkspace(JSON.stringify({ ...emptyWorkspace(), preferences: { ...emptyWorkspace().preferences, idleMinutes: 0 } }))).toThrow(/invalid/);
        const { sync: _s, timer: _t, currentActivity: _c, ...older } = emptyWorkspace();
        expect(parseWorkspace(JSON.stringify(older))).toEqual(emptyWorkspace());
        expect(migrateV1({}).preferences.excludedOwnerIDs.length).toBeGreaterThan(0);
    });
});

describe("screenRecordingAttempt", () => {
    it("asks macOS once a run when not granted, so the prompt is raised once and never again", () => {
        expect(screenRecordingAttempt("denied", false)).toBe(true);
        expect(screenRecordingAttempt("denied", true)).toBe(false);
        expect(screenRecordingAttempt("not-determined", true)).toBe(false);
    });
    it("always looks titles up once granted", () => {
        expect(screenRecordingAttempt("granted", true)).toBe(true);
    });
});

describe("calls", () => {
    it("knows call apps by bundle prefix (helpers included) and by executable", () => {
        expect(callApp("com.microsoft.teams2")?.key).toBe("teams");
        expect(callApp("com.microsoft.teams2.helper.renderer")?.key).toBe("teams");
        expect(callApp("us.zoom.xos")?.key).toBe("zoom");
        expect(callApp("C:\\Users\\adam\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe")?.key).toBe("zoom");
        expect(callApp("ms-teams.exe")?.key).toBe("teams");
        expect(callApp("com.microsoft.Word")).toBeNull();
        expect(callApp("com.apple.VoiceMemos")).toBeNull(); // recording is not a call
    });
    it("a call is a call app recording; anything else recording is not", () => {
        expect(activeCall(["com.apple.VoiceMemos"])).toBeNull();
        expect(activeCall(["com.apple.VoiceMemos", "com.microsoft.teams2"])).toEqual({ app: { key: "teams", name: "Microsoft Teams" }, ownerID: "com.microsoft.teams2" });
        expect(activeCall([])).toBeNull();
    });
    it("reads the macOS helper", () => {
        expect(parseMacRecording("com.microsoft.teams2\nus.zoom.xos\n")).toEqual(["com.microsoft.teams2", "us.zoom.xos"]);
        expect(parseMacRecording("UNSUPPORTED\n")).toEqual([]);
    });
    it("reads the Windows registry: started and not stopped is now", () => {
        const base = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
        const out = [
            "", base, "    Value    REG_SZ    Allow", "",
            `${base}\\MSTeams_8wekyb3d8bbwe`, "    Value    REG_SZ    Allow", "    LastUsedTimeStart    REG_QWORD    0x1db2a4c5e6f7a8b", "    LastUsedTimeStop    REG_QWORD    0x0", "",
            `${base}\\NonPackaged`, "    Value    REG_SZ    Allow", "",
            `${base}\\NonPackaged\\C:#Users#adam#AppData#Roaming#Zoom#bin#Zoom.exe`, "    LastUsedTimeStart    REG_QWORD    0x1db2a4c5e6f7a8b", "    LastUsedTimeStop    REG_QWORD    0x1db2a4c5e6f7a9c", "",
            `${base}\\NonPackaged\\C:#Program Files#Slack#slack.exe`, "    LastUsedTimeStart    REG_QWORD    0x1db2a4c5e6f7a8b", "    LastUsedTimeStop    REG_QWORD    0x0", "",
            `${base}\\NonPackaged\\C:#Tools#never.exe`, "    LastUsedTimeStart    REG_QWORD    0x0", "    LastUsedTimeStop    REG_QWORD    0x0", "",
        ].join("\r\n");
        expect(parseWindowsRecording(out)).toEqual(["ms-teams.exe", "C:\\Program Files\\Slack\\slack.exe"]);
    });
    it("a call in the background is observed as the call: one segment while the focus moves", () => {
        const w = capturing();
        const TEAMS = { app: "Microsoft Teams", ownerID: "com.microsoft.teams2", title: "Latitude weekly | Microsoft Teams" };
        for (let s = 0; s <= 600; s += 5) observe(w, TEAMS, at(s), s); // capture.ts sends the call, whatever is in front
        expect(w.currentActivity!.ownerID).toBe("com.microsoft.teams2");
        expect(w.currentActivity!.endedAt).toBe(iso(600));
        expect(w.activities).toHaveLength(0);
    });
});
