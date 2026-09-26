/** "45s", "12m", "1h 05m", or a clock "01:05:09". */
export function duration(secs: number, clock = false): string {
    const total = Math.max(0, Math.floor(secs));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (clock) return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
    if (total < 60) return `${total}s`;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function dayLabel(iso: string, now = new Date()): string {
    const d = new Date(iso);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (same(d, now)) return "Today";
    if (same(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function ago(iso: string | null, now = Date.now()): string {
    if (!iso) return "never";
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
