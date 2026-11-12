import { prepareImportedKeep, validateFeedState, type FeedState, type SourceRef } from "./feed";
import { excludedCallApp } from "./calls";
import { isProduct, type Product } from "./kiwi";
import { meetingEvidence, meetingsValid, type MeetingRef, type MeetingsState } from "./meetings";
import type { MatterContext, Profile, RuleSet } from "./rules";
/* The workspace and the rules that change it. Pure: no Electron, no filesystem, no
   clock of its own — every function takes `now` in milliseconds — so the whole thing
   runs under vitest and inside the main process unchanged.

   These are the ideas the Swift app (legacy/swift) was built on, kept: capture is opt-in
   and titles are a separate opt-in; a segment is bounded by wall-clock observations and
   never spans an unobserved gap; idle trims to the last input; raw activity is evidence,
   not time, until a person keeps it; kept time never overlaps; rates freeze at save.
   Dates are ISO-8601 strings, which is both the file format and the wire format. */

/** 3 (2026-10-26): entries may carry what the person typed, the drafted narrative's parts and
 *  their sources, and the workspace an evidence list. Every addition is optional, so a version 2
 *  file reads as it is and is written back as 3. */
export const SCHEMA_VERSION = 3;
/** Older versions this app reads unchanged. */
const READS_VERSIONS = new Set<unknown>([2, SCHEMA_VERSION]);
export const APP_ID = "co.lawdie.timecapture.desktop";
/** A stalled process or a sleep must never inflate a timer or a segment. */
export const GAP_SECONDS = 45;
export const MIN_ACTIVITY_SECONDS = 2;
/**
 * No mouse or keyboard input for this long is flagged as idle on the segment in front
 * (2026-11-04, the beta user: "flag as idle" after 10 minutes). Flagged, not removed:
 * reading a contract is still work, so the person decides at keep. A call is never idle.
 */
export const IDLE_FLAG_SECONDS = 10 * 60;

export type Project = {
    id: string;
    name: string;
    nameBy?: "ai" | "person" | "kiwi";
    kiwiProjectID?: string;
    kiwiAccount?: string;
    matterNumber?: string;
    aliases?: string[];
    client: string;
    color: string;
    hourlyRate: number;
    archived: boolean;
    /** What a model made of the matter's work, shown on its page. Nothing writes one yet but
     *  sample data ("sample"); Kiwi is meant to ("kiwi"). */
    insight?: MatterInsight | null;
    /** The matter's number, client and people, and what its documents are called: what the
     *  local drafter (src/shared/narrative.ts) and the billing rules need to read capture. */
    context?: MatterContext | null;
    /** The invoice's "Bill to" lines for this matter (the client's billing contact and address); the client's name alone without them. */
    billTo?: string[];
    /** The UTBMS code set the client bills this matter under; the rules read it when `context` has none. */
    codeSet?: "project" | "counseling" | "litigation";
};

export type MatterInsight = { summary: string; points: string[]; generatedAt: string; source: "kiwi" | "sample" };
export const INSIGHT_MAX = 2000;

const insightValid = (i: MatterInsight | null | undefined): boolean =>
    i == null || (typeof i.summary === "string" && i.summary.length <= INSIGHT_MAX && Array.isArray(i.points) && i.points.length <= 12
        && i.points.every((x) => typeof x === "string" && x.length <= 500) && validIso(i.generatedAt) && (i.source === "kiwi" || i.source === "sample"));

export type TimeEntry = {
    id: string;
    description: string;
    projectID: string | null;
    startedAt: string;
    endedAt: string;
    billable: boolean;
    hourlyRate: number;
    /** manual | timer | desktop | timer-idle | timer-suspended | timer-recovered */
    source: string;
    activityID: string | null;
    sourceRefs?: SourceRef[];
    /** A stretch kept from several sittings: the sittings, in order, inside [startedAt, endedAt]. Only their time counts. */
    sittings?: Interval[];
    /** Every activity a stretch entry was kept from (activityID is the first). */
    activityIDs?: string[];
    /** The description is an AI draft, kept as written. */
    drafted?: DraftSource;
    /** Screenshots of the activity it was kept from, inside its time. On this computer only; never synced. */
    screenshots?: string[];
    /** Hours billed, in the client's increment; absent means the captured time. */
    hours?: number;
    /** UTBMS task and activity codes (P500 / A103), when the client asks for them. */
    taskCode?: string;
    activityCode?: string;
    /** What the attorney typed on the time card ("phone call with client"); empty when nothing. */
    raw?: string;
    /** The drafted narrative in parts, each with the evidence ids it rests on (workspace.evidence). */
    parts?: NarrativePart[];
    /** The sources behind the parts, in order, as the side panel lists them. */
    sources?: NarrativeSource[];
    /** draft: drafted from evidence; suggested: built from matter history, to confirm; flagged: needs the person. */
    status?: EntryStatus;
    /** Why an entry is suggested or flagged. */
    why?: string;
    /** The person edited the narrative: the parts no longer match it, so it shows as plain text. */
    partsEdited?: boolean;
    /** Who drafted the parts: the stored rules, or a model. */
    drafter?: DrafterKind;
    /** What capture saw for this time: the app and its window title or document (a browser stretch has no activity). */
    seen?: { app: string; title: string };
    /** The high-level task this entry is part of ("hvhp-agreement", "HVHP provider agreement"); the Time page groups by it. */
    group?: string;
    groupLabel?: string;
    /** When the narrative was drafted. */
    draftedAt?: string;
    /** What capture saw for this entry, stretch by stretch: app, window or document, start, minutes. */
    work?: WorkStretch[];
    /** Why the narrative says what it says, one plain sentence each. */
    reasons?: string[];
    /** Why the entry is on its matter ("Matter 61407-002 from the meeting title."). */
    matterReason?: string;
    /** A note the person typed for this work (an imported row or Add entry) that was matched and accepted into this
     *  entry. It is the same work, so its hours are never added: the entry keeps the hours Time Capture recorded. */
    typed?: { note: string; hours: number; rowID: string; origin: "import" | "manual" } | null;
    /** The tasks of a block-billed entry, one per work stretch (`stretch` indexes `work`), with their own codes: what a
     *  split or a "time for each task" rule bills. Without them a rule splits the narrative at its semicolons. */
    tasks?: EntryTask[] | null;
};

/** What the time sheet and invoice PDFs need beyond the entries (src/shared/invoice.ts). Written by a demo seed. */
export type InvoiceTerms = {
    firm: { name: string; address: string[] };
    billTo: string[];
    client: string;
    matter: string;
    matterName: string;
    number: string;
    through: string;
    /** The most an hour may bill at (an engagement-letter panel rate), and where that rule comes from. */
    rateCap?: number;
    rateCapRule?: string;
    /** Entries with this UTBMS activity code bill at no charge (internal conferences), and the rule. */
    noChargeActivity?: string;
    noChargeRule?: string;
    terms: string;
    timekeeper: { name: string; title: string };
    /** Where the PDFs are saved. */
    folder?: string;
    /** The firm's logo, an absolute PNG path on this machine. */
    logo?: string;
    footer?: string;
    /** Where and how to pay, as lines (the seed writes them); without them the invoice prints placeholders. */
    remit?: string[] | string | null;
    /** Who to ask about the invoice. */
    contact?: string | null;
};

/** The firm's side of every invoice and time sheet, set once in Settings → Billing (2026-11-04; before it only a demo
 *  seed's `invoice` carried them). `termsFor()` in invoice.ts joins it with a matter into the InvoiceTerms a bill prints. */
export type BillingSetup = {
    firm: { name: string; address: string[] };
    /** The firm's logo as a PNG beside the workspace (`billing-logo.png`): fetched from the firm's website or chosen as a file. */
    logo?: string | null;
    timekeeper: { name: string; title: string };
    /** Payment terms as printed ("Net 30"). */
    terms?: string;
    /** Where and how to pay, as lines; placeholders print without them. */
    remit?: string[];
    contact?: string;
    footer?: string;
    /** Where PDFs and DOCX files are saved; asked for each time without one. */
    folder?: string;
    /** The next invoice's number is `${prefix}${next}` ("2026-" + 12 → 2026-012); `next` moves on when an invoice is made. */
    invoicePrefix?: string;
    nextInvoice?: number;
};
export const BILLING_LINE_MAX = 200;
export const BILLING_LINES_MAX = 8;

/** An invoice as it went out: what it covered and, when the client sent it back, their words (src/shared/rejection.ts). */
export type IssuedInvoice = {
    number: string;
    projectID: string | null;
    client: string;
    matter: string;
    /** YYYY-MM-DD, `to` inclusive; a day bill has both the same. */
    from: string;
    to: string;
    /** "generic" or the rulebook's key. */
    mode: string;
    issuedAt: string;
    total: number;
    entryIDs: string[];
    rejection?: { at: string; by: string; note: string; ruleIDs: string[] } | null;
};
export const REJECTION_NOTE_MAX = 4000;

const invoicesValid = (list: unknown): boolean =>
    list == null || (Array.isArray(list) && list.every((i) => !!i && typeof i.number === "string" && typeof i.from === "string" && typeof i.to === "string" && validIso(i.issuedAt) && Number.isFinite(i.total) && Array.isArray(i.entryIDs)
        && (i.rejection == null || (validIso(i.rejection.at) && typeof i.rejection.note === "string" && i.rejection.note.length <= REJECTION_NOTE_MAX && Array.isArray(i.rejection.ruleIDs)))));

/** An invoice made: remembered, so a rejection can name it and send its entries back. */
export function issueInvoice(w: Workspace, record: Omit<IssuedInvoice, "rejection">): void {
    (w.invoices ??= []).push({ ...record, entryIDs: [...new Set(record.entryIDs)] });
    if (w.invoices.length > 500) w.invoices.splice(0, w.invoices.length - 500);
}

export type EntryTask = { stretch?: number | null; text: string; task?: string | null; activity?: string | null; hours?: number | null };

/** `sourceID`: the source (and evidence) this stretch is, when capture made it, so the Why panel shows the two as one row. */
export type WorkStretch = { app: string; title: string; startedAt: string; minutes: number; url?: string | null; sourceID?: string; summary?: string };

/** A row typed into the firm's time system (an iTimeKeep export), matched back to the captured entry it describes. */
export type ImportedRow = {
    id: string;
    date: string;
    matter: string;
    timekeeper: string;
    hours: number;
    description: string;
    /** The captured entry this row describes, or null when no captured work matches. */
    entryID: string | null;
    /** The person's choice: use Lawdie's narrative for this row, or keep what they typed. */
    decision?: "use" | "keep" | null;
    /** Matched to captured work ("Link sources and draft narratives" or "Expand narrative"); until then the row shows as typed. */
    linked?: boolean;
    /** Where the row came from: an imported export, or typed into this app with Add entry. */
    origin?: "import" | "manual";
    /** For an imported row, the file it came from: the iTimeKeep CSV export, or a spreadsheet (.xlsx). */
    source?: "itimekeep" | "excel" | null;
    /** The matter the row was typed for, when it was picked from this app's matters (Add entry). */
    projectID?: string | null;
    /** When this row found no entry of its own because another typed row already holds that work: that row's id. */
    sameAs?: string | null;
    /** The matched entry as it was before this row's decision changed it, so Undo puts it back exactly. */
    prior?: Partial<Pick<TimeEntry, "description" | "status" | "why" | "partsEdited" | "drafted" | "typed">> | null;
};

/** One of a client's billing rules, in the client's own words, with what Lawdie does about it. */
export type ClientRule = {
    /** "NBH-2". */
    id: string;
    /** "§5.1" or "Engagement letter §3". */
    section: string;
    title: string;
    /** The client's words, quoted. */
    quote: string;
    /** What Lawdie does, in a sentence. */
    does: string;
    /** What the rule does to a bill (src/shared/invoice.ts): split one task per line; noCharge an activity code at no
     *  charge; rateCap the rate; tenths hours in tenths; notBilled tasks named by `words`; codePrefix a UTBMS code in
     *  front of the narrative; callCap calls cut to `maxHours`; blockWithTimes several tasks on one line, each task's
     *  time written in; seniorOnly an internal conference billed for the senior attendee only. check: read only. */
    kind: "split" | "noCharge" | "rateCap" | "tenths" | "notBilled" | "codePrefix" | "callCap" | "blockWithTimes" | "seniorOnly" | "check";
    activityCode?: string;
    rate?: number;
    words?: string[];
    /** codePrefix: which code goes first, the task code (C300) or the activity code (A106). */
    code?: "task" | "activity";
    /** For a check: which one (src/shared/clientRules.ts), its limit, the approved names, and typed notes to test it on. */
    check?: "vague" | "oneAttendee" | "researchCap" | "clerical" | "travel" | "timekeepers";
    maxHours?: number;
    approved?: string[];
    examples?: string[];
    /** Where the rule is written: a document (evidence id), its section and page, and the email that delivered it. */
    sources?: RuleSource[];
    enabled: boolean;
};
export type RuleSource = { doc: string; section: string; page?: number | null; email?: string | null };
export type ClientRules = { client: string; title: string; rules: ClientRule[] };
/** One client's billing rules as the app applies them (Time page, Apply client rules). */
export type ClientRulebook = {
    /** "northlake". */
    key: string;
    client: string;
    /** "Northlake", "Kestrel Valley". */
    short: string;
    title: string;
    /** "January 1, 2026". */
    effective: string;
    /** The guidelines document and the email that delivered them (evidence ids). */
    doc: string;
    email: string;
    rules: ClientRule[];
};
const RULE_KINDS = new Set<unknown>(["split", "noCharge", "rateCap", "tenths", "notBilled", "codePrefix", "callCap", "blockWithTimes", "seniorOnly", "check"]);
const rulesValid = (rules: unknown): boolean => Array.isArray(rules) && rules.every((r) => !!r && typeof r.id === "string" && RULE_KINDS.has(r.kind) && typeof r.enabled === "boolean");

export type NarrativePart = { text: string; evidence: string[]; slot?: string | null };
export type NarrativeSource = { id: string; kind: string; label: string };
export type EntryStatus = "draft" | "suggested" | "flagged" | "dismissed";
const ENTRY_STATUSES = new Set<unknown>(["draft", "suggested", "flagged", "dismissed"]);
export type DrafterKind = "rules" | "model";
/** One thing a narrative rests on: an email, a meeting, a transcript or a document (story.json's evidence). */
export type Evidence = {
    id: string;
    kind: string;
    subject?: string; from?: string; to?: string[]; cc?: string[]; when?: string; body?: string;
    start?: string; end?: string; attendees?: string[]; organizer?: string; teams?: boolean; location?: string; transcript?: string | null;
    meeting?: string; lines?: { t: string; who: string; text: string }[];
    file?: string; title?: string; path?: string;
    facts?: string[];
    /** A calendar meeting's id (src/shared/meetings.ts), so its transcript can join it when it arrives. */
    meeting_id?: string;
    /** A Teams invite: the meeting it is the invite for. */
    invite_for?: string | null;
    /** An Outlook web link, filled in after the Graph seed. */
    link?: string;
    /** A picture of the source as it looked (an absolute PNG path on this machine). */
    screenshot?: string;
};
/** A stretch kept off the bill on purpose (personal browsing): shown greyed, never synced. */
export type PrivateStretch = { key: string; startedAt: string; endedAt: string; app: string; title: string; why: string };

export type Interval = { startedAt: string; endedAt: string };

/** Where a draft came from: Kiwi, sample data, or the local drafter that reads capture (src/shared/narrative.ts). */
export type DraftSource = "kiwi" | "sample" | "capture";
const DRAFT_SOURCES = new Set<unknown>(["kiwi", "sample", "capture"]);
export type Draft = { text: string; source: DraftSource };
export const DRAFT_MAX = 500;
const draftValid = (d: Draft | null | undefined): boolean => d == null || (typeof d.text === "string" && d.text.length > 0 && d.text.length <= DRAFT_MAX && DRAFT_SOURCES.has(d.source));

/** What one sitting was, in a line, written by Kiwi's model from what capture saw (src/shared/summaries.ts); `screenshot` when a screenshot was read too. */
export type SittingSummary = { text: string; source: "kiwi" | "sample"; screenshot?: true };
export const SUMMARY_MAX = 200;
const summaryValid = (x: SittingSummary | null | undefined): boolean => x == null || (typeof x.text === "string" && x.text.length > 0 && x.text.length <= SUMMARY_MAX && (x.source === "kiwi" || x.source === "sample") && (x.screenshot == null || x.screenshot === true));

export type RunningTimer = {
    description: string;
    projectID: string | null;
    startedAt: string;
    lastHeartbeat: string;
    billable: boolean;
    hourlyRate: number;
};

/** What an Office app said it had open, when the person switched that on. */
export type DocumentInfo = {
    /** "Whitfield motion.docx", or an email's subject. */
    name: string;
    /** Where it is saved, or null for an unsaved document or an email. */
    path: string | null;
    /** The first few hundred characters of text (Outlook: sender and subject), or null. */
    excerpt: string | null;
};

export const EXCERPT_MAX = 600;

export type Activity = {
    origin?: "browser" | "kiwi";
    originRef?: string;
    originAccount?: string;
    sourceKind?: "browser" | "chat" | "email";
    kiwiProjectID?: string;
    projectID?: string;
    url?: string;
    /** Imported time after overlap subtraction. Original bounds stay on the feed receipt. */
    sittings?: Interval[];
    id: string;
    app: string;
    /** The stable id of the app: bundle id on macOS, executable path elsewhere. */
    ownerID: string;
    title: string | null;
    /** Present only for Office apps with "Read Office document details" on. */
    document?: DocumentInfo | null;
    /** Text the window showed, read through the OS accessibility system, with "Read on-screen text" on. */
    screenText?: string | null;
    /** Screenshot files of the window (names, in the screenshots folder beside the workspace), with "Take screenshots" on. Never synced. */
    screenshots?: string[];
    startedAt: string;
    endedAt: string;
    endedBy: string;
    /** The app switched to when it ended (endedBy "switched" or "browser"): a name, never a title. */
    endedTo?: string;
    /** Stretches of no mouse or keyboard input of IDLE_FLAG_SECONDS or more, inside it. Never on a call. */
    idle?: Interval[];
    disposition: "pending" | "kept" | "dismissed";
    /** The matter this was work on: suggested by the model (src/shared/matters.ts) or set by
     *  the person. Absent until asked; null when it is not work on any matter. */
    matter?: string | null;
    /** Who named the matter. A person's answer is never overwritten by a suggestion. */
    matterBy?: "ai" | "person";
    /** A billing description drafted by a model for the work this is part of; a person keeps or edits it. */
    draft?: Draft | null;
    /** What this sitting was, in a line (Kiwi's model, from its text and, when screenshots are on, one screenshot). Never synced. */
    summary?: SittingSummary;
    /** The description the person gave it in review, before keeping: wins over the draft, and is never drafted over. */
    description?: string;
    /** Merged with a kept entry (that entry's id, now deleted): reviewed as one row with its sittings, and kept again. */
    mergeKey?: string;
    /** Kept entries the person said this is not more of: never offered again. */
    separateFrom?: string[];
    /** The calendar meeting this was (src/shared/meetings.ts): a call capture counted, or a row from the calendar itself (ownerID "calendar:…"). */
    meeting?: MeetingRef;
};

export type Preferences = {
    importKiwiTime?: boolean;
    captureEnabled: boolean;
    captureTitles: boolean;
    /** Ask Word, Excel, PowerPoint and Outlook what is open: name, path, a text excerpt. */
    captureDocuments: boolean;
    /** Read the text the window in front shows (accessibility), for apps other than Office and browsers. */
    captureScreenText: boolean;
    /** Send closed, pending activity (titles, document details) to Kiwi to name its matter. */
    suggestMatters: boolean;
    idleMinutes: number;
    retentionDays: number;
    excludedOwnerIDs: string[];
    /** A screenshot of the window in front now and then, kept on this computer only. Absent is off. */
    captureScreenshots?: boolean;
    /** The window's zoom, for reading at a distance: 1 (standard) to TEXT_SIZES' largest. Absent is 1. */
    textSize?: number;
    /** Who drafts narratives from evidence: the stored rules (the demo) or a model through Kiwi. */
    narrativeDrafter?: DrafterKind;
    /** Send errors to Lawdie (src/main/errors.ts): the error and which features were on, never what was on screen. Absent is on. */
    crashReports?: boolean;
    /** Bring in Google and Outlook calendar meetings through Kiwi (src/shared/meetings.ts). Absent is off. */
    importMeetings?: boolean;
    /** Fetch Teams transcripts of those meetings, kept on this computer. Absent is off. */
    meetingTranscripts?: boolean;
    /** When the welcome was finished or skipped (src/shared/onboarding.ts). Absent on a workspace nobody has used: the welcome shows. */
    onboardedAt?: string | null;
    /** The newest What's new release dismissed on this computer (src/shared/releases.ts). Absent: the card opens once. */
    seenRelease?: string | null;
};

/** The text sizes Settings offers. */
export const TEXT_SIZES = [1, 1.15, 1.3] as const;

/** One product this computer syncs to. Each has its own device row, so its own id and name. */
export type SyncTarget = {
    product: Product;
    serverURL: string;
    deviceID: string;
    deviceName: string;
    accountEmail: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
    /** Deletions this product has not acknowledged yet: the one outbox, per product. */
    deletedEntryIDs: string[];
};

/** Kiwi, Lawdie CRM, or both — with one token. Files from 0.4.x (one product, flat) are read into this. */
export type SyncState = {
    targets: SyncTarget[];
    autoSync: boolean;
};

export type Workspace = {
    feed?: FeedState;
    schemaVersion: number;
    projects: Project[];
    entries: TimeEntry[];
    activities: Activity[];
    timer: RunningTimer | null;
    currentActivity: Activity | null;
    preferences: Preferences;
    sync: SyncState | null;
    /** Each client's billing rules, as the billing system last sent them (src/main/rulesFeed.ts). */
    rulebooks?: RuleSet[];
    /** Who keeps time here: the timekeeper the rules check entries for. */
    profile?: Profile | null;
    /** A demo workspace made from a seed file: which reset and which stage it is at. Never set on a real workspace. */
    demo?: { seed: string; epoch: number; stage: string; day: string } | null;
    /** What narratives rest on, by id: emails, meetings, transcripts, documents. Local only; never synced. */
    evidence?: Record<string, Evidence>;
    /** Stretches kept off the bill on purpose; local only, never synced. */
    privateStretches?: PrivateStretch[];
    /** Rows imported from the firm's time system, each matched to a captured entry (src/shared/importMatch.ts). Local only. */
    imported?: ImportedRow[];
    /** Firm, bill-to and the client's billing rules for the time sheet and invoice. Only a demo seed sets it;
     *  a person's firm details are `billing`, which `termsFor()` turns into these for one matter and period. */
    invoice?: InvoiceTerms | null;
    /** The firm's billing details, from Settings → Billing. */
    billing?: BillingSetup | null;
    /** Every invoice made here (the Invoice sheet), newest last, and the client's rejection of it when there was one. */
    invoices?: IssuedInvoice[];
    /** The client's billing rules (its outside counsel guidelines and engagement letter), each on or off. */
    clientRules?: ClientRules | null;
    /** Every client whose rules can be applied to the day, and the one applied now (its key), or null for generic billing. */
    clientRulebooks?: ClientRulebook[] | null;
    billingClient?: string | null;
    /** Calendar meetings and their transcripts (src/shared/meetings.ts). Local only; never synced. */
    meetings?: MeetingsState | null;
};

export const DEFAULT_EXCLUSIONS = [
    // macOS
    "com.apple.systempreferences",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.agilebits.onepassword7",
    "com.1password.1password",
    // Windows (executable names; matched case-insensitively by basename)
    "1password.exe",
    "keepass.exe",
    "bitwarden.exe",
];

export function defaultPreferences(): Preferences {
    return { importKiwiTime: false, captureEnabled: false, captureTitles: false, captureDocuments: false, captureScreenText: false, suggestMatters: false, captureScreenshots: false, idleMinutes: 3, retentionDays: 14, excludedOwnerIDs: [...DEFAULT_EXCLUSIONS], narrativeDrafter: "rules" };
}

export function emptyWorkspace(): Workspace {
    return { schemaVersion: SCHEMA_VERSION, projects: [], entries: [], activities: [], timer: null, currentActivity: null, preferences: defaultPreferences(), sync: null };
}

export class WorkspaceError extends Error {}

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
/** The spans an entry's time is made of: its sittings when it was kept as a stretch, else the whole interval. */
export const intervals = (e: Interval & { sittings?: Interval[] }): Interval[] => (e.sittings && e.sittings.length ? e.sittings : [e]);
const spanSeconds = (a: Interval) => Math.max(0, (ms(a.endedAt) - ms(a.startedAt)) / 1000);
/** Seconds of work in an entry or activity: a stretch counts only its sittings, never the gaps between them. */
export const seconds = (a: Interval & { sittings?: Interval[] }) => intervals(a).reduce((sum, i) => sum + spanSeconds(i), 0);
/** The seconds of an entry that fall inside [start, end]. */
export const secondsWithin = (e: Interval & { sittings?: Interval[] }, start: number, end: number) =>
    intervals(e).reduce((sum, i) => sum + Math.max(0, Math.min(ms(i.endedAt), end) - Math.max(ms(i.startedAt), start)) / 1000, 0);

export function uuid(): string {
    return globalThis.crypto.randomUUID();
}

export function project(w: Workspace, id: string | null): Project | undefined {
    return id ? w.projects.find((p) => p.id === id) : undefined;
}

/**
 * Browsers belong to the Lawdie browser extension, which records the pages themselves;
 * the desktop app leaves them alone so that time is never counted twice. Matched like an
 * exclusion: bundle id on macOS, executable basename on Windows and Linux.
 */
export const BROWSER_OWNER_IDS = [
    // macOS
    "com.google.chrome", "com.google.chrome.beta", "com.google.chrome.dev", "com.google.chrome.canary", "org.chromium.chromium",
    "com.apple.safari", "com.apple.safaritechnologypreview", "com.microsoft.edgemac", "com.microsoft.edgemac.beta", "com.microsoft.edgemac.dev",
    "com.brave.browser", "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "company.thebrowser.browser", "com.operasoftware.opera",
    "com.vivaldi.vivaldi", "app.zen-browser.zen",
    // 2026-11-11: newer and less common browsers, which would otherwise be counted here and by the extension.
    "company.thebrowser.dia", "ai.perplexity.comet", "com.kagi.kagimacos", "com.sigmaos.sigmaos.macos", "com.operasoftware.operagx",
    "com.duckduckgo.macos.browser", "org.mozilla.nightly", "com.microsoft.edgemac.canary", "com.google.chrome.for.testing",
    "io.gitlab.librewolf-community", "net.waterfox.waterfox", "one.ablaze.floorp", "ru.yandex.desktop.yandex-browser", "com.naver.whale",
    // Windows and Linux
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe",
    "duckduckgo.exe", "zen.exe", "librewolf.exe", "waterfox.exe", "floorp.exe", "comet.exe", "whale.exe", "chromium.exe",
    "chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "firefox", "brave", "brave-browser", "microsoft-edge", "opera", "vivaldi",
    "google-chrome-beta", "google-chrome-unstable", "microsoft-edge-stable", "microsoft-edge-beta", "firefox-esr", "librewolf", "zen", "zen-bin", "waterfox", "floorp", "vivaldi-stable", "opera-beta",
];

const matchesOwner = (list: readonly string[], ownerID: string): boolean => {
    const lower = ownerID.toLowerCase();
    const base = lower.split(/[\\/]/).pop() ?? lower;
    return list.some((x) => { const xl = x.toLowerCase(); return xl === lower || xl === base; });
};

export const isBrowser = (ownerID: string): boolean => matchesOwner(BROWSER_OWNER_IDS, ownerID);

/** The lock and login screens (macOS loginwindow, Windows LockApp and LogonUI): time in front of them is never counted. */
export const LOCK_SCREEN_OWNER_IDS = ["com.apple.loginwindow", "loginwindow", "/system/library/coreservices/loginwindow.app", "lockapp.exe", "logonui.exe"];
export const isLockScreen = (ownerID: string): boolean => matchesOwner(LOCK_SCREEN_OWNER_IDS, ownerID) || /loginwindow\.app/i.test(ownerID);

/**
 * Mail apps: every message is its own window title (and document), so an hour of email is
 * dozens of half-minute sittings. Without a matter they are reviewed as one stretch per app,
 * not one per message, or they would all fall under the short hops (2026-10-22).
 */
export const MAIL_OWNER_IDS = ["com.microsoft.outlook", "outlook.exe", "olk.exe", "com.apple.mail", "org.mozilla.thunderbird", "thunderbird.exe", "thunderbird"];
export const isMail = (ownerID: string): boolean => matchesOwner(MAIL_OWNER_IDS, ownerID);

/** Excluded apps are matched by exact id, or by executable basename on Windows/Linux. */
export function isExcluded(prefs: Preferences, ownerID: string): boolean {
    return matchesOwner(prefs.excludedOwnerIDs, ownerID) || excludedCallApp(prefs.excludedOwnerIDs, ownerID);
}

export function overlaps(w: Workspace, start: number, end: number, excluding: string | null = null): boolean {
    return (
        w.entries.some((e) => e.id !== excluding && intervals(e).some((i) => ms(i.startedAt) < end && ms(i.endedAt) > start)) ||
        (w.timer !== null && ms(w.timer.startedAt) < end)
    );
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

export function startTimer(w: Workspace, input: { description: string; projectID: string | null; billable: boolean }, now: number): void {
    if (w.timer) throw new WorkspaceError("Stop the current timer before starting another.");
    const text = input.description.trim();
    if (!text) throw new WorkspaceError("Add a description for this time entry.");
    if (input.projectID && !project(w, input.projectID)) throw new WorkspaceError("Choose an existing project.");
    w.timer = { description: text, projectID: input.projectID, startedAt: iso(now), lastHeartbeat: iso(now), billable: input.billable, hourlyRate: project(w, input.projectID)?.hourlyRate ?? 0 };
}

export function stopTimer(w: Workspace, at: number, source = "timer"): void {
    const running = w.timer;
    if (!running) return;
    w.timer = null;
    const end = Math.max(ms(running.startedAt), at);
    if (end - ms(running.startedAt) >= 1000) {
        w.entries.push({ id: uuid(), description: running.description, projectID: running.projectID, startedAt: running.startedAt, endedAt: iso(end), billable: running.billable, hourlyRate: running.hourlyRate, source, activityID: null });
    }
}

// ---------------------------------------------------------------------------
// Entries and review
// ---------------------------------------------------------------------------

export function saveEntry(w: Workspace, entry: TimeEntry, now: number): void {
    if (!entry.description.trim()) throw new WorkspaceError("Add a description.");
    const start = ms(entry.startedAt), end = ms(entry.endedAt);
    if (!(end > start) || end > now + 1000) throw new WorkspaceError("The end must be after the start and cannot be in the future.");
    if (!Number.isFinite(entry.hourlyRate) || entry.hourlyRate < 0) throw new WorkspaceError("Enter a valid hourly rate.");
    if (entry.projectID && !project(w, entry.projectID)) throw new WorkspaceError("Choose an existing project.");
    if (entry.sittings && !sittingsValid(entry)) throw new WorkspaceError("The sittings of this entry are out of order or outside its span.");
    if (intervals(entry).some((i) => overlaps(w, ms(i.startedAt), ms(i.endedAt), entry.id))) throw new WorkspaceError("This time overlaps another entry or the running timer. Adjust the times to avoid double counting.");
    const index = w.entries.findIndex((e) => e.id === entry.id);
    if (index >= 0) w.entries[index] = entry;
    else w.entries.push(entry);
}

/** Sittings inside the entry's span, in order, not overlapping one another. */
export function sittingsValid(e: TimeEntry): boolean {
    const list = e.sittings ?? [];
    return list.every((i, n) => validIso(i.startedAt) && validIso(i.endedAt) && ms(i.endedAt) > ms(i.startedAt)
        && ms(i.startedAt) >= ms(e.startedAt) && ms(i.endedAt) <= ms(e.endedAt) && (n === 0 || ms(i.startedAt) >= ms(list[n - 1].endedAt)));
}

/** Adjacent or touching spans become one. */
function mergeAdjacent(list: Interval[]): Interval[] {
    const out: Interval[] = [];
    for (const i of [...list].sort((a, b) => ms(a.startedAt) - ms(b.startedAt))) {
        const last = out[out.length - 1];
        if (last && ms(i.startedAt) <= ms(last.endedAt)) { if (ms(i.endedAt) > ms(last.endedAt)) last.endedAt = i.endedAt; }
        else out.push({ startedAt: i.startedAt, endedAt: i.endedAt });
    }
    return out;
}

export type KeepInput = {
    description: string;
    projectID: string | null;
    billable: boolean;
    /** The matter, by name, when projectID is null: the project of that name, made if there is none. */
    matter?: string | null;
    /** The description is the AI draft as offered, unedited. */
    drafted?: DraftSource;
    /** The span the person settled on before keeping, when they changed it. */
    startedAt?: string;
    endedAt?: string;
    /** Reviewed intervals for a split task; always intersected with the captured time. */
    sittings?: Interval[];
    /** Leave the flagged idle time out of the entry. */
    leaveOutIdle?: boolean;
    /** Billing details the client's rules ask for (see TimeEntry). */
    hours?: number;
    taskCode?: string;
    activityCode?: string;
    /** A rate other than the matter's, when a client rule caps it; frozen at save like any rate. */
    hourlyRate?: number;
};

/** Spans minus the spans to take out, in order. */
export function subtractIntervals(list: Interval[], out: Interval[]): Interval[] {
    let pieces = list.map((i) => ({ start: ms(i.startedAt), end: ms(i.endedAt) }));
    for (const o of out) {
        const os = ms(o.startedAt), oe = ms(o.endedAt);
        pieces = pieces.flatMap((p) => (oe <= p.start || os >= p.end ? [p] : [{ start: p.start, end: os }, { start: oe, end: p.end }].filter((x) => x.end > x.start)));
    }
    return pieces.map((p) => ({ startedAt: iso(p.start), endedAt: iso(p.end) }));
}

/** Seconds of flagged idle time among activities, inside [start, end] when given. */
export function idleSeconds(activities: readonly Pick<Activity, "idle">[], start = -Infinity, end = Infinity): number {
    return activities.flatMap((a) => a.idle ?? []).reduce((n, i) => n + Math.max(0, Math.min(ms(i.endedAt), end) - Math.max(ms(i.startedAt), start)) / 1000, 0);
}

/** The parts of the sittings inside [start, end]. */
export function clipSittings(list: Interval[], start: number, end: number): Interval[] {
    return list
        .map((i) => ({ startedAt: iso(Math.max(ms(i.startedAt), start)), endedAt: iso(Math.min(ms(i.endedAt), end)) }))
        .filter((i) => ms(i.endedAt) > ms(i.startedAt));
}

/** Only time present in both lists, with no duplicate intervals. */
export function intersectIntervals(list: Interval[], kept: Interval[]): Interval[] {
    return mergeAdjacent(kept.flatMap((i) => clipSittings(list, ms(i.startedAt), ms(i.endedAt))));
}

/** Copies of the evidence restricted to the reviewed time, used to plan split tasks. */
export function reviewedActivities(activities: readonly Activity[], kept: Interval[]): Activity[] {
    return activities.flatMap((a) => {
        const sittings = intersectIntervals(intervals(a), kept);
        return sittings.length ? [{ ...a, startedAt: sittings[0].startedAt, endedAt: sittings[sittings.length - 1].endedAt, sittings }] : [];
    });
}

/**
 * The entry a stretch would become for a span: one sitting takes the span as given (a
 * person may stretch it to when the work really started); several sittings are clipped
 * to it and only they count. Returns null when no captured time falls inside.
 */
export function stretchSpan(sittings: Interval[], start: number, end: number): { startedAt: string; endedAt: string; sittings?: Interval[] } | null {
    if (!(end > start)) return null;
    if (sittings.length <= 1) return { startedAt: iso(start), endedAt: iso(end) };
    const clipped = clipSittings(sittings, start, end);
    if (!clipped.length) return null;
    return clipped.length > 1 ? { startedAt: iso(start), endedAt: iso(end), sittings: clipped } : { startedAt: clipped[0].startedAt, endedAt: clipped[0].endedAt };
}

/**
 * Keep a stretch — one or more pending activities — as ONE entry. The entry spans the
 * first sitting's start to the last one's end (or the span the person set), but only the
 * sittings count as time and only they are held against overlap, so the minutes spent in
 * another document between two sittings stay free to be kept on their own.
 */
/**
 * "Why this entry", from what capture saw (2026-11-04; before, only a demo seed filled it):
 * where the time went stretch by stretch (`work`), each stretch as a source the drafter can
 * cite (`sources`, with an `evidence` record: a document with its path, an email's subject, a
 * web page with its address, else the app window), and the reasons in words. Only the time
 * inside [start, end] counts, as the entry keeps it.
 */
export function capturedWhy(picked: readonly Activity[], start: number, end: number, drafted: DraftSource | undefined, idleLeftOut = 0, keptIntervals: Interval[] = [{ startedAt: iso(start), endedAt: iso(end) }], meetings: MeetingsState["list"] = []): { work: WorkStretch[]; sources: NarrativeSource[]; evidence: Record<string, Evidence>; reasons: string[]; matterReason?: string } {
    const work: WorkStretch[] = [];
    const sources: NarrativeSource[] = [];
    const evidence: Record<string, Evidence> = {};
    const host = (url: string | undefined): string | null => { try { return url ? new URL(url).hostname.replace(/^www\./, "") || null : null; } catch { return null; } };
    for (const a of [...picked].sort((x, y) => ms(x.startedAt) - ms(y.startedAt))) {
        const kept = intersectIntervals(intervals(a), keptIntervals);
        const minutes = kept.reduce((n, i) => n + (ms(i.endedAt) - ms(i.startedAt)), 0) / 60_000;
        if (!kept.length || !minutes) continue;
        const mail = a.sourceKind === "email" || matchesOwner(MAIL_OWNER_IDS, a.ownerID);
        const kind = a.meeting ? "meeting" : a.document && !mail ? "document" : a.url ? "page" : mail ? "email" : a.sourceKind === "chat" ? "chat" : "window";
        const title = a.meeting?.subject || a.document?.name || a.title || host(a.url) || a.app;
        for (const i of kept) work.push({ app: a.app, title, startedAt: i.startedAt, minutes: (ms(i.endedAt) - ms(i.startedAt)) / 60_000, ...(a.url ? { url: a.url } : {}), sourceID: a.id, ...(a.summary ? { summary: a.summary.text } : {}) });
        sources.push({ id: a.id, kind, label: title });
        const facts = [a.summary?.text, a.document?.excerpt, a.screenText].filter((x): x is string => !!x).map((x) => x.slice(0, 600));
        if (a.meeting) {
            const found = meetingEvidence(a, meetings, title, kept[0].startedAt);
            Object.assign(evidence, found);
            const tid = found[a.id].transcript;
            if (tid) sources.push({ id: tid, kind: "transcript", label: `Transcript of ${title}` });
            continue;
        }
        evidence[a.id] = {
            id: a.id, kind, title, when: kept[0].startedAt,
            ...(kind === "document" ? { file: a.document!.name, ...(a.document!.path ? { path: a.document!.path } : {}) } : {}),
            ...(kind === "email" ? { subject: a.document?.name || a.title || "", ...(a.document?.excerpt ? { body: a.document.excerpt } : {}) } : {}),
            ...(a.url ? { link: a.url } : {}),
            ...(facts.length && kind !== "email" ? { facts } : {}),
        };
    }
    // The work rows say where the time went; the reasons say what is not on them.
    const reasons: string[] = [];
    if (idleLeftOut >= 60) reasons.push(`${Math.round(idleLeftOut / 60)} minutes without mouse or keyboard input were left out.`);
    reasons.push(drafted === "kiwi" ? "Kiwi's AI drafted the narrative from the window titles and document details above."
        : drafted === "sample" ? "The narrative is a sample draft." : drafted === "capture" ? "The narrative is what capture named the work." : "The narrative is as you wrote it when you kept the time.");
    const by = picked.find((a) => a.matter)?.matterBy;
    const matterReason = by === "ai" ? "Kiwi's AI named the matter from the titles and documents; you kept it." : by === "person" ? "You named the matter." : undefined;
    return { work, sources, evidence, reasons, ...(matterReason ? { matterReason } : {}) };
}

export function keepStretch(w: Workspace, activityIDs: string[], input: KeepInput, now: number): TimeEntry {
    prepareImportedKeep(w, activityIDs, now);
    const ids = [...new Set(activityIDs)];
    const picked = ids.map((id) => w.activities.find((a) => a.id === id));
    if (!ids.length || picked.some((a) => !a || a.disposition !== "pending")) throw new WorkspaceError("This activity has already been reviewed.");
    const merged = mergeAdjacent((picked as Activity[]).flatMap((a) => intervals(a)));
    const start = input.startedAt ? ms(input.startedAt) : ms(merged[0].startedAt);
    const end = input.endedAt ? ms(input.endedAt) : ms(merged[merged.length - 1].endedAt);
    if (!(end > start)) throw new WorkspaceError("The end must be after the start.");
    const imported = (picked as Activity[]).some((a) => a.origin);
    let span: { startedAt: string; endedAt: string; sittings?: Interval[] } | null = imported ? (() => { const clipped = clipSittings(merged, start, end); return clipped.length ? { startedAt: clipped[0].startedAt, endedAt: clipped[clipped.length - 1].endedAt, sittings: clipped } : null; })() : stretchSpan(merged, start, end);
    if (!span) throw new WorkspaceError("No captured time falls between those times.");
    let idleLeftOut = 0;
    if (input.leaveOutIdle) {
        const idle = (picked as Activity[]).flatMap((a) => a.idle ?? []);
        if (idle.length) {
            const before = seconds(span as TimeEntry);
            const left = subtractIntervals(intervals(span), idle);
            if (!left.length) throw new WorkspaceError("All of this time was idle. Dismiss it instead.");
            span = { startedAt: left[0].startedAt, endedAt: left[left.length - 1].endedAt, ...(left.length > 1 ? { sittings: left } : {}) };
            idleLeftOut = before - seconds(span as TimeEntry);
        }
    }
    if (input.sittings) {
        const kept = intersectIntervals(intervals(span), input.sittings);
        if (!kept.length) throw new WorkspaceError("No captured time falls inside this reviewed task.");
        span = { startedAt: kept[0].startedAt, endedAt: kept[kept.length - 1].endedAt, sittings: kept };
    }
    const matter = input.matter?.trim().slice(0, MATTER_MAX) || null;
    if (isPersonal(matter)) throw new WorkspaceError("Personal time is not kept. Choose a matter, or dismiss it.");
    const identities = [...new Set((picked as Activity[]).filter((a) => a.matter === matter && a.kiwiProjectID).map((a) => a.kiwiProjectID!))];
    if (identities.length > 1 && !input.projectID) throw new WorkspaceError("Choose one matter; these activities belong to different Kiwi matters.");
    const linked = identities.length === 1 ? w.projects.find((p) => p.kiwiProjectID === identities[0] && p.kiwiAccount === w.feed?.account) : undefined;
    const projectID = input.projectID ?? linked?.id ?? (matter ? projectNamed(w, matter).id : null);
    const chosen = project(w, projectID);
    if (chosen && identities.length === 1 && !input.projectID) {
        if (chosen.kiwiProjectID && chosen.kiwiProjectID !== identities[0]) throw new WorkspaceError("These are different Kiwi matters. Choose the correct matter before keeping.");
        chosen.kiwiProjectID = identities[0]; chosen.kiwiAccount = w.feed?.account;
        const remote = w.feed?.matters.find((m) => m.id === identities[0]);
        if (remote?.cm_number && !chosen.matterNumber) chosen.matterNumber = remote.cm_number;
    }
    // The screenshots inside the kept time stay with the entry; the rest go when their activity does.
    const keptIntervals = intervals(span);
    const shots = (picked as Activity[]).flatMap((a) => a.screenshots ?? []).filter((n) => { const t = screenshotTime(n); return keptIntervals.some((i) => t >= ms(i.startedAt) && t <= ms(i.endedAt)); }).sort((a, b) => screenshotTime(a) - screenshotTime(b));
    const sourceRefs: SourceRef[] = (picked as Activity[]).filter((a) => a.origin).map((a) => ({ kind: a.sourceKind!, id: a.originRef!, account: a.originAccount!, intervals: intersectIntervals(intervals(a), keptIntervals) })).filter((r) => r.intervals.length);
    // Why this entry: the stretches kept, as work, sources and evidence the drafter can cite, and the reasons.
    const why = capturedWhy(picked as Activity[], ms(span.startedAt), ms(span.endedAt), input.drafted, idleLeftOut, keptIntervals, w.meetings?.list);
    const description = input.description.trim();
    const entry: TimeEntry = {
        id: uuid(), description, projectID, ...span,
        billable: input.billable, hourlyRate: input.hourlyRate ?? project(w, projectID)?.hourlyRate ?? 0, source: "desktop", activityID: ids[0],
        ...(ids.length > 1 ? { activityIDs: ids } : {}),
        ...(sourceRefs.length ? { sourceRefs } : {}),
        ...(input.drafted ? { drafted: input.drafted } : {}),
        ...(shots.length ? { screenshots: shots } : {}),
        ...(why.work.length ? { work: why.work, sources: why.sources, reasons: why.reasons, parts: [{ text: description, evidence: why.sources.map((s) => s.id), slot: null }] } : {}),
        ...(why.matterReason ? { matterReason: why.matterReason } : {}),
        ...billingFields(input),
    };
    if (why.sources.length) w.evidence = { ...w.evidence, ...why.evidence };
    saveEntry(w, entry, now);
    for (const a of picked as Activity[]) {
        a.disposition = "kept";
        if (matter) { a.matter = matter; a.matterBy = "person"; }
    }
    return entry;
}

/** The billing details of a keep or an edit, checked: hours in hundredths, codes trimmed and upper case. */
function billingFields(input: { hours?: number; taskCode?: string; activityCode?: string }): Pick<TimeEntry, "hours" | "taskCode" | "activityCode"> {
    const out: Pick<TimeEntry, "hours" | "taskCode" | "activityCode"> = {};
    if (input.hours !== undefined) {
        if (!Number.isFinite(input.hours) || input.hours < 0 || input.hours > 24) throw new WorkspaceError("Enter hours between 0 and 24.");
        out.hours = Math.round(input.hours * 100) / 100;
    }
    const code = (v: string | undefined) => v?.trim().toUpperCase().slice(0, 8) || undefined;
    if (code(input.taskCode)) out.taskCode = code(input.taskCode);
    if (code(input.activityCode)) out.activityCode = code(input.activityCode);
    return out;
}

export type KeepLine = { activityIDs: string[]; input: KeepInput; foldInto?: string | null };

/**
 * Keep several lines at once, all or nothing (the store saves only a mutation that did not
 * throw): a matter's day split into one entry per task (src/shared/rules.ts splitPlan),
 * each line from its own sittings. A line with `foldInto` adds its sittings to an entry
 * already kept (one email entry for the day) instead of making a new one.
 */
export function keepLines(w: Workspace, lines: KeepLine[], now: number): TimeEntry[] {
    if (!lines.length) throw new WorkspaceError("Nothing to keep.");
    const seen = new Set<string>();
    for (const l of lines) for (const id of l.activityIDs) { if (seen.has(id)) throw new WorkspaceError("A sitting can be kept in one entry only."); seen.add(id); }
    return lines.map((l) => (l.foldInto ? foldInto(w, l.foldInto, l.activityIDs, l.input, now) : keepStretch(w, l.activityIDs, l.input, now)));
}

/** Pending sittings join an entry already kept: its span widens to hold them and only the sittings count. */
export function foldInto(w: Workspace, entryID: string, activityIDs: string[], input: Partial<KeepInput>, now: number): TimeEntry {
    const target = w.entries.find((e) => e.id === entryID);
    if (!target) throw new WorkspaceError("That entry no longer exists.");
    if ((input.billable !== undefined && input.billable !== target.billable) || (input.hourlyRate !== undefined && input.hourlyRate !== target.hourlyRate)) throw new WorkspaceError("Keep this time separately: its billable choice or rate differs from the kept entry.");
    // Use the same reviewed bounds, idle removal and import checks as an ordinary keep.
    const addition = keepStretch(w, activityIDs, { ...input, description: input.description?.trim() || target.description, projectID: target.projectID, billable: input.billable ?? target.billable }, now);
    const spans = mergeAdjacent([...intervals(target), ...intervals(addition)]);
    const sources = [...(target.sources ?? []), ...(addition.sources ?? [])];
    const next: TimeEntry = {
        ...target,
        startedAt: spans[0].startedAt, endedAt: spans[spans.length - 1].endedAt,
        sittings: spans,
        activityIDs: [...new Set([target.activityID, ...(target.activityIDs ?? []), ...activityIDs].filter((x): x is string => !!x))],
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        work: [...(target.work ?? []), ...(addition.work ?? [])],
        sources,
        parts: [{ text: input.description?.trim() || target.description, evidence: sources.map((s) => s.id) }],
        screenshots: [...(target.screenshots ?? []), ...(addition.screenshots ?? [])],
        sourceRefs: [...(target.sourceRefs ?? []), ...(addition.sourceRefs ?? [])],
        ...billingFields(input),
    };
    if (spans.length <= 1) delete next.sittings;
    if (next.description !== target.description) delete next.drafted;
    // The temporary addition has never been published or synced; it becomes part of the target.
    w.entries = w.entries.filter((e) => e.id !== addition.id);
    saveEntry(w, next, now);
    return next;
}

/** A redrafted narrative for an entry (src/shared/drafter.ts): the parts and the text they make. */
export function setNarrative(w: Workspace, id: string, parts: NarrativePart[], drafter: DrafterKind, now: number): TimeEntry {
    const e = w.entries.find((x) => x.id === id);
    if (!e) throw new WorkspaceError("That entry no longer exists.");
    const text = parts.map((p) => p.text).join("").trim();
    if (!text) throw new WorkspaceError("The drafter returned no narrative.");
    const next: TimeEntry = { ...e, description: text.slice(0, DRAFT_MAX), parts, drafter, draftedAt: new Date(now).toISOString() };
    delete next.partsEdited;
    delete next.drafted;
    saveEntry(w, next, now);
    return next;
}

export type EntryChange = { description?: string; hours?: number; taskCode?: string; activityCode?: string; billable?: boolean; hourlyRate?: number;
    /** The matter the entry goes to (a flagged entry the person assigns). */
    projectID?: string | null;
    /** The person confirms a suggested or flagged entry as it now stands. */
    confirm?: boolean };

/** Change a kept entry's description, billing details, billable flag or rate (a client rule's fix). Its times stay. */
export function editEntry(w: Workspace, id: string, change: EntryChange, now: number): TimeEntry {
    const e = w.entries.find((x) => x.id === id);
    if (!e) throw new WorkspaceError("That entry no longer exists.");
    const next: TimeEntry = { ...e, ...billingFields(change) };
    // An emptied code field takes the code off the entry.
    if (change.taskCode !== undefined && !change.taskCode.trim()) delete next.taskCode;
    if (change.activityCode !== undefined && !change.activityCode.trim()) delete next.activityCode;
    if (change.description !== undefined) {
        next.description = change.description.trim();
        if (next.description !== e.description) {
            delete next.drafted;
            // The person's own words: what they typed and the sources stay; the parts no longer describe it.
            if (next.parts?.length) next.partsEdited = true;
        }
    }
    if (change.projectID !== undefined) {
        if (change.projectID && !project(w, change.projectID)) throw new WorkspaceError("Choose an existing matter.");
        next.projectID = change.projectID || null;
    }
    // A person's edit or confirmation settles a suggestion; a flagged entry settles once it has a matter and a narrative.
    if (next.status === "suggested" && (change.confirm || next.description !== e.description)) delete next.status;
    if (next.status === "flagged" && change.confirm && next.projectID && next.description.trim()) delete next.status;
    if (!next.status) delete next.why;
    if (change.billable !== undefined) next.billable = change.billable === true;
    if (change.hourlyRate !== undefined) next.hourlyRate = change.hourlyRate;
    saveEntry(w, next, now);
    return next;
}

export const MATTER_MAX = 120;

/**
 * The one reserved matter: the person's own life, not client work (a football pool, the
 * family chat). Named by the model or the person; never kept, never billed, never synced;
 * reviewed apart, to dismiss in one go or send back (2026-10-25, after a pool landed on a
 * legal matter).
 */
export const PERSONAL = "Personal";
export const isPersonal = (matter: string | null | undefined): boolean => !!matter && matter.trim().toLowerCase() === PERSONAL.toLowerCase();

/** The project a matter name stands for: an open one of that name (any case), else a new one. */
export function projectNamed(w: Workspace, name: string): Project {
    const key = name.trim().toLowerCase();
    const matches = w.projects.filter((p) => !p.archived && p.name.trim().toLowerCase() === key);
    if (matches.length > 1) throw new WorkspaceError("More than one matter has this name. Choose its linked matter.");
    const found = matches[0];
    if (found) return found;
    const made: Project = { id: uuid(), name: name.trim(), client: "", color: "gold", hourlyRate: 0, archived: false };
    w.projects.push(made);
    return made;
}

/**
 * Activity named after a matter follows it when the matter is renamed or merged, and the name is the person's
 * from then on: a Kiwi join or the AI never renames what a person named (kept 2026-11-11, after weighing leaving
 * the AI's rows as "ai": a join would then overwrite the name the person typed).
 */
function renameMatter(w: Workspace, from: string, to: string): void {
    const key = from.trim().toLowerCase();
    for (const a of w.activities) if (a.matter && a.matter.toLowerCase() === key) { a.matter = to; a.matterBy = "person"; }
}

/**
 * Change a matter's name, client or rate. The rate applies to time kept from now on:
 * entries keep the rate they were saved with. A new name must not be another open
 * matter's (merge them instead); activity named after the old one follows.
 */
export type ProjectChange = { name?: string; client?: string; hourlyRate?: number; matterNumber?: string; billTo?: string[]; codeSet?: Project["codeSet"] | null };
const CODE_SETS = new Set<unknown>(["project", "counseling", "litigation"]);
/** Lines as typed, trimmed, blanks dropped, each cut to BILLING_LINE_MAX and at most BILLING_LINES_MAX of them. */
export const cleanLines = (lines: readonly string[]): string[] => lines.map((l) => String(l).trim().slice(0, BILLING_LINE_MAX)).filter(Boolean).slice(0, BILLING_LINES_MAX);
const linesValid = (lines: unknown): boolean => lines == null || (Array.isArray(lines) && lines.length <= BILLING_LINES_MAX && lines.every((l) => typeof l === "string" && l.length <= BILLING_LINE_MAX));

export function updateProject(w: Workspace, id: string, change: ProjectChange): void {
    const p = project(w, id);
    if (!p) throw new WorkspaceError("That matter no longer exists.");
    if (change.name !== undefined) {
        const name = change.name.trim().slice(0, MATTER_MAX);
        if (!name) throw new WorkspaceError("Give the matter a name.");
        if (isPersonal(name)) throw new WorkspaceError("Personal is not a matter. Mark time personal with a row's Personal button.");
        if (w.projects.some((x) => x.id !== id && !x.archived && x.name.trim().toLowerCase() === name.toLowerCase())) throw new WorkspaceError(`There is already a matter called “${name}”. Merge them instead.`);
        if (name !== p.name) renameMatter(w, p.name, name);
        p.name = name;
        p.nameBy = "person";
    }
    if (change.client !== undefined) p.client = change.client.trim().slice(0, 200);
    if (change.hourlyRate !== undefined) {
        if (!Number.isFinite(change.hourlyRate) || change.hourlyRate < 0) throw new WorkspaceError("Enter a valid hourly rate.");
        // A rate frozen at save is a rate the person chose. $0 on a billable entry kept before the matter had any
        // rate is no rate at all: the first rate set fills it in, unless the entry is already on an invoice.
        if (p.hourlyRate === 0 && change.hourlyRate > 0) {
            const invoiced = new Set((w.invoices ?? []).flatMap((i) => i.entryIDs));
            for (const e of w.entries) if (e.projectID === id && e.billable && e.hourlyRate === 0 && !invoiced.has(e.id)) e.hourlyRate = change.hourlyRate;
        }
        p.hourlyRate = change.hourlyRate;
    }
    if (change.matterNumber !== undefined) {
        const n = change.matterNumber.trim().slice(0, 60);
        if (n) p.matterNumber = n; else delete p.matterNumber;
    }
    if (change.billTo !== undefined) {
        const lines = cleanLines(change.billTo);
        if (lines.length) p.billTo = lines; else delete p.billTo;
    }
    if (change.codeSet !== undefined) {
        if (change.codeSet != null && !CODE_SETS.has(change.codeSet)) throw new WorkspaceError("That is not a UTBMS code set.");
        if (change.codeSet) p.codeSet = change.codeSet; else delete p.codeSet;
    }
}

/** The firm's billing details, as typed: names and lines trimmed, limits applied; the firm's name is the one thing required. */
export function setBilling(w: Workspace, input: BillingSetup): void {
    const text = (s: unknown, max = BILLING_LINE_MAX): string => (typeof s === "string" ? s.trim().slice(0, max) : "");
    const firm = text(input.firm?.name);
    if (!firm) throw new WorkspaceError("Enter the firm's name.");
    const next = Number(input.nextInvoice);
    const b: BillingSetup = {
        firm: { name: firm, address: cleanLines(input.firm?.address ?? []) },
        timekeeper: { name: text(input.timekeeper?.name), title: text(input.timekeeper?.title) },
        ...(w.billing?.logo ? { logo: w.billing.logo } : {}),
        ...(w.billing?.folder ? { folder: w.billing.folder } : {}),
    };
    for (const k of ["terms", "contact", "footer"] as const) { const v = text(input[k]); if (v) b[k] = v; }
    const remit = cleanLines(input.remit ?? []);
    if (remit.length) b.remit = remit;
    const prefix = text(input.invoicePrefix, 20);
    if (prefix) b.invoicePrefix = prefix;
    if (Number.isInteger(next) && next >= 1 && next <= 9_999_999) b.nextInvoice = next;
    w.billing = b;
}

/** The logo's or the folder's path, kept outside setBilling so a form that saves text never touches a file choice. */
export function setBillingFile(w: Workspace, key: "logo" | "folder", path: string | null): void {
    if (!w.billing) throw new WorkspaceError("Set up billing first: the firm's name, at least.");
    if (path) w.billing[key] = path; else delete w.billing[key];
}

/** "2026-012": the number the next invoice prints, from the prefix and the counter (which starts at 1). */
export function nextInvoiceNumber(w: Workspace): string {
    const b = w.billing;
    return `${b?.invoicePrefix ?? ""}${String(b?.nextInvoice ?? 1).padStart(3, "0")}`;
}

/** An invoice was made under the current number: the counter moves on. */
export function invoiceIssued(w: Workspace): void {
    if (w.billing) w.billing.nextInvoice = (w.billing.nextInvoice ?? 1) + 1;
}

const billingValid = (b: BillingSetup | null | undefined): boolean =>
    b == null || (!!b && typeof b.firm?.name === "string" && b.firm.name.length > 0 && linesValid(b.firm.address) && !!b.timekeeper && typeof b.timekeeper.name === "string" && typeof b.timekeeper.title === "string"
        && linesValid(b.remit) && (b.nextInvoice == null || (Number.isInteger(b.nextInvoice) && b.nextInvoice >= 1)) && (b.logo == null || typeof b.logo === "string") && (b.folder == null || typeof b.folder === "string"));

/**
 * Rename a matter from a review row: its project when it has one (as updateProject, so
 * kept entries follow), else every activity named after it. Personal is not renamed, and
 * nothing is renamed to it.
 */
/**
 * The matter a name already means, as it is spelt: an open project's, else a name on pending
 * activity (a matter still in review). Null when the name is new. Case does not matter.
 */
export function existingMatter(w: Workspace, name: string): string | null {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    const p = w.projects.find((x) => !x.archived && x.name.trim().toLowerCase() === key);
    if (p) return p.name;
    const a = w.activities.find((x) => x.disposition === "pending" && x.matter && x.matter.toLowerCase() === key);
    return a?.matter ?? null;
}

/**
 * Rename a matter from its row or page: the project when there is one, else its activity. A
 * name that is already another matter's merges the two instead (2026-11-06): the kept entries
 * move (`mergeProjects`) and the activity takes the other's name as it is spelt. Returns the
 * matter merged into, or null for a plain rename.
 */
export function renameMatterNamed(w: Workspace, from: string, to: string): string | null {
    const name = to.trim().slice(0, MATTER_MAX);
    if (!name) throw new WorkspaceError("Give the matter a name.");
    if (isPersonal(from)) throw new WorkspaceError("Personal is not renamed. Use “Not personal” on an item instead.");
    const key = from.trim().toLowerCase();
    // Typing "Personal" as a row's matter is the Personal button: its time waiting for review becomes personal.
    // The matter itself, and anything kept on it, stays.
    if (isPersonal(name)) { setMatter(w, w.activities.filter((a) => a.disposition === "pending" && a.matter?.trim().toLowerCase() === key).map((a) => a.id), PERSONAL); return PERSONAL; }
    const p = w.projects.find((x) => !x.archived && x.name.trim().toLowerCase() === key);
    const into = key === name.toLowerCase() ? null : existingMatter(w, name);
    if (into) {
        const target = w.projects.find((x) => !x.archived && x.name.trim().toLowerCase() === into.toLowerCase());
        if (p && target) mergeProjects(w, p.id, target.id);
        else if (p) updateProject(w, p.id, { name: into });
        else renameMatter(w, from, into);
        return into;
    }
    if (p) updateProject(w, p.id, { name });
    else renameMatter(w, from, name);
    return null;
}

/** One matter becomes another: its entries move (times and rates untouched), its activity takes the other's name, and it is gone. */
export function mergeProjects(w: Workspace, fromID: string, intoID: string): void {
    const from = project(w, fromID), into = project(w, intoID);
    if (!from || !into || fromID === intoID) throw new WorkspaceError("Choose two different matters to merge.");
    if (from.kiwiProjectID && into.kiwiProjectID && (from.kiwiProjectID !== into.kiwiProjectID || from.kiwiAccount !== into.kiwiAccount)) throw new WorkspaceError("These are linked to different Kiwi matters. Unlink them before merging.");
    into.aliases = [...new Set([...(into.aliases ?? []), from.name, ...(from.aliases ?? [])])];
    into.kiwiProjectID ??= from.kiwiProjectID; into.kiwiAccount ??= from.kiwiAccount;
    for (const a of w.activities) if (a.projectID === fromID) a.projectID = intoID;
    for (const e of w.entries) if (e.projectID === fromID) e.projectID = intoID;
    if (w.timer?.projectID === fromID) w.timer.projectID = intoID;
    renameMatter(w, from.name, into.name);
    w.projects = w.projects.filter((p) => p.id !== fromID);
}

export function archiveProject(w: Workspace, id: string, archived: boolean): void {
    const p = project(w, id);
    if (!p) throw new WorkspaceError("That matter no longer exists.");
    if (!archived && w.projects.some((x) => x.id !== id && !x.archived && x.name.trim().toLowerCase() === p.name.trim().toLowerCase())) throw new WorkspaceError(`There is already an open matter called “${p.name}”. Merge them instead.`);
    p.archived = archived;
}

/** The person's own description of pending activities, before keeping them; empty clears it. */
export function describeActivities(w: Workspace, ids: string[], text: string): void {
    const given = text.replace(/\s+/g, " ").trim().slice(0, DRAFT_MAX);
    for (const a of w.activities) if (ids.includes(a.id) && a.disposition === "pending") { if (given) a.description = given; else delete a.description; }
}

/** What a row of these activities is called: the person's description, else the AI draft. */
export function descriptionOf(activities: readonly (Pick<Activity, "description" | "draft"> | undefined)[]): { text: string; by: "person" | DraftSource } | null {
    const own = activities.find((a) => a?.description)?.description;
    if (own) return { text: own, by: "person" };
    const draft = activities.find((a) => a?.draft)?.draft;
    return draft ? { text: draft.text, by: draft.source } : null;
}

/** New time this soon after a kept entry, on the same work, is offered to merge into it. */
export const MERGE_WINDOW_MS = 24 * 3_600_000;

const workKey = (a: Activity): string => `${a.ownerID}\n${a.document?.name ?? a.title ?? ""}`;

/**
 * The kept entry a review row looks like more of: kept from desktop activity (so its time
 * can go back to review), ended at most MERGE_WINDOW_MS before the row starts, and on the
 * same matter — or, for a row without one, the same document or title in the same app.
 * Never one the person kept separate, and never for a row already merged. The latest wins.
 */
export function keptMatch(w: Workspace, activityIDs: readonly string[]): TimeEntry | null {
    const rows = activityIDs.map((id) => w.activities.find((a) => a.id === id)).filter((a): a is Activity => !!a && a.disposition === "pending");
    if (!rows.length || rows.some((a) => a.mergeKey) || rows.some((a) => isPersonal(a.matter))) return null;
    const start = Math.min(...rows.map((a) => ms(a.startedAt)));
    const declined = new Set(rows.flatMap((a) => a.separateFrom ?? []));
    const matter = rows.find((a) => a.matter)?.matter?.trim().toLowerCase() ?? null;
    const keys = new Set(rows.map(workKey));
    const candidates = w.entries.filter((e) => {
        if (e.source !== "desktop" || declined.has(e.id) || ms(e.endedAt) > start || start - ms(e.endedAt) > MERGE_WINDOW_MS) return false;
        const from = [e.activityID, ...(e.activityIDs ?? [])].filter((id): id is string => !!id).map((id) => w.activities.find((a) => a.id === id));
        if (!from.length || from.some((a) => !a || a.disposition !== "kept")) return false;
        const name = project(w, e.projectID)?.name.trim().toLowerCase() ?? null;
        return matter ? name === matter : (from as Activity[]).some((a) => keys.has(workKey(a)));
    });
    return candidates.sort((x, y) => ms(y.endedAt) - ms(x.endedAt))[0] ?? null;
}

/**
 * Merge new time into a kept entry: the entry is deleted (Kiwi and the CRM are told), its
 * sittings go back to review with the new ones as one row, carrying its matter and
 * description, to be kept again.
 */
export function mergeIntoEntry(w: Workspace, activityIDs: readonly string[], entryID: string): void {
    const entry = w.entries.find((e) => e.id === entryID);
    if (!entry || entry.source !== "desktop") throw new WorkspaceError("That entry is no longer there to merge into.");
    const fresh = w.activities.filter((a) => activityIDs.includes(a.id) && a.disposition === "pending");
    if (!fresh.length) throw new WorkspaceError("This activity has already been reviewed.");
    const matter = project(w, entry.projectID)?.name ?? null;
    const from = new Set([entry.activityID, ...(entry.activityIDs ?? [])]);
    const original = w.activities.filter((a) => from.has(a.id)).sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
    if (!original.length || original.some((a) => a.disposition !== "kept")) throw new WorkspaceError("The kept activity is no longer available to merge.");
    deleteEntry(w, entryID);
    // Reopen only the time the person actually kept, including any manually extended outer bounds.
    for (const [n, a] of original.entries()) {
        const source = intervals(a).map((i) => ({ ...i }));
        if (n === 0 && ms(entry.startedAt) < ms(a.startedAt)) source.unshift({ startedAt: entry.startedAt, endedAt: a.startedAt });
        if (n === original.length - 1 && ms(entry.endedAt) > ms(a.endedAt)) source.push({ startedAt: a.endedAt, endedAt: entry.endedAt });
        const kept = intersectIntervals(source, intervals(entry));
        if (!kept.length) { a.disposition = "dismissed"; continue; }
        a.startedAt = kept[0].startedAt;
        a.endedAt = kept[kept.length - 1].endedAt;
        a.sittings = kept;
        if (a.idle) a.idle = intersectIntervals(a.idle, kept);
        if (a.screenshots) a.screenshots = a.screenshots.filter((s) => (entry.screenshots ?? []).includes(s));
    }
    for (const a of w.activities) {
        if (!(from.has(a.id) || activityIDs.includes(a.id)) || a.disposition !== "pending") continue;
        a.mergeKey = entryID;
        a.description = entry.description.slice(0, DRAFT_MAX);
        if (matter) { a.matter = matter; a.matterBy = "person"; }
    }
}

/** The person says this time is not more of that entry. */
export function keepSeparate(w: Workspace, activityIDs: readonly string[], entryID: string): void {
    for (const a of w.activities) if (activityIDs.includes(a.id) && a.disposition === "pending" && !(a.separateFrom ?? []).includes(entryID)) a.separateFrom = [...(a.separateFrom ?? []), entryID].slice(-20);
}

/** The person names (or clears) the matter of pending activities. */
export function setMatter(w: Workspace, ids: string[], matter: string | null): void {
    const given = matter?.trim().slice(0, MATTER_MAX) || null;
    const name = isPersonal(given) ? PERSONAL : given;
    for (const a of w.activities) if (ids.includes(a.id) && a.disposition === "pending") { a.matter = name; a.matterBy = "person"; delete a.kiwiProjectID; delete a.projectID; }
}

export function keepActivity(w: Workspace, id: string, input: KeepInput, now: number): TimeEntry {
    return keepStretch(w, [id], input, now);
}

export function dismissActivity(w: Workspace, id: string): void {
    dismissActivities(w, [id]);
}

export function dismissActivities(w: Workspace, ids: string[]): void {
    // A dismissed activity's screenshots go with it: nothing refers to them any more, so the files are deleted.
    for (const a of w.activities) if (ids.includes(a.id) && a.disposition === "pending") { a.disposition = "dismissed"; delete a.screenshots; }
}

/** Removes an entry, reopens the activity it came from, and remembers the deletion for Kiwi. */
export function deleteEntry(w: Workspace, id: string): void {
    const entry = w.entries.find((e) => e.id === id);
    if (!entry) return;
    w.entries = w.entries.filter((e) => e.id !== id);
    const from = new Set([entry.activityID, ...(entry.activityIDs ?? [])]);
    for (const a of w.activities) if (from.has(a.id)) a.disposition = "pending";
    // The evidence capture made for it goes with it; keeping the activity again makes it anew.
    if (w.evidence) for (const a of from) if (a && w.evidence[a] && (entry.sources ?? []).some((s) => s.id === a)) { delete w.evidence[a]; delete w.evidence[`${a}:transcript`]; }
    for (const t of w.sync?.targets ?? []) if (!t.deletedEntryIDs.includes(id)) t.deletedEntryIDs.push(id);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** `call`: a call is going on (in front or behind), so no input is not idle. */
export type Observation = { app: string; ownerID: string; title: string | null; document?: DocumentInfo | null; screenText?: string | null; isSelf?: boolean; call?: boolean } | null;

export const SCREEN_TEXT_MAX = 600;

/** On-screen text as stored: personal details redacted, one line per piece, repeats and blank lines dropped, bounded. */
export function cleanScreenText(raw: string | null | undefined): string | null {
    const lines: string[] = [];
    for (const line of (raw ?? "").replace(/\r\n?/g, "\n").split("\n")) {
        const t = redact(line.replace(/\s+/g, " ").trim());
        if (t && !lines.includes(t)) lines.push(t);
    }
    const text = lines.join("\n").slice(0, SCREEN_TEXT_MAX).trim();
    return text || null;
}

/** What a screen-text reader printed (src/main/screenText.ts): TEXT=… over any number of lines, or UNTRUSTED when macOS has not granted Accessibility. */
export function parseScreenText(output: string): { text: string | null; untrusted: boolean } {
    const text = output.replace(/\r\n?/g, "\n");
    if (/^UNTRUSTED\s*$/m.test(text)) return { text: null, untrusted: true };
    const at = text.indexOf("TEXT=");
    return { text: at < 0 ? null : cleanScreenText(text.slice(at + 5)), untrusted: false };
}

// ---------------------------------------------------------------------------
// Redaction: personal details are removed on this computer, before anything is stored
// ---------------------------------------------------------------------------

const luhn = (digits: string): boolean => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
    }
    return sum % 10 === 0;
};

/**
 * Text read from a window or a document with personal details taken out: card numbers
 * (Luhn-checked), anything labelled as a card code, password, PIN, token or account,
 * social security numbers, phone numbers, long digit runs, and the person part of email
 * addresses (the domain stays: it often names the client). Case numbers ("1:26-cv-01182"),
 * matter numbers ("2026-144"), dates and amounts are kept, since they name the work.
 */
export function redact(text: string): string {
    return text
        // Labelled secrets; the label stays so a reader knows something was there. A card
        // code needs its 3–4 digits, the rest a ":" or "=" ("pin the memo" is not a PIN).
        .replace(/\b(cvc|cvv2?|cid|security code|card code)(\s*[:#=-]?\s*)\d{3,4}\b/gi, "$1$2[redacted]")
        .replace(/\b(pin|passcode|password|passwd|pwd|api key|secret|token|account (?:number|no\.?|#)|acct(?: no\.?| #)?|routing(?: number| no\.?)?|iban|sort code)(\s*[:#=]\s*)\S+/gi, "$1$2[redacted]")
        // Card numbers: 13–19 digits, spaced or dashed, that pass the Luhn check.
        .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[card]" : m))
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
        // Bare runs of eleven or more digits (account, policy, reference numbers); ten is a phone.
        .replace(/\b\d{11,}\b/g, "[number]")
        // Phone numbers: ten or more digits written as one ((555) 123-4567, +1 555 123 4567).
        .replace(/(?<![\w:/-])\+?\(?\d[\d ().-]{8,}\d(?![\w-])/g, (m) => (m.replace(/\D/g, "").length >= 10 && !/^\d{4}-\d{2}-\d{2}/.test(m) ? "[phone]" : m))
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
        .replace(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, "[email]@$1");
}

/** A document as stored: bounded, whitespace collapsed, empty fields null. */
export function cleanDocument(raw: DocumentInfo | null | undefined): DocumentInfo | null {
    if (!raw) return null;
    const name = raw.name?.trim().slice(0, 300);
    if (!name) return null;
    const path = raw.path?.trim().slice(0, 1000) || null;
    const excerpt = raw.excerpt ? redact(raw.excerpt.replace(/\s+/g, " ").trim()).slice(0, EXCERPT_MAX) || null : null;
    return { name, path, excerpt };
}

const sameDocument = (a: DocumentInfo | null | undefined, b: DocumentInfo | null | undefined) =>
    (a?.name ?? null) === (b?.name ?? null) && (a?.path ?? null) === (b?.path ?? null);

/** One sample of the foreground. Bounds are wall-clock timestamps; no interval spans an unobserved gap. */
export function observe(w: Workspace, foreground: Observation, now: number, idleSeconds: number, suspended = false): void {
    // The login window in front is the lock screen (after a wake, before the password): never work.
    if (suspended || (foreground && isLockScreen(foreground.ownerID))) {
        closeActivity(w, now, "suspended");
        stopTimer(w, now, "timer-suspended");
        return;
    }
    // Capture counts the window in front for as long as it is in front, input or not:
    // reading a contract or sitting in a call is work (2026-10-22, after a call captured
    // as seconds). Sleep and the lock screen still end it. Only the timer, which a person
    // started and forgot, stops at the last input.
    if (w.timer && idleSeconds >= w.preferences.idleMinutes * 60) stopTimer(w, now - idleSeconds * 1000, "timer-idle");
    if (w.timer) {
        if (now - ms(w.timer.lastHeartbeat) > GAP_SECONDS * 1000) stopTimer(w, ms(w.timer.lastHeartbeat), "timer-recovered");
        else w.timer.lastHeartbeat = iso(now);
    }
    if (!w.preferences.captureEnabled || !foreground) {
        closeActivity(w, now, "paused");
        return;
    }
    // Switching to this app is a switch like any other; only a private app is "excluded".
    if (foreground.isSelf || foreground.ownerID === APP_ID) {
        closeActivity(w, now, "switched", foreground.app);
        return;
    }
    if (isExcluded(w.preferences, foreground.ownerID)) {
        // A browser on the private list is still a browser: its name is all that is ever said of it, so the
        // row says "went to Google Chrome" rather than "opened a private app" (2026-11-04, after it confused the beta user).
        if (isBrowser(foreground.ownerID)) closeActivity(w, now, "browser", foreground.app); else closeActivity(w, now, "excluded");
        return;
    }
    // Checked before anything about the window is used, as an exclusion is.
    if (isBrowser(foreground.ownerID)) {
        // The browser's name only: nothing inside it is read (the extension has the pages).
        closeActivity(w, now, "browser", foreground.app);
        return;
    }
    const safeTitle = w.preferences.captureTitles ? foreground.title : null;
    const document = w.preferences.captureDocuments ? cleanDocument(foreground.document) : null;
    const screenText = w.preferences.captureScreenText ? cleanScreenText(foreground.screenText) : null;
    const current = w.currentActivity;
    if (current) {
        const lastSeen = ms(current.endedAt);
        if (now - lastSeen > GAP_SECONDS * 1000 || now < lastSeen) closeActivity(w, lastSeen, "gap");
        // A blank title ("", titles on) in the same app is the OS not saying, not a new
        // window: Finder flickered "Downloads" → "" → "Downloads" every sample and cut a
        // minute into 5-second pieces (2026-10-23). Titles off (null) is not blank.
        else if (current.ownerID !== foreground.ownerID || (current.title !== safeTitle && current.title !== "" && safeTitle !== "")) closeActivity(w, now, "switched", foreground.app);
        // A different document in the same app is different work. A segment that only now
        // learns its document keeps going, and a probe that failed this once (null) does not
        // end a segment that already knows its document.
        else if (document && current.document && !sameDocument(current.document, document)) closeActivity(w, now, "switched", foreground.app);
    }
    if (!w.currentActivity) {
        w.currentActivity = { id: uuid(), app: foreground.app, ownerID: foreground.ownerID, title: safeTitle, document, ...(screenText ? { screenText } : {}), startedAt: iso(now), endedAt: iso(now), endedBy: "switched", disposition: "pending" };
    } else {
        w.currentActivity.endedAt = iso(now);
        if (safeTitle && w.currentActivity.title === "") w.currentActivity.title = safeTitle;
        if (document) w.currentActivity.document = document;
        // The first text read stands for the segment: scrolling is not other work.
        if (screenText && !w.currentActivity.screenText) w.currentActivity.screenText = screenText;
    }
    if (!foreground.call && idleSeconds >= IDLE_FLAG_SECONDS) flagIdle(w.currentActivity, now - idleSeconds * 1000, now);
}

/** No input since `from`: one idle span per stretch without input, inside the segment. */
function flagIdle(a: Activity, from: number, now: number): void {
    const start = iso(Math.max(from, ms(a.startedAt)));
    if (!(now > ms(start))) return;
    const list = (a.idle ??= []);
    const last = list[list.length - 1];
    // The same quiet stretch, sampled again: it began at the same last input.
    if (last && Math.abs(ms(last.startedAt) - ms(start)) < 2_000) last.endedAt = iso(now);
    else list.push({ startedAt: start, endedAt: iso(now) });
}

// ---------------------------------------------------------------------------
// Screenshots: opt-in, on this computer only (src/main/screenshots.ts takes and serves them)
// ---------------------------------------------------------------------------

/** The first screenshot of a segment once it has lasted this long (a glance gets none), then one every SCREENSHOT_EVERY_MS. */
export const SCREENSHOT_SETTLE_MS = 20_000;
export const SCREENSHOT_EVERY_MS = 5 * 60_000;
/** At most this many per segment (over four hours at one every five minutes). */
export const SCREENSHOTS_MAX = 48;
/** "<activity id>-<epoch ms>.jpg": no dots or slashes in the id, so a name is never a path. */
const SHOT_NAME = /^[A-Za-z0-9-]{1,64}-\d{13}\.jpg$/;
export const isScreenshotName = (name: unknown): name is string => typeof name === "string" && SHOT_NAME.test(name);
export const screenshotTime = (name: string): number => Number(name.slice(-17, -4));
const shotsValid = (shots: unknown, max: number): boolean => shots == null || (Array.isArray(shots) && shots.length <= max && shots.every(isScreenshotName));

/** The file name of the screenshot to take now of the segment in progress, or null when none is due. Call after observe(). */
export function screenshotDue(w: Workspace, now: number): string | null {
    const a = w.currentActivity;
    if (!w.preferences.captureEnabled || !w.preferences.captureScreenshots || !a || a.origin) return null;
    const shots = a.screenshots ?? [];
    if (shots.length >= SCREENSHOTS_MAX) return null;
    const due = shots.length ? screenshotTime(shots[shots.length - 1]) + SCREENSHOT_EVERY_MS : ms(a.startedAt) + SCREENSHOT_SETTLE_MS;
    return now >= due ? `${a.id}-${now}.jpg` : null;
}

/** Attach a screenshot just taken to its segment: still in progress, or closed and still waiting for review. False when it is gone (the file is then collected). */
export function addScreenshot(w: Workspace, name: string): boolean {
    if (!isScreenshotName(name)) return false;
    const id = name.slice(0, -18);
    const a = w.currentActivity?.id === id ? w.currentActivity : w.activities.find((x) => x.id === id && x.disposition === "pending");
    if (!a || (a.screenshots ?? []).length >= SCREENSHOTS_MAX) return false;
    a.screenshots = [...(a.screenshots ?? []), name];
    return true;
}

/** Every screenshot something still shows; any other file in the folder is deleted. */
/**
 * Which screenshot files collect() may delete: not referenced, past the grace period for one just taken, and
 * not from before `protectBefore` (set when a workspace was started fresh beside existing screenshots: a missing
 * or replaced workspace file must never cost the screenshots of the one it replaced). With nothing referenced at
 * all, nothing is deleted: an empty workspace beside files is a sign something is wrong, not a cleanup.
 */
export function screenshotsToDelete(files: readonly { name: string; mtimeMs: number }[], keep: ReadonlySet<string>, now: number, graceMs: number, protectBefore: number | null = null): string[] {
    if (keep.size === 0) return [];
    return files.filter((f) => isScreenshotName(f.name) && !keep.has(f.name) && now - f.mtimeMs > graceMs && (protectBefore === null || f.mtimeMs >= protectBefore)).map((f) => f.name);
}

export function referencedScreenshots(w: Workspace): Set<string> {
    const names = new Set<string>();
    for (const a of [...w.activities, ...(w.currentActivity ? [w.currentActivity] : [])]) for (const n of a.screenshots ?? []) names.add(n);
    for (const e of w.entries) for (const n of e.screenshots ?? []) names.add(n);
    return names;
}

/** How a sitting ended, in words. */
const ENDED_BY: Record<string, string> = {
    switched: "switched apps", idle: "went idle", suspended: "the computer slept", gap: "lost track", paused: "paused capture",
    quit: "quit the app", excluded: "opened a private app", browser: "went to the browser", "privacy-change": "changed privacy settings", "crash-recovered": "the app went down", calendar: "on your calendar, not on this computer",
};

/** The site of the browser time (brought in from Kiwi) that began as this ended, if any. */
export function siteAfter(activities: readonly Activity[], endedAt: string): string | null {
    const end = ms(endedAt);
    const next = activities.filter((a) => a.origin === "browser" && a.url && ms(a.startedAt) >= end - 10_000 && ms(a.startedAt) <= end + 120_000)
        .sort((x, y) => Math.abs(ms(x.startedAt) - end) - Math.abs(ms(y.startedAt) - end))[0];
    if (!next?.url) return null;
    try { return new URL(next.url).hostname.replace(/^www\./, "") || null; } catch { return null; }
}

/** "switched to Outlook", "went to Chrome · courtlistener.com": where the time went next, as far as it is known. */
export function endedText(a: { endedBy?: string; endedTo?: string; endedAt: string }, activities: readonly Activity[] = []): string {
    const by = a.endedBy;
    if (!by) return "";
    if (by === "switched" && a.endedTo) return `switched to ${a.endedTo}`;
    if (by === "browser") {
        const site = siteAfter(activities, a.endedAt);
        return `went to ${a.endedTo ?? "the browser"}${site ? ` · ${site}` : ""}`;
    }
    return ENDED_BY[by] ?? by;
}

export function closeActivity(w: Workspace, at: number, reason: string, to?: string): void {
    const current = w.currentActivity;
    if (!current) return;
    w.currentActivity = null;
    const end = Math.max(ms(current.startedAt), Math.min(at, ms(current.endedAt) + 15_000));
    // A title that stayed blank is no title, as stored and as sent.
    const idle = current.idle?.map((i) => ({ startedAt: i.startedAt, endedAt: iso(Math.min(ms(i.endedAt), end)) })).filter((i) => ms(i.endedAt) > ms(i.startedAt));
    const closed: Activity = { ...current, title: current.title || null, endedAt: iso(end), endedBy: reason, ...(to ? { endedTo: to.slice(0, 200) } : {}) };
    if (idle?.length) closed.idle = idle; else delete closed.idle;
    if (seconds(closed) >= MIN_ACTIVITY_SECONDS) w.activities.push(closed);
}

/** After a crash: the timer ends at its last heartbeat, the segment at its last observation. Never across the downtime. */
export function recover(w: Workspace, now: number): void {
    if (w.timer) stopTimer(w, ms(w.timer.lastHeartbeat), "timer-recovered");
    if (w.currentActivity) closeActivity(w, ms(w.currentActivity.endedAt), "crash-recovered");
    prune(w, now);
}

/** Screenshots kept with an entry go this long after the entry's work (2026-11-11): about as long as a bill is in question. */
export const KEPT_SCREENSHOT_DAYS = 90;

export function prune(w: Workspace, now: number): void {
    const cutoff = now - w.preferences.retentionDays * 86_400_000;
    w.activities = w.activities.filter((a) => ms(a.endedAt) >= cutoff);
    const shotCutoff = now - KEPT_SCREENSHOT_DAYS * 86_400_000;
    for (const e of w.entries) if (e.screenshots?.length && ms(e.endedAt) < shotCutoff) delete e.screenshots;
}

/** Seconds of kept time inside [start, end), clipped. */
export function secondsBetween(w: Workspace, start: number, end: number, billableOnly = false): number {
    return w.entries.filter((e) => !billableOnly || e.billable).reduce((sum, e) => sum + secondsWithin(e, start, end), 0);
}

// ---------------------------------------------------------------------------
// Stretches: how the inbox groups sittings for review
// ---------------------------------------------------------------------------

/** Sittings on the same document at most this far apart are one stretch. */
export const STRETCH_GAP_MS = 15 * 60_000;
/** A stretch shorter than this is an app hop, not work; it is offered only in bulk. */
export const NOISE_SECONDS = 60;

export type Stretch = {
    /** The first sitting's id; stable while the stretch is pending. */
    id: string;
    app: string;
    ownerID: string;
    /** The document, else the window title, else the app. */
    name: string;
    document: DocumentInfo | null;
    activityIDs: string[];
    startedAt: string;
    endedAt: string;
    /** Only the sittings' time. */
    seconds: number;
    sittings: number;
    endedBy: string;
    /** The app its last sitting switched to. */
    endedTo?: string;
    /** The first AI draft among its sittings. */
    draft: Draft | null;
};

const stretchKey = (a: Activity): string => a.meeting ? `meeting:${a.meeting.id}` : `${a.ownerID}\n${isMail(a.ownerID) ? "" : a.document?.name ?? a.title ?? ""}`;
const localDayOf = (isoText: string): string => { const d = new Date(isoText); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/**
 * Pending activities as stretches: consecutive sittings in the same app on the same
 * document (or title; any message, in a mail app), on the same day, with gaps under STRETCH_GAP_MS, become one — even
 * with other documents' sittings in between, which is how real work goes. Stretches under
 * NOISE_SECONDS are returned apart, to be dismissed in one go. Newest first.
 */
export function stretchesOf(activities: readonly Activity[], gapMs = STRETCH_GAP_MS, noiseSeconds = NOISE_SECONDS): { stretches: Stretch[]; short: Stretch[] } {
    const pending = activities.filter((a) => a.disposition === "pending").sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
    const open = new Map<string, Stretch>();
    const all: Stretch[] = [];
    for (const a of pending) {
        const key = a.mergeKey ? `merge:${a.mergeKey}` : stretchKey(a);
        const last = open.get(key);
        if (last && (a.mergeKey || (ms(a.startedAt) - ms(last.endedAt) <= gapMs && localDayOf(a.startedAt) === localDayOf(last.startedAt)))) {
            last.activityIDs.push(a.id);
            last.endedAt = a.endedAt;
            last.seconds += seconds(a);
            last.sittings += 1;
            last.endedBy = a.endedBy;
            last.endedTo = a.endedTo;
            last.draft ??= a.draft ?? null;
            continue;
        }
        const mail = isMail(a.ownerID);
        const fresh: Stretch = { id: a.id, app: a.app, ownerID: a.ownerID, name: a.meeting?.subject ?? (mail ? a.app : a.document?.name ?? a.title ?? a.app), document: mail ? null : a.document ?? null, activityIDs: [a.id], startedAt: a.startedAt, endedAt: a.endedAt, seconds: seconds(a), sittings: 1, endedBy: a.endedBy, ...(a.endedTo ? { endedTo: a.endedTo } : {}), draft: a.draft ?? null };
        open.set(key, fresh);
        all.push(fresh);
    }
    all.sort((x, y) => ms(y.startedAt) - ms(x.startedAt));
    return { stretches: all.filter((st) => st.seconds >= noiseSeconds), short: all.filter((st) => st.seconds < noiseSeconds) };
}

// ---------------------------------------------------------------------------
// Kiwi sync — the wire contract (kiwi/backend/src/lib/desktopTime.ts is the other half)
// ---------------------------------------------------------------------------

export const SYNC_MAX_ITEMS = 500;

/** The machine's IANA zone, or null where Intl cannot say. */
export function localTimeZone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

export type SyncRequest = {
    app_version: string;
    /** This computer's IANA zone, so Kiwi dates drafts made from kept entries on the day they happened. */
    time_zone: string | null;
    import_workspace_id?: string;
    activities: { id: string; app: string; bundle_id: string; title: string | null; document_name: string | null; document_path: string | null; excerpt: string | null; started_at: string; ended_at: string; seconds: number; ended_by: string; disposition: string }[];
    entries: { kiwi_project_id?: string; source_refs?: { kind: string; id: string; intervals: Interval[] }[]; id: string; description: string; project_name: string | null; client_name: string | null; started_at: string; ended_at: string; seconds: number; billable: boolean; hourly_rate: number; source: string; activity_id: string | null }[];
    deleted_entry_ids: string[];
};

/** Everything a destination should know: closed segments within retention (personal ones never), every kept entry, the deletions it has not acknowledged. */
/** An entry the destinations hear about: no status, or a draft (what an invoice also bills). */
export const syncableEntry = (e: Pick<TimeEntry, "status">): boolean => !e.status || e.status === "draft";

export function syncRequest(w: Workspace, appVersion: string, timeZone: string | null = localTimeZone(), target: SyncTarget | null = w.sync?.targets[0] ?? null): SyncRequest {
    return {
        app_version: appVersion,
        ...(w.feed ? { import_workspace_id: w.feed.workspaceID } : {}),
        time_zone: timeZone,
        activities: w.activities.filter((a) => !a.origin && !isPersonal(a.matter)).map((a) => ({ id: a.id, app: a.app, bundle_id: a.ownerID, title: a.title, document_name: a.document?.name ?? null, document_path: a.document?.path ?? null, excerpt: a.document?.excerpt ?? null, started_at: a.startedAt, ended_at: a.endedAt, seconds: Math.round(seconds(a)), ended_by: a.endedBy, disposition: a.disposition })),
        // Only settled entries: a suggestion not yet confirmed, an entry a client sent back and not yet fixed, or a
        // dismissed one is not time to bill. One sent earlier stays as it was there until it is settled again.
        entries: w.entries.filter(syncableEntry).map((e) => {
            const p = project(w, e.projectID);
            return { ...(p?.kiwiProjectID && p.kiwiAccount === w.feed?.account && target?.product === "kiwi" ? { kiwi_project_id: p.kiwiProjectID } : {}), ...(e.sourceRefs?.length && target?.product === "kiwi" ? { source_refs: e.sourceRefs.map(({ kind, id, intervals }) => ({ kind, id, intervals })) } : {}), id: e.id, description: e.description, project_name: p?.name ?? null, client_name: p?.client || null, started_at: e.startedAt, ended_at: e.endedAt, seconds: Math.round(seconds(e)), billable: e.billable, hourly_rate: e.hourlyRate, source: e.source, activity_id: e.activityID };
        }),
        deleted_entry_ids: target?.deletedEntryIDs ?? [],
    };
}

/** Deletions a product had not acknowledged when this computer connects again (a new token, the same product): they still go. */
export function carriedDeletions(sync: SyncState | null, product: Product): string[] {
    return [...(sync?.targets.find((t) => t.product === product)?.deletedEntryIDs ?? [])];
}

/** Requests Kiwi will accept, in order; deletions travel with the first. */
export function syncBatches(request: SyncRequest, maxItems = SYNC_MAX_ITEMS): SyncRequest[] {
    const count = Math.max(1, Math.ceil(Math.max(request.activities.length, request.entries.length, request.deleted_entry_ids.length) / maxItems));
    return Array.from({ length: count }, (_, i) => ({
        app_version: request.app_version,
        // Every batch names the workspace: Kiwi refuses an imported entry without it.
        ...(request.import_workspace_id ? { import_workspace_id: request.import_workspace_id } : {}),
        time_zone: request.time_zone,
        activities: request.activities.slice(i * maxItems, (i + 1) * maxItems),
        entries: request.entries.slice(i * maxItems, (i + 1) * maxItems),
        deleted_entry_ids: request.deleted_entry_ids.slice(i * maxItems, (i + 1) * maxItems),
    }));
}

/** One product answered: its outbox shrinks by what it acknowledged. Without `product`, every target. */
export function markSynced(w: Workspace, at: number, acknowledgedDeletions: string[], product: Product | null = null): void {
    for (const t of w.sync?.targets ?? []) {
        if (product && t.product !== product) continue;
        t.deletedEntryIDs = t.deletedEntryIDs.filter((id) => !acknowledgedDeletions.includes(id));
        t.lastSyncedAt = iso(at);
        t.lastError = null;
    }
}

/** The 0.4.x shape (one product, flat) or the current one, as the current one; anything else as given. */
export function normalizeSync(raw: unknown): SyncState | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.targets)) return r as unknown as SyncState;
    const target: SyncTarget = {
        product: isProduct(r.destination) ? r.destination : "kiwi",
        serverURL: String(r.serverURL ?? ""),
        deviceID: String(r.deviceID ?? ""),
        deviceName: String(r.deviceName ?? ""),
        accountEmail: (r.accountEmail as string | undefined) ?? null,
        lastSyncedAt: (r.lastSyncedAt as string | undefined) ?? null,
        lastError: (r.lastError as string | undefined) ?? null,
        deletedEntryIDs: Array.isArray(r.deletedEntryIDs) ? (r.deletedEntryIDs as string[]) : [],
    };
    return { targets: [target], autoSync: r.autoSync !== false };
}

// ---------------------------------------------------------------------------
// Files: validation and the migration from the Swift app's format
// ---------------------------------------------------------------------------

const DISPOSITIONS = new Set(["pending", "kept", "dismissed"]);
const validIso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

const narrativeValid = (e: TimeEntry): boolean =>
    (e.raw == null || typeof e.raw === "string") && (e.why == null || typeof e.why === "string") &&
    (e.seen == null || (typeof e.seen.app === "string" && typeof e.seen.title === "string")) &&
    (e.tasks == null || (Array.isArray(e.tasks) && e.tasks.every((t) => !!t && typeof t.text === "string"))) &&
    (e.typed == null || (typeof e.typed === "object" && typeof e.typed.note === "string" && typeof e.typed.rowID === "string" && Number.isFinite(e.typed.hours))) &&
    (e.work == null || (Array.isArray(e.work) && e.work.every((x) => x && typeof x.app === "string" && typeof x.title === "string" && validIso(x.startedAt) && Number.isFinite(x.minutes)))) &&
    (e.reasons == null || (Array.isArray(e.reasons) && e.reasons.every((x) => typeof x === "string"))) &&
    (e.group == null || typeof e.group === "string") && (e.groupLabel == null || typeof e.groupLabel === "string") && (e.draftedAt == null || validIso(e.draftedAt)) &&
    (e.status == null || ENTRY_STATUSES.has(e.status)) &&
    (e.parts == null || (Array.isArray(e.parts) && e.parts.every((p) => p && typeof p.text === "string" && Array.isArray(p.evidence) && p.evidence.every((id) => typeof id === "string")))) &&
    (e.sources == null || (Array.isArray(e.sources) && e.sources.every((x) => x && typeof x.id === "string" && typeof x.kind === "string" && typeof x.label === "string")));

/** Throws on anything that would make the engine misbehave; a corrupt file is preserved, never repaired. */
export function validate(w: Workspace): Workspace {
    const p = w.preferences;
    validateFeedState(w);
    const ok =
        w.schemaVersion === SCHEMA_VERSION &&
        w.entries.every(narrativeValid) &&
        (w.evidence == null || (typeof w.evidence === "object" && !Array.isArray(w.evidence) && Object.entries(w.evidence).every(([k, v]) => !!v && typeof v === "object" && v.id === k && typeof v.kind === "string"))) &&
        (w.clientRules == null || rulesValid(w.clientRules.rules)) &&
        (w.clientRulebooks == null || (Array.isArray(w.clientRulebooks) && w.clientRulebooks.every((b) => !!b && typeof b.key === "string" && typeof b.client === "string" && rulesValid(b.rules)))) &&
        (w.billingClient == null || typeof w.billingClient === "string") &&
        (w.imported == null || (Array.isArray(w.imported) && new Set(w.imported.map((r) => r?.id)).size === w.imported.length && w.imported.every((r) => !!r && typeof r.id === "string" && typeof r.description === "string" && Number.isFinite(r.hours)
            && (r.origin == null || r.origin === "import" || r.origin === "manual") && (r.prior == null || typeof r.prior === "object")))) &&
        (w.privateStretches == null || (Array.isArray(w.privateStretches) && w.privateStretches.every((x) => !!x && validIso(x.startedAt) && validIso(x.endedAt)))) &&
        Array.isArray(w.projects) && Array.isArray(w.entries) && Array.isArray(w.activities) &&
        p && p.idleMinutes >= 1 && p.idleMinutes <= 60 && p.retentionDays >= 1 && p.retentionDays <= 365 && Array.isArray(p.excludedOwnerIDs) && (p.textSize == null || (TEXT_SIZES as readonly number[]).includes(p.textSize)) && (p.crashReports == null || typeof p.crashReports === "boolean") && (p.importMeetings == null || typeof p.importMeetings === "boolean") && (p.meetingTranscripts == null || typeof p.meetingTranscripts === "boolean") && meetingsValid(w) && (p.onboardedAt == null || validIso(p.onboardedAt)) && (p.seenRelease == null || (typeof p.seenRelease === "string" && p.seenRelease.length <= 32)) &&
        new Set(w.entries.map((e) => e.id)).size === w.entries.length &&
        new Set(w.projects.map((x) => x.id)).size === w.projects.length &&
        new Set(w.activities.map((a) => a.id)).size === w.activities.length &&
        w.projects.every((x) => Number.isFinite(x.hourlyRate) && x.hourlyRate >= 0 && insightValid(x.insight) && linesValid(x.billTo) && (x.codeSet == null || CODE_SETS.has(x.codeSet))) &&
        billingValid(w.billing) && invoicesValid(w.invoices) &&
        w.entries.every((e) => validIso(e.startedAt) && validIso(e.endedAt) && ms(e.endedAt) > ms(e.startedAt) && Number.isFinite(e.hourlyRate) && e.hourlyRate >= 0 && (e.sittings == null || (Array.isArray(e.sittings) && sittingsValid(e))) && (e.activityIDs == null || Array.isArray(e.activityIDs)) && (e.drafted == null || DRAFT_SOURCES.has(e.drafted)) && shotsValid(e.screenshots, SCREENSHOTS_MAX * 20) && (e.hours == null || (Number.isFinite(e.hours) && e.hours >= 0 && e.hours <= 24))) &&
        (w.rulebooks == null || (Array.isArray(w.rulebooks) && w.rulebooks.every((r) => r && typeof r.clientId === "string" && Array.isArray(r.rules)))) &&
        w.activities.every((a) => validIso(a.startedAt) && validIso(a.endedAt) && ms(a.endedAt) >= ms(a.startedAt) && DISPOSITIONS.has(a.disposition) && (a.matter == null || (typeof a.matter === "string" && a.matter.length <= MATTER_MAX)) && (a.matterBy == null || a.matterBy === "ai" || a.matterBy === "person") && draftValid(a.draft) && summaryValid(a.summary) && (a.mergeKey == null || typeof a.mergeKey === "string") && (a.separateFrom == null || (Array.isArray(a.separateFrom) && a.separateFrom.length <= 20)) && (a.description == null || (typeof a.description === "string" && a.description.length <= DRAFT_MAX)) && (a.screenText == null || (typeof a.screenText === "string" && a.screenText.length <= SCREEN_TEXT_MAX)) && shotsValid(a.screenshots, SCREENSHOTS_MAX) && (a.endedTo == null || typeof a.endedTo === "string") && (a.idle == null || (Array.isArray(a.idle) && a.idle.every((i) => validIso(i.startedAt) && validIso(i.endedAt)))) && (a.document == null || (typeof a.document.name === "string" && a.document.name.length > 0 && (a.document.excerpt ?? "").length <= EXCERPT_MAX))) &&
        (!w.timer || (validIso(w.timer.startedAt) && validIso(w.timer.lastHeartbeat) && ms(w.timer.lastHeartbeat) >= ms(w.timer.startedAt))) &&
        (!w.sync || (Array.isArray(w.sync.targets) && w.sync.targets.length > 0 && new Set(w.sync.targets.map((t) => t.product)).size === w.sync.targets.length &&
            w.sync.targets.every((t) => isProduct(t.product) && typeof t.serverURL === "string" && t.serverURL.length > 0 && typeof t.deviceID === "string" && t.deviceID.length > 0 && Array.isArray(t.deletedEntryIDs))));
    if (!ok) throw new WorkspaceError("The workspace contains invalid data. Restore a known-good backup.");
    return w;
}

/** Foundation's Codable dates: seconds since 2001-01-01 UTC. */
const REFERENCE_EPOCH_MS = 978_307_200_000;
const fromReference = (n: unknown): string => iso(REFERENCE_EPOCH_MS + Number(n) * 1000);

/** A workspace.json written by the Swift app (schemaVersion 1) as this app reads it. */
export function migrateV1(raw: Record<string, unknown>): Workspace {
    type Any = Record<string, unknown>;
    const arr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);
    const prefs = (raw.preferences ?? {}) as Any;
    const timer = raw.timer as Any | undefined;
    const current = raw.currentActivity as Any | undefined;
    const sync = raw.sync as Any | undefined;
    const activity = (a: Any): Activity => ({ id: String(a.id), app: String(a.app ?? ""), ownerID: String(a.bundleID ?? ""), title: (a.title as string | undefined) ?? null, startedAt: fromReference(a.startedAt), endedAt: fromReference(a.endedAt), endedBy: String(a.endedBy ?? "switched"), disposition: (a.disposition as Activity["disposition"]) ?? "pending" });
    return {
        schemaVersion: SCHEMA_VERSION,
        projects: arr(raw.projects).map((p) => ({ id: String(p.id), name: String(p.name ?? ""), client: String(p.client ?? ""), color: String(p.color ?? "gold"), hourlyRate: Number(p.hourlyRate ?? 0), archived: p.archived === true })),
        entries: arr(raw.entries).map((e) => ({ id: String(e.id), description: String(e.description ?? ""), projectID: (e.projectID as string | undefined) ?? null, startedAt: fromReference(e.startedAt), endedAt: fromReference(e.endedAt), billable: e.billable === true, hourlyRate: Number(e.hourlyRate ?? 0), source: String(e.source ?? "manual"), activityID: (e.activityID as string | undefined) ?? null })),
        activities: arr(raw.activities).map(activity),
        timer: timer ? { description: String(timer.description ?? ""), projectID: (timer.projectID as string | undefined) ?? null, startedAt: fromReference(timer.startedAt), lastHeartbeat: fromReference(timer.lastHeartbeat), billable: timer.billable === true, hourlyRate: Number(timer.hourlyRate ?? 0) } : null,
        currentActivity: current ? activity(current) : null,
        preferences: { captureEnabled: prefs.captureEnabled === true, captureTitles: prefs.captureTitles === true, captureDocuments: false, captureScreenText: false, suggestMatters: false, idleMinutes: Number(prefs.idleMinutes ?? 3), retentionDays: Number(prefs.retentionDays ?? 14), excludedOwnerIDs: Array.isArray(prefs.excludedBundleIDs) ? (prefs.excludedBundleIDs as string[]) : [...DEFAULT_EXCLUSIONS] },
        sync: sync ? normalizeSync({ serverURL: sync.serverURL, deviceID: sync.deviceID, deviceName: sync.deviceName, accountEmail: sync.accountEmail ?? null, autoSync: sync.autoSync !== false, lastSyncedAt: sync.lastSyncedAt != null ? fromReference(sync.lastSyncedAt) : null, lastError: sync.lastError ?? null, deletedEntryIDs: sync.deletedEntryIDs }) : null,
    };
}

/** Parse a workspace file's JSON, whichever app wrote it. */
export function parseWorkspace(text: string): Workspace {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.schemaVersion === 1) return validate(migrateV1(raw));
    if (!READS_VERSIONS.has(raw.schemaVersion)) throw new WorkspaceError("This workspace was created by a newer Time Capture version. Update Time Capture before opening it.");
    const w = raw as unknown as Workspace;
    // Version 2 holds nothing version 3 reads differently: it is written back as 3.
    w.schemaVersion = SCHEMA_VERSION;
    w.preferences = { ...defaultPreferences(), ...(w.preferences ?? {}) };
    w.sync = normalizeSync(w.sync);
    w.timer ??= null;
    w.currentActivity ??= null;
    return validate(w);
}

/**
 * Whether to run the window lookup that needs Screen Recording on macOS. Its check raises
 * macOS's prompt whenever it fails, so it runs when the permission is granted, and
 * otherwise once a run (macOS reports only granted or denied, never "not asked yet", so
 * the first attempt is what raises the prompt and puts the app in System Settings).
 */
export function screenRecordingAttempt(status: string, askedThisRun: boolean): boolean {
    return status === "granted" || !askedThisRun;
}
