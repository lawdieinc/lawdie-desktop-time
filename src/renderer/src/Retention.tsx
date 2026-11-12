/* Unreviewed time waits until it is reviewed (2026-11-12): the warnings shown a week (PENDING_WARN_DAYS) before
   pending time reaches its cap (pendingDays, 90 days or the retention setting when longer), and the words for how
   long each kind of activity stays. The rule is `prune()` and `pendingExpiring()` in model.ts; nothing here decides
   anything. A demo workspace runs on its seeded day and never warns. */

import type { ReactNode } from "react";
import { pendingDays, pendingExpiring, type Workspace } from "@shared/model";
import { dayLabel } from "@shared/format";
import { billedHours, hr, incrementOf } from "@shared/billingMode";

/** Passed on so App.tsx takes everything about retention from one line. */
export { pendingDays };

const expiring = (w: Workspace, now: number) => (w.demo ? null : pendingExpiring(w, now));
const longDate = (iso: string): string => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
const shortDate = (iso: string): string => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/** On Activity: what is about to go, when, and a way to the oldest of it. */
export function ExpiringCallout({ w, now, onShowOldest }: { w: Workspace; now: number; onShowOldest: () => void }): ReactNode {
    const e = expiring(w, now);
    if (!e) return null;
    const from = dayLabel(e.from, new Date(now)), to = dayLabel(e.to, new Date(now));
    return (
        <section className="callout danger" role="status">
            <div className="grow">
                <p className="callout-title">Unreviewed time from {from === to ? from : `${from} to ${to}`} will be removed</p>
                <p className="muted">{hr(billedHours(e.seconds, incrementOf(w.preferences)))} you have not kept or dismissed is nearly {pendingDays(w.preferences)} days old. The first of it is removed on {longDate(e.removeAt)}. Keep it or dismiss it before then.</p>
            </div>
            <button type="button" className="quiet" title="List the oldest time first so you can review it before it is removed." onClick={onShowOldest}>Show the oldest</button>
        </section>
    );
}

/** In the sidebar's capture card: one line that opens Activity. */
export function ExpiringSidebar({ w, now, onOpen }: { w: Workspace; now: number; onOpen: () => void }): ReactNode {
    const e = expiring(w, now);
    if (!e) return null;
    return <button type="button" className="link danger small strong" style={{ color: "var(--danger)" }} title="Open Activity to review time before it is removed." onClick={onOpen}>{hr(billedHours(e.seconds, incrementOf(w.preferences)))} unreviewed goes {shortDate(e.removeAt)}</button>;
}

/** Beside the Activity count: how long what is listed stays. */
export function retentionLabel(w: Workspace, filter: "pending" | "kept" | "dismissed" | "all"): { text: string; tip: string } {
    return filter === "pending"
        ? { text: `unreviewed time waits ${pendingDays(w.preferences)} days`, tip: "Time you have not reviewed is never removed before then; you are warned a week ahead." }
        : { text: `reviewed activity kept ${w.preferences.retentionDays} days`, tip: "Sittings you kept or dismissed are removed this long after you review them. Your time entries stay." };
}
