/* Matter suggestions, main-process side: one request to Kiwi, which asks its own
   server-side model. Off until the person switches on "Suggest matters", and only while
   this computer is connected to Kiwi: the device token it already syncs with is the only
   credential, so no one enters a key. What is sent and how the answer is applied is
   src/shared/matters.ts. */

import { KiwiClient, KiwiFailure, PRODUCTS } from "@shared/kiwi";
import { applyMatters, matterRequest } from "@shared/matters";
import type { Store } from "./store";
import type { TokenFile } from "./sync";

export const SUGGEST_EVERY_MS = 5 * 60_000;

export class Matters {
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(private readonly store: Store, private readonly tokens: TokenFile) {}

    start(): void {
        this.timer = setInterval(() => void this.suggest(), SUGGEST_EVERY_MS);
        setTimeout(() => void this.suggest(), 10_000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }

    /** Ask about everything unnamed, a batch at a time. Quiet when off or already running. */
    async suggest(): Promise<void> {
        if (this.running || this.store.loadFailed || !this.store.workspace.preferences.suggestMatters) return;
        const kiwi = this.store.workspace.sync?.targets.find((t) => t.product === "kiwi");
        const token = kiwi ? this.tokens.load() : null;
        if (!kiwi || !token) { this.store.setMatterStatus(false, "Connect this computer to Kiwi in Settings to suggest matters."); return; }
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
            this.store.setMatterStatus(false, null);
        } catch (err) {
            const message = err instanceof KiwiFailure && err.code === "http"
                ? "Kiwi could not name matters just now; it will try again in a few minutes."
                : err instanceof Error ? err.message : String(err);
            this.store.setMatterStatus(false, message);
        } finally {
            this.running = false;
        }
    }
}
