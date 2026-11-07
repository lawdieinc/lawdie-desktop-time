/**
 * Errors from this app go to Honeybadger (project "Time Capture Desktop"), the way Kiwi's do
 * (2026-11-06). One client, in the main process; the window forwards its errors here over
 * IPC and never talks to the network itself. The rules are pure in
 * `src/shared/errorReport.ts`: scrubbed messages, frames only, an allow-listed context, ten
 * notices a group an hour. Nothing on the person's screen is ever in a report.
 *
 * No key (dev, tests, the screenshot harness, demo runs) means nothing is sent; nor is
 * anything sent by an unpackaged build, or when the person switches crash reports off.
 * A notice that cannot be sent (offline) waits in `errors.jsonl` beside the workspace's
 * user data and is retried every few minutes.
 */

import Honeybadger from "@honeybadger-io/js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { release } from "node:os";
import { join } from "node:path";
import { MAX_PER_GROUP_HOUR, QUEUE_MAX, asError, cleanNotice, createGroupBudget, fingerprintOf, parseQueue, scrubText, type QueuedNotice } from "@shared/errorReport";

/** The key baked in at build time (electron.vite.config.ts `define`); empty outside a release build. */
declare const __HONEYBADGER_API_KEY__: string;

const RETRY_EVERY_MS = 5 * 60_000;
/** Notices this run at most, whatever the groups; a runaway bug stops here. */
const MAX_PER_RUN = 50;

type Setup = {
    version: string;
    packaged: boolean;
    userData: string;
    /** The person's switch (Settings → Display & data); off means report nothing. */
    enabled: () => boolean;
    /** The switches that are on, for the context (`featuresOn`). */
    features: () => string;
};

let setup: Setup | null = null;
let configured = false;
let installID = "";
let sentThisRun = 0;
const withinBudget = createGroupBudget(MAX_PER_GROUP_HOUR);
const pending = new Set<Promise<unknown>>();
let retryTimer: ReturnType<typeof setInterval> | null = null;

const queuePath = (): string => join(setup!.userData, "errors.jsonl");

/** A per-install random id, so one machine's reports can be counted together. Never the device token. */
function installIdentity(userData: string): string {
    const file = join(userData, "install-id");
    try {
        if (existsSync(file)) { const id = readFileSync(file, "utf8").trim(); if (/^[0-9a-f-]{36}$/.test(id)) return id; }
        const id = randomUUID();
        writeFileSync(file, id);
        return id;
    } catch { return "unknown"; }
}

/** Configure once at launch. Without a key this is a no-op and `report` only logs. */
export function startErrorReports(s: Setup): void {
    setup = s;
    const apiKey = typeof __HONEYBADGER_API_KEY__ === "string" ? __HONEYBADGER_API_KEY__.trim() : "";
    if (!apiKey) return;
    installID = installIdentity(s.userData);
    Honeybadger.configure({
        apiKey,
        environment: s.packaged ? "production" : "development",
        revision: s.version,
        // Our own handlers below: the SDK's would exit the process, which Electron does not do today.
        enableUncaught: false,
        enableUnhandledRejection: false,
        breadcrumbsEnabled: false,
        maxErrors: MAX_PER_RUN,
        // Nothing about this machine beyond what the context allows.
        hostname: "desktop",
        projectRoot: "",
        // HONEYBADGER_DEBUG=1 logs each send and its notice id, for proving a key.
        ...(process.env.HONEYBADGER_DEBUG === "1" ? { debug: true, logger: console } : {}),
        // A local endpoint for proving what a notice carries (scripts in AGENTS.md); unset in a release.
        ...(process.env.HONEYBADGER_ENDPOINT ? { endpoint: process.env.HONEYBADGER_ENDPOINT } : {}),
    });
    Honeybadger.beforeNotify((notice) => { if (notice) cleanNotice(notice as Parameters<typeof cleanNotice>[0]); });
    // The SDK's Node transport drops a custom endpoint's port, so the proving endpoint above goes through fetch.
    if (process.env.HONEYBADGER_ENDPOINT) {
        type Send = (o: { endpoint: string; method: string; headers: Record<string, string> }, p: unknown) => Promise<{ statusCode: number; body: string }>;
        (Honeybadger as unknown as { __transport: { send: Send } }).__transport = { send: async (o, p) => {
            const res = await fetch(o.endpoint, { method: o.method, headers: { "content-type": "application/json", ...o.headers }, body: JSON.stringify(p) });
            return { statusCode: res.status, body: await res.text() };
        } };
    }
    configured = true;
    process.on("uncaughtException", (err) => report("process", err, { reason: "uncaughtException" }));
    process.on("unhandledRejection", (err) => report("process", err, { reason: "unhandledRejection" }));
    retryTimer = setInterval(() => void retryQueued(), RETRY_EVERY_MS);
    void retryQueued();
}

function contextFor(scope: string, extra: Record<string, string> = {}): Record<string, string> {
    return { source: "desktop", scope, version: setup?.version ?? "", platform: `${process.platform} ${release()}`, features: setup?.features() ?? "", install: installID, ...extra };
}

/**
 * Report an error caught somewhere in the app. Always logs; sends when configured, packaged,
 * switched on, and within the hourly budget for this error's group. Never throws.
 */
export function report(scope: string, error: unknown, extra: Record<string, string> = {}): void {
    const err = asError(error);
    console.warn(`[${scope}]`, err.message);
    if (!configured || !setup || !setup.packaged || !setup.enabled()) return;
    if (!withinBudget(fingerprintOf(scope, err))) return;
    if (sentThisRun >= MAX_PER_RUN) return;
    sentThisRun += 1;
    const context = contextFor(scope, extra);
    send(err, scope, context).catch(() => enqueue({ at: new Date().toISOString(), scope, name: err.name, message: scrubText(err.message), stack: err.stack, context }));
}

function send(err: Error, scope: string, context: Record<string, string>): Promise<unknown> {
    const sent = Honeybadger.notifyAsync(err, { component: scope, context });
    pending.add(sent);
    void sent.catch(() => undefined).finally(() => pending.delete(sent));
    return sent;
}

function enqueue(q: QueuedNotice): void {
    try {
        const kept = existsSync(queuePath()) ? parseQueue(readFileSync(queuePath(), "utf8")) : [];
        writeFileSync(queuePath(), [...kept, q].slice(-QUEUE_MAX).map((x) => JSON.stringify(x)).join("\n") + "\n");
    } catch { /* best effort */ }
}

/** Sends what waited while offline; what still fails stays for next time. */
async function retryQueued(): Promise<void> {
    if (!configured || !setup || !setup.enabled() || !existsSync(queuePath())) return;
    let queued: QueuedNotice[];
    try { queued = parseQueue(readFileSync(queuePath(), "utf8")); } catch { return; }
    if (!queued.length) return;
    const left: QueuedNotice[] = [];
    for (const q of queued) {
        const err = new Error(q.message);
        err.name = q.name;
        if (q.stack) err.stack = q.stack;
        try { await send(err, q.scope, { ...(q.context as Record<string, string>), reason: `queued ${q.at}` }); } catch { left.push(q); }
    }
    try { if (left.length) writeFileSync(queuePath(), left.map((x) => JSON.stringify(x)).join("\n") + "\n"); else writeFileSync(queuePath(), ""); } catch { /* best effort */ }
}

/** Waits (briefly) for notices still being sent, at quit. */
export async function flushErrorReports(): Promise<void> {
    if (retryTimer) clearInterval(retryTimer);
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 1500))]);
}

/** The window's errors arrive here through the preload's `reportError`; the strings are capped, nothing else is trusted. */
export function reportFromWindow(payload: unknown): void {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const err = new Error(typeof p.message === "string" ? p.message.slice(0, 1000) : "Error in the window");
    if (typeof p.name === "string") err.name = p.name.slice(0, 80);
    err.stack = typeof p.stack === "string" ? p.stack.slice(0, 4000) : undefined;
    report(`window/${typeof p.scope === "string" ? p.scope.slice(0, 40) : "error"}`, err);
}

/** For tests and the harness: log only, send nothing. */
export const errorReportsConfigured = (): boolean => configured;
