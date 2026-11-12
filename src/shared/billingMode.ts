/* The billing mode (2026-11-12): hours are billed, and shown, in tenths of an hour (6 minutes) or in quarter hours
   (15 minutes), the person's choice in Settings → Billing (`preferences.billingMode`, absent = tenths). Pure.
   A lawyer bills in the increment, so the screens show work in it too, never minutes and seconds (sittings inside a
   row keep their minutes: they are evidence, not what is billed). Time is always rounded up, never under one
   increment. A client's own increment rule wins over the mode for that client (`incrementFor`). The hours are fixed
   at keep (`KeepInput.hours`), so changing the mode never changes an entry already kept; an entry kept before the
   mode existed has no stored hours and stays in tenths, as it was billed (`entryHours`). A total is the sum of its
   entries' hours, so a screen adds up to the bill. */

import { seconds, secondsWithin, type Preferences, type TimeEntry } from "./model";
import type { RuleSet } from "./rules";

export type BillingMode = "tenths" | "quarters";
export const BILLING_MODES: Record<BillingMode, { label: string; increment: number; unit: string }> = {
    tenths: { label: "Tenths of an hour (6 min)", increment: 0.1, unit: "tenth of an hour" },
    quarters: { label: "Quarter hours (15 min)", increment: 0.25, unit: "quarter hour" },
};

export const billingModeOf = (p: Pick<Preferences, "billingMode">): BillingMode => (p.billingMode === "quarters" ? "quarters" : "tenths");
export const incrementOf = (p: Pick<Preferences, "billingMode">): number => BILLING_MODES[billingModeOf(p)].increment;

/** The increment a matter's time is billed in: the client's own rule when its rulebook has one, else the mode. */
export function incrementFor(p: Pick<Preferences, "billingMode">, book: RuleSet | null | undefined): number {
    const rule = book?.rules.find((r) => r.check === "time_increment");
    const own = rule ? Number(rule.params?.incr ?? 0.1) : NaN;
    return Number.isFinite(own) && own > 0 ? own : incrementOf(p);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Hours rounded up to the increment. */
export const roundUpTo = (hours: number, increment: number): number => round2(Math.ceil(hours / increment - 1e-6) * increment);
/** Captured time as it is billed: rounded up to the increment, never under one. */
export const billedHours = (secs: number, increment = 0.1): number => Math.max(increment, roundUpTo(secs / 3600, increment));

/** "1.3", "0.25", "2.0": one decimal, two when the hundredths count. */
export const hoursText = (hours: number): string => hours.toFixed(Math.round(hours * 100) % 10 ? 2 : 1);
/** "1.3 hr". */
export const hr = (hours: number): string => `${hoursText(hours)} hr`;

/** A kept entry's billed hours: the hours it was kept with; one kept before hours were stored is in tenths, as it was billed. */
export const entryHours = (e: TimeEntry): number => e.hours ?? billedHours(seconds(e), 0.1);
/** The part of an entry's hours inside [start, end): all of them unless the entry crosses the range's edge. */
export function hoursWithin(e: TimeEntry, start: number, end: number): number {
    const all = seconds(e), within = secondsWithin(e, start, end);
    return all > 0 && within < all ? round2((entryHours(e) * within) / all) : within > 0 ? entryHours(e) : 0;
}
export const sumHours = (entries: readonly TimeEntry[], start = 0, end = Infinity): number => round2(entries.reduce((n, e) => n + hoursWithin(e, start, end), 0));
