/* AI suggestions, main-process side: requests to Kiwi, which asks its own server-side
   model. In order: name the matter of new activity, draft a billing description for each
   row waiting in review, and refresh the insight of each matter whose time changed. Off
   until the person switches on "AI suggestions", and only while this computer is
   connected to Kiwi: the device token it already syncs with is the only credential, so
   no one enters a key. What is sent and how answers are applied is src/shared/matters.ts. */

import { KiwiClient, KiwiFailure, PRODUCTS } from "@shared/kiwi";
import { applyDrafts, applyInsights, applyMatters, draftRequest, insightRequest, matterRequest } from "@shared/matters";
import type { Store } from "./store";
import type { TokenFile } from "./sync";

/** In the background, every half hour; opening Activity asks sooner, at most every ten minutes. */
export const SUGGEST_EVERY_MS = 30 * 60_000;
export const SUGGEST_ON_OPEN_MS = 10 * 60_000;

export class Matters {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private lastRun = 0;
    /** Rows and matters asked this session and not answered, so they are not asked every round. */
    private unansweredRows = new Set<string>();
    private unansweredMatters = new Set<string>();

    constructor(private readonly store: Store, private readonly tokens: TokenFile) {}

    start(): void {
        this.timer = setInterval(() => void this.suggest(), SUGGEST_EVERY_MS);
        setTimeout(() => void this.suggest(), 10_000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }

    /** Ask about everything unnamed, a batch at a time. Quiet when off or already running; `minGapMs` skips it when it ran that recently. */
    async suggest(minGapMs = 0): Promise<void> {
        if (this.running || this.store.loadFailed || !this.store.workspace.preferences.suggestMatters) return;
        if (Date.now() - this.lastRun < minGapMs) return;
        this.lastRun = Date.now();
        const kiwi = this.store.workspace.sync?.targets.find((t) => t.product === "kiwi");
        const token = kiwi ? this.tokens.load() : null;
        if (!kiwi || !token) { this.store.setMatterStatus(false, "Connect this computer to Kiwi in Settings to get AI suggestions."); return; }
        this.running = true;
        this.store.setMatterStatus(true, null);
        try {
            const client = new KiwiClient(kiwi.serverURL, token, fetch, 120_000, PRODUCTS.kiwi.label);
            for (let round = 0; round < 10; round++) {
                const request = matterRequest(this.store.workspace);
                if (!request) break;
                const answer = await client.matters(request.body);
                // The person may have kept, dismissed or named some of these meanwhile; applyMatters skips those.
                if (!this.store.change((w) => { applyMatters(w, request.ids, answer); })) break;
            }
            for (let round = 0; round < 5; round++) {
                const request = draftRequest(this.store.workspace, this.unansweredRows);
                if (!request) break;
                const answer = await client.drafts(request.body);
                const answered = new Set(answer.drafts.map((d) => d.id));
                for (const r of request.rows) if (!answered.has(r.id)) this.unansweredRows.add(`${r.id}:${r.activityIDs.length}`);
                if (!this.store.change((w) => { applyDrafts(w, request.rows, answer); })) break;
            }
            const insights = insightRequest(this.store.workspace, Date.now(), this.unansweredMatters);
            if (insights) {
                const answer = await client.insights(insights);
                const answered = new Set(answer.insights.map((i) => i.id));
                for (const m of insights.matters) if (!answered.has(m.id)) this.unansweredMatters.add(m.id);
                const now = Date.now();
                this.store.change((w) => { applyInsights(w, answer, now); });
            }
            this.store.setMatterStatus(false, null);
        } catch (err) {
            // A slow or failed answer only means suggestions come later (the next round is
            // at most 30 minutes away), so it is not the person's problem: logged, not shown.
            // Only a disconnected computer is theirs to fix.
            console.warn("[matters]", err instanceof Error ? err.message : err);
            const theirs = err instanceof KiwiFailure && (err.code === "device_revoked" || err.code === "invalid_token");
            this.store.setMatterStatus(false, theirs ? err.message : null);
        } finally {
            this.running = false;
        }
    }
}
