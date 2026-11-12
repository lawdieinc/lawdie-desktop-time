import { applyJoins, joinRequest } from "@shared/feed";
import { report } from "./errors";
/* AI suggestions, main-process side: requests to Kiwi, which asks its own server-side
   model. In order: summarise each finished sitting in a line (with one screenshot of it when
   screenshots are on), name the matter of new activity, draft a billing description for each
   row waiting in review, and refresh the insight of each matter whose time changed. Off
   until the person switches on "AI suggestions", and only while this computer is
   connected to Kiwi: the device token it already syncs with is the only credential, so
   no one enters a key. What is sent and how answers are applied is src/shared/matters.ts. */

import { KiwiClient, KiwiFailure, PRODUCTS } from "@shared/kiwi";
import { applyDrafts, applyInsights, applyMatters, draftRequest, insightRequest, matterRequest } from "@shared/matters";
import { applySummaries, summaryRequest } from "@shared/summaries";
import type { Screenshots } from "./screenshots";
import type { Store } from "./store";
import type { TokenFile } from "./sync";

/** In the background, every half hour; opening Activity asks sooner, at most every ten minutes. */
export const SUGGEST_EVERY_MS = 30 * 60_000;
export const SUGGEST_ON_OPEN_MS = 10 * 60_000;
/** Summary requests a round (40 sittings each): a few normally, many on the first round of a run to clear a backlog. */
const SUMMARY_ROUNDS = 5;
const SUMMARY_BACKLOG_ROUNDS = 40;

export class Matters {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private lastRun = 0;
    /** Rows and matters asked this session and not answered, so they are not asked every round. */
    private unansweredRows = new Set<string>();
    private unansweredMatters = new Set<string>();
    private unansweredSittings = new Set<string>();
    private noSummaryRoute = false;
    /** The first round of a run clears the backlog (sittings from before an update, or a week away); later rounds are small. */
    private summaryBacklogCleared = false;

    constructor(private readonly store: Store, private readonly tokens: TokenFile, private readonly shots: Screenshots) {}

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
            const joins = joinRequest(this.store.workspace);
            if (joins) {
                const account = this.store.workspace.feed?.account;
                const answer = await client.joins(joins);
                if (this.store.workspace.preferences.suggestMatters && this.store.workspace.feed?.account === account && this.store.workspace.sync?.targets.some((t) => t === kiwi || (t.product === "kiwi" && t.deviceID === kiwi.deviceID))) this.store.change((w) => applyJoins(w, joins, answer));
            }
            // Summaries first: a sitting's line helps name its matter and draft its row. A failure
            // here (a Kiwi without the route yet, a slow model) leaves naming and drafting to go on.
            if (!this.noSummaryRoute) try { await this.summarise(client); } catch (err) {
                if (err instanceof KiwiFailure && (err.code === "device_revoked" || err.code === "invalid_token")) throw err;
                // A Kiwi from before summaries (404): not a bug, and not asked again this run.
                if (err instanceof KiwiFailure && err.status === 404) this.noSummaryRoute = true;
                else report("summaries", err);
            }
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
            report("matters", err);
            const theirs = err instanceof KiwiFailure && (err.code === "device_revoked" || err.code === "invalid_token");
            this.store.setMatterStatus(false, theirs ? err.message : null);
        } finally {
            this.running = false;
        }
    }

    /** A line for each finished sitting, a batch at a time, with its screenshot made small when it has one. */
    private async summarise(client: KiwiClient): Promise<void> {
        const rounds = this.summaryBacklogCleared ? SUMMARY_ROUNDS : SUMMARY_BACKLOG_ROUNDS;
        for (let round = 0; round < rounds; round++) {
            const request = summaryRequest(this.store.workspace, this.unansweredSittings);
            if (!request) { this.summaryBacklogCleared = true; break; }
            for (const s of request.body.sittings) {
                const shot = request.shots[s.id];
                const image = shot ? this.shots.forSummary(shot) : null;
                if (image) s.image = image; else delete request.shots[s.id];
            }
            const answer = await client.summaries(request.body);
            if (!this.store.workspace.preferences.suggestMatters) break;
            let done: string[] = [];
            if (!this.store.change((w) => { done = applySummaries(w, request, answer); })) break;
            const got = new Set(done);
            for (const id of request.ids) if (!got.has(id)) this.unansweredSittings.add(id);
        }
    }
}
