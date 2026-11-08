/**
 * Error reports to Honeybadger, the rules (2026-11-06, after Kiwi's
 * backend/src/lib/observability/honeybadger.ts and opsTelemetry.ts): what a notice may say,
 * how many go out, and how one error is told from another. Pure; `src/main/errors.ts` holds
 * the client. A report never carries what was on the person's screen: no titles, document
 * names, paths, excerpts, screen text, matter names, descriptions, emails or tokens. Every
 * message is scrubbed, the stack keeps only its frames, and the context is an allow-list.
 */

/** Characters of a message kept. */
export const SCRUB_MAX = 500;
/** Causes followed below an error. */
const CAUSE_DEPTH = 3;
/** Notices per error group per hour; nothing past this is sent. */
export const MAX_PER_GROUP_HOUR = 10;
/** Context keys a notice may carry; anything else is dropped. */
export const CONTEXT_KEYS = ["source", "scope", "version", "platform", "features", "install", "reason"] as const;

/**
 * A message with anything that could name a person or a file taken out: secrets, emails,
 * ids, long hex, numbers of three digits or more, and the home folder (a desktop app's
 * messages are full of paths such as /Users/jane/Documents/…).
 */
export function scrubText(text: string, max = SCRUB_MAX): string {
    return text
        .replace(/\b(?:sk|pk|hbp|phc|rk)_[A-Za-z0-9_-]{8,}/g, "[redacted]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
        .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
        .replace(/(?:\/Users|\/home)\/[^/\s]+/g, "~")
        .replace(/[A-Za-z]:\\Users\\[^\\]+/g, "~")
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
        .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
        .replace(/\d{3,}/g, "<n>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

/** Only the "at …" lines of a stack: its first line repeats the unscrubbed message. */
export function framesOf(stack: string | undefined): string | undefined {
    if (typeof stack !== "string") return undefined;
    const frames = stack.split("\n").filter((l) => l.trim().startsWith("at ")).map((l) => scrubText(l, 300));
    return frames.length ? frames.join("\n") : undefined;
}

/** The first frame with its path cut to the file's name, so one bug keeps one group across releases. */
export function firstFrame(stack: string | undefined): string | null {
    const line = framesOf(stack)?.split("\n")[0];
    if (!line) return null;
    return line.trim().replace(/\(?([^\s(]*[\\/])?([^\\/\s:)]+)(:[\d<>n]+:[\d<>n]+)?\)?$/, (_m, _dir, file: string) => file).slice(0, 160);
}

export type ScrubbedCause = { name: string; message: string; stack?: string; cause?: ScrubbedCause };

/** The cause chain as plain objects with scrubbed messages, at most CAUSE_DEPTH deep. */
export function scrubCauses(error: unknown): ScrubbedCause | undefined {
    const seen = new Set<unknown>();
    const chain: ScrubbedCause[] = [];
    let current = (error as { cause?: unknown } | null)?.cause;
    while (current && typeof current === "object" && chain.length < CAUSE_DEPTH && !seen.has(current)) {
        seen.add(current);
        const record = current as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown };
        chain.push({
            name: typeof record.name === "string" ? record.name.slice(0, 80) : "Error",
            message: scrubText(typeof record.message === "string" ? record.message : ""),
            stack: framesOf(typeof record.stack === "string" ? record.stack : undefined),
        });
        current = record.cause;
    }
    for (let i = chain.length - 2; i >= 0; i--) chain[i].cause = chain[i + 1];
    return chain[0];
}

/** What one error group is: where it was caught, what it is called, where it broke, what it said. */
export function fingerprintOf(scope: string, error: { name?: string; message?: string; stack?: string }): string {
    return [scope, error.name ?? "Error", firstFrame(error.stack) ?? "", scrubText(error.message ?? "", 120)].join("\n");
}

/** Notices per group in the current hour: the first `max` go out, the rest are counted nowhere. */
export function createGroupBudget(max: number, now: () => number = Date.now): (fingerprint: string) => boolean {
    let hour = -1;
    const sent = new Map<string, number>();
    return (fingerprint) => {
        const current = Math.floor(now() / 3_600_000);
        if (current !== hour) { hour = current; sent.clear(); }
        const count = sent.get(fingerprint) ?? 0;
        if (count >= max) return false;
        sent.set(fingerprint, count + 1);
        return true;
    };
}

/** The shape of a notice this touches; the client's own type has more. */
export type NoticeLike = {
    message?: string;
    stack?: string;
    cause?: unknown;
    originalError?: unknown;
    details?: unknown;
    context?: Record<string, unknown>;
    params?: unknown;
    session?: unknown;
    headers?: unknown;
    cookies?: unknown;
    cgiData?: unknown;
    url?: unknown;
    /** The SDK's parsed frames, built before beforeNotify runs: their file paths need the same scrub. */
    backtrace?: { file?: string; method?: string; number?: number; column?: number; source?: unknown }[];
};

/** Everything a notice may carry, in place: the scrubbed message and frames, the causes, the allowed context. Nothing else. */
export function cleanNotice(notice: NoticeLike): void {
    notice.message = scrubText(notice.message ?? "");
    notice.stack = framesOf(notice.stack);
    notice.cause = scrubCauses(notice.originalError ?? notice);
    notice.details = {};
    const context = notice.context ?? {};
    // The install id is ours and random, so it stays; every other string is scrubbed like a message.
    notice.context = Object.fromEntries(CONTEXT_KEYS.filter((k) => k in context).map((k) => [k, typeof context[k] === "string" && k !== "install" ? scrubText(context[k] as string, 200) : context[k]]));
    if (Array.isArray(notice.backtrace)) notice.backtrace = notice.backtrace.map((f) => ({ ...f, file: typeof f.file === "string" ? scrubText(f.file, 300) : f.file, source: undefined }));
    notice.params = {};
    notice.session = {};
    notice.headers = {};
    notice.cookies = {};
    notice.cgiData = {};
    notice.url = undefined;
}

/** The switches that are on, named: which features were running says a lot about where a bug lives. */
export function featuresOn(p: { captureEnabled?: boolean; captureTitles?: boolean; captureDocuments?: boolean; captureScreenText?: boolean; captureScreenshots?: boolean; suggestMatters?: boolean; importKiwiTime?: boolean; importMeetings?: boolean; meetingTranscripts?: boolean }, targets: readonly string[] = []): string {
    const on = [
        p.captureEnabled && "capture", p.captureTitles && "titles", p.captureDocuments && "documents", p.captureScreenText && "screenText",
        p.captureScreenshots && "screenshots", p.suggestMatters && "ai", p.importKiwiTime && "kiwiTime", p.importMeetings && "meetings", p.meetingTranscripts && "transcripts", ...targets.map((t) => `sync:${t}`),
    ].filter((x): x is string => !!x);
    return on.join(",") || "none";
}

/** An error as the client wants it, whatever was thrown. */
export function asError(value: unknown): Error {
    if (value instanceof Error) return value;
    return new Error(typeof value === "string" ? value : "Non-Error value thrown");
}

/** A queued notice, as written to disk when sending failed (offline), to be sent later. */
export type QueuedNotice = { at: string; scope: string; name: string; message: string; stack?: string; context: Record<string, unknown> };
/** Queued notices kept at most; older ones are dropped. */
export const QUEUE_MAX = 50;

/** Reads the queue file's lines, tolerating a torn last line. */
export function parseQueue(text: string): QueuedNotice[] {
    const out: QueuedNotice[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const q = JSON.parse(line) as QueuedNotice;
            if (q && typeof q.scope === "string" && typeof q.message === "string") out.push(q);
        } catch { /* a torn line */ }
    }
    return out.slice(-QUEUE_MAX);
}
