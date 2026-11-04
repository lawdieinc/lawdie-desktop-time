/** "45s", "1m 50s" (seconds count under ten minutes), "12m", "1h 05m", or a clock "01:05:09". */
export function duration(secs: number, clock = false): string {
    const total = Math.max(0, Math.floor(secs));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (clock) return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
    if (total < 60) return `${total}s`;
    if (total < 600) return s ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** One sitting is a range; several are "between" their first and last, since their time is less than the span. */
export const spanLabel = (start: string, end: string, sittings: number) => (sittings > 1 ? `between ${clock(start)} and ${clock(end)}` : `${clock(start)}–${clock(end)}`);

export function dayLabel(iso: string, now = new Date()): string {
    const d = new Date(iso);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (same(d, now)) return "Today";
    if (same(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** "09:05": a time as an <input type="time"> shows it, in local time. */
export const timeValue = (isoText: string): string => { const d = new Date(isoText); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** "HH:MM" on the local day of `dayIso`; a day later when that is not after `notBefore`. */
export function onDay(dayIso: string, hhmm: string, notBefore: number | null = null): number {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(dayIso); d.setHours(h, m, 0, 0);
    if (notBefore !== null && d.getTime() <= notBefore) d.setDate(d.getDate() + 1);
    return d.getTime();
}

/**
 * The span the Keep sheet keeps. Untouched, the captured bounds exactly (to the second,
 * and across days: a row merged with a kept entry can run past midnight); edited, the start
 * on the start's day and the end on the end's day, a day later if it would not be after the start.
 */
export function keepBounds(span: { startedAt: string; endedAt: string }, startText: string, endText: string): { start: number; end: number; changed: boolean } {
    const changed = startText !== timeValue(span.startedAt) || endText !== timeValue(span.endedAt);
    if (!changed) return { start: Date.parse(span.startedAt), end: Date.parse(span.endedAt), changed };
    const start = onDay(span.startedAt, startText);
    return { start, end: onDay(span.endedAt, endText, start), changed };
}

export function ago(iso: string | null, now = Date.now()): string {
    if (!iso) return "never";
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
