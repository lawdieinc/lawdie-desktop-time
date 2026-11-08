/* Calendar meetings and Teams transcripts (2026-11-08). Kiwi reads the person's Google and
   Outlook calendars with the grants it already holds (GET /desktop-time/meetings,
   kiwi/backend/src/lib/desktopMeetings.ts) and a Teams meeting's transcript
   (GET /desktop-time/meetings/transcript); src/main/meetings.ts asks, this file decides
   what a meeting does to the inbox. Pure and tested (meetings.test.ts).

   A meeting that ended:
   - names the call capture already counted (a Teams or Zoom call at the same time): the
     call keeps its time and gains the meeting (`Activity.meeting`), so its row reads
     "Acme lease call" and the matter request sees who was invited;
   - else, when anyone else was invited, becomes a review row of its own ("Outlook
     calendar"), for the part of it this computer did not count: this computer's time wins
     an overlap, as with browser time, so nothing is counted twice;
   - else (a block on one's own calendar) does nothing.
   Only meetings that end after the switch went on count (`MeetingsState.since`), so turning
   it on does not flood the inbox with last week. A transcript is kept on the meeting and
   becomes evidence on the entry its time was kept as, now or when it arrives. Everything
   here is local: meetings and transcripts are never synced, and only the subject and the
   other invitees go to Kiwi's matter model. */

import { callApp } from "./calls";
import { subtractIntervals, uuid, WorkspaceError, type Activity, type Evidence, type Interval, type Workspace } from "./model";

export type MeetingProvider = "google" | "microsoft";
export type OnlineKind = "teams" | "zoom" | "meet";
export type TranscriptLine = { who: string; text: string };
export type TranscriptState = "waiting" | "ready" | "none" | "not_allowed";
export type Meeting = {
    id: string;
    provider: MeetingProvider;
    subject: string;
    start: string;
    end: string;
    organizer: string | null;
    attendees: string[];
    online: OnlineKind | null;
    join_url: string | null;
    location: string | null;
    notes: string | null;
    /** Decided: it named a call, became a row, or was nobody else's meeting. Never decided twice. */
    placed?: boolean;
    transcript?: TranscriptLine[] | null;
    transcriptState?: TranscriptState;
    transcriptCheckedAt?: string;
};
export type CalendarState = { provider: MeetingProvider; status: "ok" | "not_connected" | "reconnect" | "no_calendar" | "error"; email: string | null };
export type MeetingsState = { since: string; list: Meeting[]; calendars: CalendarState[]; lastFetchedAt: string | null };
/** What an activity carries of its meeting: enough to name the row and ask the matter. */
export type MeetingRef = { id: string; subject: string; with: string[]; provider: MeetingProvider; online: OnlineKind | null };

/** How far back each pass asks. */
export const MEETINGS_LOOKBACK_MS = 2 * 86_400_000;
/** A meeting is decided this long after it ends, so the call it was has closed. */
export const PLACE_AFTER_MS = 2 * 60_000;
/** A call names a meeting when they share this much time, or half the call. */
const CALL_OVERLAP_MS = 5 * 60_000;
/** A calendar row shorter than this, once this computer's time is taken out, is not offered. */
export const CALENDAR_ROW_MIN_MS = 60_000;
/** Teams makes a transcript some minutes after the meeting; asked for until this long after it ends. */
export const TRANSCRIPT_WAIT_MS = 6 * 3_600_000;
export const TRANSCRIPT_EVERY_MS = 20 * 60_000;
const TRANSCRIPT_FIRST_MS = 5 * 60_000;
/** Characters of a transcript kept on this computer. */
export const TRANSCRIPT_STORE_MAX = 20_000;
/** Invitees kept on an activity. */
const WITH_MAX = 10;

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
const PROVIDERS = new Set<unknown>(["google", "microsoft"]);
const ONLINE = new Set<unknown>([null, "teams", "zoom", "meet"]);
const STATUSES = new Set<unknown>(["ok", "not_connected", "reconnect", "no_calendar", "error"]);
const STATES = new Set<unknown>(["waiting", "ready", "none", "not_allowed"]);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export const isCalendarRow = (a: Pick<Activity, "ownerID">): boolean => a.ownerID.startsWith("calendar:");
export const calendarApp = (p: MeetingProvider): string => (p === "google" ? "Google Calendar" : "Outlook calendar");

/** Kiwi's answer, checked: bad meetings are dropped, a bad shape throws. */
export function parseMeetings(raw: unknown): { meetings: Meeting[]; calendars: CalendarState[] } {
    const r = raw as { meetings?: unknown; calendars?: unknown };
    if (!r || !Array.isArray(r.meetings) || !Array.isArray(r.calendars) || r.meetings.length > 1000) throw new WorkspaceError("Kiwi sent an invalid list of meetings.");
    const meetings: Meeting[] = [];
    for (const m of r.meetings as Record<string, unknown>[]) {
        const id = str(m?.id, 400), subject = str(m?.subject, 300) ?? "(No title)";
        const start = typeof m?.start === "string" ? ms(m.start) : NaN, end = typeof m?.end === "string" ? ms(m.end) : NaN;
        if (!id || !PROVIDERS.has(m.provider) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86_400_000 || !ONLINE.has(m.online ?? null)) continue;
        const emails = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => str(x, 320)?.toLowerCase()).filter((x): x is string => !!x && x.includes("@"));
        meetings.push({ id, provider: m.provider as MeetingProvider, subject, start: iso(start), end: iso(end), organizer: emails([m.organizer])[0] ?? null, attendees: [...new Set(emails(m.attendees))].slice(0, 50), online: (m.online ?? null) as OnlineKind | null, join_url: str(m.join_url, 2000), location: str(m.location, 200), notes: str(m.notes, 300) });
    }
    const calendars = (r.calendars as Record<string, unknown>[]).filter((c) => c && PROVIDERS.has(c.provider) && STATUSES.has(c.status)).map((c) => ({ provider: c.provider as MeetingProvider, status: c.status as CalendarState["status"], email: str(c.email, 320)?.toLowerCase() ?? null }));
    return { meetings, calendars };
}

/** The meetings state, made when the switch first fetches: only meetings ending after now count. */
export function ensureMeetings(w: Workspace, now: number): MeetingsState {
    return w.meetings ??= { since: iso(now), list: [], calendars: [], lastFetchedAt: null };
}

/** The window to ask Kiwi for: back to the switch or two days, whichever is later, up to now. */
export function meetingsWindow(w: Workspace, now: number): { from: string; to: string } {
    const since = w.meetings ? ms(w.meetings.since) : now;
    return { from: iso(Math.max(since, now - MEETINGS_LOOKBACK_MS) - 3_600_000), to: iso(now) };
}

/** Everyone on the invite but this person (the connected calendars' addresses). */
export function othersOn(m: Pick<Meeting, "organizer" | "attendees">, self: readonly string[]): string[] {
    const mine = new Set(self.map((s) => s.toLowerCase()));
    return [...new Set([m.organizer, ...m.attendees].filter((x): x is string => !!x && !mine.has(x)))];
}

const refOf = (m: Meeting, self: readonly string[]): MeetingRef => ({ id: m.id, subject: m.subject, with: othersOn(m, self).slice(0, WITH_MAX), provider: m.provider, online: m.online });
const overlapMs = (a: Interval[], start: number, end: number): number => a.reduce((n, i) => n + Math.max(0, Math.min(ms(i.endedAt), end) - Math.max(ms(i.startedAt), start)), 0);
const intervalsOf = (a: Activity): Interval[] => (a.sittings?.length ? a.sittings : [a]);

/** Kiwi's answer into the workspace: new meetings added, known ones updated (what was decided stays), then each ended one decided. */
export function applyMeetings(w: Workspace, answer: { meetings: Meeting[]; calendars: CalendarState[] }, window: { from: string; to: string }, now: number): number {
    const s = ensureMeetings(w, now);
    s.calendars = answer.calendars;
    s.lastFetchedAt = iso(now);
    const incoming = new Map(answer.meetings.filter((m) => ms(m.end) > ms(s.since)).map((m) => [m.id, m]));
    // A meeting not yet decided that is gone from its calendar (cancelled, declined) goes; a decided one stays for its evidence.
    const from = ms(window.from), to = ms(window.to);
    s.list = s.list.filter((m) => m.placed || incoming.has(m.id) || ms(m.start) < from || ms(m.start) > to);
    for (const m of incoming.values()) {
        const known = s.list.find((x) => x.id === m.id);
        if (known) { if (!known.placed) Object.assign(known, m); }
        else s.list.push(m);
    }
    const cutoff = now - w.preferences.retentionDays * 86_400_000;
    s.list = s.list.filter((m) => ms(m.end) >= cutoff);
    return placeMeetings(w, now);
}

/** Decide each meeting that ended: name the call it was, or offer what this computer missed. Returns the rows made. */
export function placeMeetings(w: Workspace, now: number): number {
    const s = w.meetings;
    if (!s) return 0;
    const self = s.calendars.map((c) => c.email).filter((x): x is string => !!x);
    const computer = w.activities.filter((a) => !a.origin && !isCalendarRow(a));
    let made = 0;
    for (const m of [...s.list].sort((a, b) => ms(a.start) - ms(b.start))) {
        const start = ms(m.start), end = ms(m.end);
        if (m.placed || end > now - PLACE_AFTER_MS || end <= ms(s.since)) continue;
        // A call still going on through the meeting decides it when it closes.
        const cur = w.currentActivity;
        if (cur && callApp(cur.ownerID) && ms(cur.startedAt) < end && ms(cur.endedAt) > start) continue;
        const calls = computer.filter((a) => callApp(a.ownerID) && (() => { const o = overlapMs(intervalsOf(a), start, end); return o >= CALL_OVERLAP_MS || (o > 0 && o >= (ms(a.endedAt) - ms(a.startedAt)) / 2); })());
        if (calls.length) {
            for (const a of calls) if (a.disposition === "pending" && !a.meeting) a.meeting = refOf(m, self);
            m.placed = true;
            continue;
        }
        m.placed = true;
        if (!othersOn(m, self).length) continue;
        const occupied = [...computer.flatMap(intervalsOf), ...w.entries.flatMap((e) => (e.sittings?.length ? e.sittings : [e])), ...w.activities.filter((a) => a.origin && a.disposition === "kept").flatMap(intervalsOf)];
        const left = subtractIntervals([{ startedAt: m.start, endedAt: m.end }], occupied).filter((i) => ms(i.endedAt) - ms(i.startedAt) >= 1000);
        if (left.reduce((n, i) => n + ms(i.endedAt) - ms(i.startedAt), 0) < CALENDAR_ROW_MIN_MS) continue;
        w.activities.push({
            id: uuid(), app: calendarApp(m.provider), ownerID: `calendar:${m.provider}`, title: m.subject,
            startedAt: left[0].startedAt, endedAt: left[left.length - 1].endedAt, ...(left.length > 1 ? { sittings: left } : {}),
            endedBy: "calendar", disposition: "pending", meeting: refOf(m, self),
        });
        made++;
    }
    return made;
}

/** Teams meetings whose transcript is worth asking for now: ended a few minutes ago, someone's time is on them, not settled. */
export function transcriptsDue(w: Workspace, now: number): Meeting[] {
    const s = w.meetings;
    if (!s) return [];
    const used = new Set(w.activities.map((a) => a.meeting?.id).filter(Boolean));
    return s.list.filter((m) => m.provider === "microsoft" && m.online === "teams" && m.join_url && used.has(m.id)
        && (m.transcriptState == null || m.transcriptState === "waiting")
        && ms(m.end) <= now - TRANSCRIPT_FIRST_MS && ms(m.end) >= now - TRANSCRIPT_WAIT_MS
        && (!m.transcriptCheckedAt || now - ms(m.transcriptCheckedAt) >= TRANSCRIPT_EVERY_MS));
}

/** Kiwi's transcript answer for one meeting. A transcript is kept and put on any entry already kept from the meeting's time. */
export function applyTranscript(w: Workspace, meetingID: string, raw: unknown, now: number): boolean {
    const m = w.meetings?.list.find((x) => x.id === meetingID);
    if (!m) return false;
    const r = raw as { status?: unknown; lines?: unknown };
    m.transcriptCheckedAt = iso(now);
    if (r?.status === "ready" && Array.isArray(r.lines)) {
        const lines: TranscriptLine[] = [];
        let used = 0;
        for (const l of r.lines as Record<string, unknown>[]) {
            const who = str(l?.who, 120) ?? "Speaker", text = str(l?.text, TRANSCRIPT_STORE_MAX);
            if (!text) continue;
            const t = text.slice(0, TRANSCRIPT_STORE_MAX - used);
            if (!t) break;
            lines.push({ who, text: t });
            used += t.length;
        }
        if (lines.length) { m.transcript = lines; m.transcriptState = "ready"; attachTranscript(w, m); return true; }
    }
    if (r?.status === "not_allowed" || r?.status === "not_found") m.transcriptState = "not_allowed";
    else m.transcriptState = ms(m.end) < now - TRANSCRIPT_WAIT_MS + TRANSCRIPT_EVERY_MS ? "none" : "waiting";
    return false;
}

/** The transcript as evidence beside each kept entry's meeting record that does not have one yet. */
export function attachTranscript(w: Workspace, m: Meeting): void {
    if (!m.transcript?.length || !w.evidence) return;
    for (const e of w.entries) for (const src of [...(e.sources ?? [])]) {
        const ev = w.evidence[src.id];
        if (!ev || ev.kind !== "meeting" || ev.meeting_id !== m.id || ev.transcript) continue;
        const tid = `${src.id}:transcript`;
        w.evidence[tid] = transcriptEvidence(tid, src.id, m);
        ev.transcript = tid;
        const list = e.sources!;
        list.splice(list.indexOf(src) + 1, 0, { id: tid, kind: "transcript", label: `Transcript of ${src.label}` });
    }
}

const transcriptEvidence = (id: string, meetingEvidence: string, m: Meeting): Evidence => ({ id, kind: "transcript", meeting: meetingEvidence, lines: (m.transcript ?? []).map((l) => ({ t: "", who: l.who, text: l.text })) });

/** The evidence a kept activity's meeting gives its entry: the meeting, and its transcript when there is one. */
export function meetingEvidence(a: Activity, meetings: readonly Meeting[] | undefined, title: string, when: string): Record<string, Evidence> {
    const ref = a.meeting;
    if (!ref) return {};
    const m = meetings?.find((x) => x.id === ref.id);
    const out: Record<string, Evidence> = {
        [a.id]: { id: a.id, kind: "meeting", title, subject: ref.subject, when, meeting_id: ref.id, attendees: ref.with, teams: ref.online === "teams",
            ...(m ? { start: m.start, end: m.end, ...(m.organizer ? { organizer: m.organizer } : {}), ...(m.location ? { location: m.location } : {}), ...(m.notes ? { body: m.notes } : {}) } : {}) },
    };
    if (m?.transcript?.length) { const tid = `${a.id}:transcript`; out[tid] = transcriptEvidence(tid, a.id, m); out[a.id].transcript = tid; }
    return out;
}

/** The workspace's meetings, checked like the rest of the file. */
export function meetingsValid(w: Workspace): boolean {
    const s = w.meetings;
    const refOk = (r: MeetingRef | undefined) => r == null || (typeof r.id === "string" && typeof r.subject === "string" && Array.isArray(r.with) && PROVIDERS.has(r.provider));
    if (!w.activities.every((a) => refOk(a.meeting))) return false;
    if (s == null) return true;
    return typeof s.since === "string" && Number.isFinite(ms(s.since)) && Array.isArray(s.list) && Array.isArray(s.calendars)
        && s.list.every((m) => !!m && typeof m.id === "string" && PROVIDERS.has(m.provider) && Number.isFinite(ms(m.start)) && Number.isFinite(ms(m.end)) && Array.isArray(m.attendees)
            && (m.transcriptState == null || STATES.has(m.transcriptState)) && (m.transcript == null || (Array.isArray(m.transcript) && m.transcript.every((l) => l && typeof l.who === "string" && typeof l.text === "string"))));
}
