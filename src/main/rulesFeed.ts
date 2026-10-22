/* Client billing rules, flowing back from the billing system, and the demo console.

   `--rules-feed <url or file>` names one JSON document (src/shared/demo.ts has its shape):
   the rule sets the billing system exports, plus, for a demo, an epoch and a stage. The
   app reads it every few seconds; a rule set that changed replaces the client's old one
   and the window says what is new. `--demo <seed.json>` makes the workspace a demo built
   from that seed: a new epoch in the feed resets it, a stage adds or removes a day.

   A feed that cannot be read is retried quietly and logged beside the workspace; the
   window never shows an error for it. */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFeed, parseSeed, seedWorkspace, type Feed, type Seed } from "@shared/demo";
import type { Workspace } from "@shared/model";
import type { Store } from "./store";

const POLL_MS = 2_000;

export class RulesFeed {
    private timer: NodeJS.Timeout | null = null;
    private last = "";
    readonly seed: Seed | null;

    constructor(private readonly store: Store, private readonly source: string | null, seedPath: string | null, private readonly logDir: string) {
        this.seed = seedPath ? parseSeed(readFileSync(seedPath, "utf8")) : null;
        // A seed replaces the workspace it is given: never a real one with time in it.
        const w = store.workspace;
        if (this.seed && !w.demo && (w.entries.length || w.projects.length || w.activities.length)) {
            throw new Error("This workspace holds real time, so the demo seed was not loaded. Run the demo with its own --workspace and LAWDIE_USER_DATA.");
        }
    }

    start(): void {
        // With no feed, a demo opens on its seeded day at once; with one, the first read seeds it at the feed's epoch.
        const seed = this.seed;
        if (!this.source) {
            if (seed && this.store.workspace.demo?.seed !== seed.seed) this.store.change((w) => replace(w, seedWorkspace(seed, 0, Date.now())));
            return;
        }
        void this.poll();
        this.timer = setInterval(() => void this.poll(), POLL_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }

    private async read(): Promise<string> {
        const src = this.source as string;
        if (/^https?:\/\//.test(src)) {
            const res = await fetch(src, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        }
        return readFileSync(src.replace(/^file:\/\//, ""), "utf8");
    }

    async poll(): Promise<void> {
        let text: string;
        try { text = await this.read(); } catch (err) { this.log(err); return; }
        if (text === this.last) return;
        let feed: Feed;
        try { feed = JSON.parse(text) as Feed; } catch (err) { this.log(err); return; }
        let notice: string | null = null;
        const ok = this.store.change((w) => {
            const r = applyFeed(w, this.seed, { epoch: Number(feed.epoch) || 0, stage: String(feed.stage ?? "day"), rulebooks: Array.isArray(feed.rulebooks) ? feed.rulebooks : [] }, Date.now());
            if (r.workspace !== w) replace(w, r.workspace);
            notice = r.notice;
        });
        if (ok) {
            this.last = text;
            if (notice) this.store.say(notice);
        } else {
            // A feed the workspace refused is not an error the person can act on: log it and keep the old state.
            this.log(new Error(this.store.error ?? "refused"));
            this.store.clearError();
        }
    }

    private log(err: unknown): void {
        try { appendFileSync(join(this.logDir, "rules-feed.log"), `${new Date().toISOString()} ${err instanceof Error ? err.message : String(err)}\n`); } catch { /* best effort */ }
    }
}

/** Swap the workspace being changed for another, in place (store.change works on the object it handed out). */
function replace(w: Workspace, next: Workspace): void {
    for (const key of Object.keys(w)) delete (w as Record<string, unknown>)[key];
    Object.assign(w, next);
}
