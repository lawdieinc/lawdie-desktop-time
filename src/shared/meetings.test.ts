import { describe, expect, it } from "vitest";
import { applyMeetings, applyTranscript, ensureMeetings, parseMeetings, transcriptsDue, type Meeting } from "./meetings";
import { describeItem, inboxOf, matterRequest } from "./matters";
import { deleteEntry, emptyWorkspace, keepStretch, syncRequest, validate, type Activity, type Workspace } from "./model";

// Calendar meetings and Teams transcripts, through Kiwi (src/shared/meetings.ts).

const EPOCH = 1_780_000_000_000;
const at = (s: number) => EPOCH + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
const M = 60;
const SELF = "me@firm.com";
const calendars = [{ provider: "microsoft" as const, status: "ok" as const, email: SELF }];
const TEAMS = "https://teams.microsoft.com/l/meetup-join/abc";

const meeting = (over: Partial<Meeting> = {}): Meeting => ({ id: "microsoft:m1", provider: "microsoft", subject: "Acme lease call", start: iso(60 * M), end: iso(90 * M), organizer: SELF, attendees: ["jane@acme.com", SELF], online: "teams", join_url: TEAMS, location: null, notes: "Redlines", ...over });
const activity = (over: Partial<Activity> = {}): Activity => ({ id: "a-" + Math.random(), app: "Word", ownerID: "com.microsoft.Word", title: "Lease.docx", startedAt: iso(0), endedAt: iso(10 * M), endedBy: "switched", disposition: "pending", ...over });
const teamsCall = (over: Partial<Activity> = {}): Activity => activity({ id: "call", app: "Microsoft Teams", ownerID: "com.microsoft.teams2", title: "Meeting | Microsoft Teams", startedAt: iso(61 * M), endedAt: iso(89 * M), ...over });

/** A workspace with the switch on since the start of the test day. */
function on(): Workspace {
    const w = emptyWorkspace();
    w.preferences.importMeetings = true;
    ensureMeetings(w, at(0));
    return w;
}
const window = { from: iso(0), to: iso(200 * M) };
const fetched = (w: Workspace, list: Meeting[], now = at(100 * M)) => applyMeetings(w, { meetings: list, calendars }, window, now);

describe("calendar meetings", () => {
    it("names the call capture counted, and asks the matter with the subject and who was invited", () => {
        const w = on();
        w.activities.push(teamsCall());
        expect(fetched(w, [meeting()])).toBe(0);
        const call = w.activities.find((a) => a.id === "call")!;
        expect(call.meeting).toEqual({ id: "microsoft:m1", subject: "Acme lease call", with: ["jane@acme.com"], provider: "microsoft", online: "teams" });
        expect(w.activities).toHaveLength(1);
        expect(inboxOf(w.activities).stretches.map((s) => s.name)).toEqual(["Acme lease call"]);
        expect(describeItem([call]).facts).toMatch(/^a call with jane@acme.com · /);
        const ask = matterRequest(w)!.body.activities[0];
        expect([ask.title, ask.meeting_with]).toEqual(["Acme lease call", ["jane@acme.com"]]);
        expect(() => validate(w)).not.toThrow();
    });

    it("offers a meeting this computer missed as a row, less the time this computer counted", () => {
        const w = on();
        w.activities.push(activity({ id: "word", startedAt: iso(60 * M), endedAt: iso(70 * M) }));
        expect(fetched(w, [meeting({ online: null, join_url: null, location: "Room 4" })])).toBe(1);
        const row = w.activities.find((a) => a.ownerID === "calendar:microsoft")!;
        expect([row.app, row.title, row.startedAt, row.endedAt, row.disposition]).toEqual(["Outlook calendar", "Acme lease call", iso(70 * M), iso(90 * M), "pending"]);
        expect(describeItem([row]).facts).toMatch(/^a meeting with jane@acme.com · .* · on your calendar, not on this computer$/);
        // Decided once: a second pass makes nothing more.
        expect(fetched(w, [meeting({ online: null, join_url: null })])).toBe(0);
        expect(w.activities.filter((a) => a.ownerID.startsWith("calendar:"))).toHaveLength(1);
        expect(() => validate(w)).not.toThrow();
    });

    it("leaves alone a block on one's own calendar, a meeting before the switch, one not over, and one this computer covered", () => {
        const w = on();
        w.meetings!.since = iso(30 * M);
        w.activities.push(activity({ startedAt: iso(70 * M), endedAt: iso(80 * M) }));
        fetched(w, [
            meeting({ id: "microsoft:solo", attendees: [SELF] }),
            meeting({ id: "microsoft:old", start: iso(0), end: iso(20 * M) }),
            meeting({ id: "microsoft:later", start: iso(95 * M), end: iso(110 * M) }),
            meeting({ id: "microsoft:covered", start: iso(70 * M), end: iso(80 * M) }),
        ], at(111 * M));
        expect(w.activities.filter((a) => a.ownerID.startsWith("calendar:"))).toHaveLength(0);
        expect(w.meetings!.list.find((m) => m.id === "microsoft:later")!.placed).toBeUndefined();
        expect(w.meetings!.list.some((m) => m.id === "microsoft:old")).toBe(false);
    });

    it("waits while the call is still going, and drops a meeting cancelled before it was decided", () => {
        const w = on();
        w.currentActivity = teamsCall({ endedAt: iso(95 * M) });
        fetched(w, [meeting()]);
        expect(w.meetings!.list[0].placed).toBeUndefined();
        fetched(w, []);
        expect(w.meetings!.list).toHaveLength(0);
    });

    it("keeps a meeting as evidence, and its Teams transcript joins the entry when it arrives", () => {
        const w = on();
        w.activities.push(teamsCall());
        fetched(w, [meeting()]);
        const entry = keepStretch(w, ["call"], { description: "Call with client re lease", projectID: null, billable: true }, at(100 * M));
        expect(entry.sources).toEqual([{ id: "call", kind: "meeting", label: "Acme lease call" }]);
        expect(w.evidence!.call).toMatchObject({ kind: "meeting", subject: "Acme lease call", attendees: ["jane@acme.com"], teams: true, body: "Redlines", meeting_id: "microsoft:m1" });
        expect(transcriptsDue(w, at(92 * M))).toHaveLength(0); // too soon after it ended
        expect(transcriptsDue(w, at(100 * M)).map((m) => m.id)).toEqual(["microsoft:m1"]);
        applyTranscript(w, "microsoft:m1", { status: "none" }, at(100 * M));
        expect(w.meetings!.list[0].transcriptState).toBe("waiting");
        expect(transcriptsDue(w, at(110 * M))).toHaveLength(0); // asked ten minutes ago
        applyTranscript(w, "microsoft:m1", { status: "ready", lines: [{ who: "Jane", text: "Push the closing to Friday." }] }, at(125 * M));
        expect(w.evidence!.call.transcript).toBe("call:transcript");
        expect(w.entries[0].sources).toEqual([{ id: "call", kind: "meeting", label: "Acme lease call" }, { id: "call:transcript", kind: "transcript", label: "Transcript of Acme lease call" }]);
        expect(w.evidence!["call:transcript"]).toEqual({ id: "call:transcript", kind: "transcript", meeting: "call", lines: [{ t: "", who: "Jane", text: "Push the closing to Friday." }] });
        expect(transcriptsDue(w, at(150 * M))).toHaveLength(0);
        expect(() => validate(w)).not.toThrow();
        deleteEntry(w, entry.id);
        expect(w.evidence!["call:transcript"]).toBeUndefined();
    });

    it("puts a transcript that arrived first on the entry when the time is kept", () => {
        const w = on();
        w.activities.push(teamsCall());
        fetched(w, [meeting()]);
        applyTranscript(w, "microsoft:m1", { status: "ready", lines: [{ who: "Jane", text: "Agreed." }] }, at(100 * M));
        const entry = keepStretch(w, ["call"], { description: "Call", projectID: null, billable: true }, at(101 * M));
        expect(entry.sources!.map((s) => s.id)).toEqual(["call", "call:transcript"]);
        expect(w.evidence!["call:transcript"].lines).toEqual([{ t: "", who: "Jane", text: "Agreed." }]);
    });

    it("stops asking when Teams refuses or the wait is over, and never syncs a meeting or transcript", () => {
        const w = on();
        w.activities.push(teamsCall());
        fetched(w, [meeting(), meeting({ id: "microsoft:m2", start: iso(91 * M), end: iso(99 * M) })]);
        w.activities.push(teamsCall({ id: "call2", startedAt: iso(91 * M), endedAt: iso(99 * M) }));
        applyTranscript(w, "microsoft:m1", { status: "not_allowed" }, at(100 * M));
        expect(w.meetings!.list[0].transcriptState).toBe("not_allowed");
        applyTranscript(w, "microsoft:m1", { status: "none" }, at(90 * M + 6 * 3600_000));
        expect(w.meetings!.list[0].transcriptState).toBe("none");
        const body = JSON.stringify(syncRequest(w, "0.16.0"));
        expect(body).not.toContain("jane@acme.com");
        expect(body).not.toContain("Redlines");
    });

    it("reads Kiwi's answer, dropping what does not parse", () => {
        const page = parseMeetings({ meetings: [meeting(), { id: "bad", provider: "google", start: "x", end: "y" }, { ...meeting({ id: "google:2", provider: "google" }), attendees: ["Bob@X.com", "nope", 3] }], calendars: [{ provider: "google", status: "reconnect", email: null }, { provider: "zoom", status: "ok" }] });
        expect(page.meetings.map((m) => m.id)).toEqual(["microsoft:m1", "google:2"]);
        expect(page.meetings[1].attendees).toEqual(["bob@x.com"]);
        expect(page.calendars).toEqual([{ provider: "google", status: "reconnect", email: null }]);
        expect(() => parseMeetings({ meetings: "no" })).toThrow();
    });
});
