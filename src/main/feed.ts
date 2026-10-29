import { accountOf, ensureFeed, importFeed, parseFeedPage, refreshReceipts } from "@shared/feed";
import { KiwiClient } from "@shared/kiwi";
import { localTimeZone } from "@shared/model";
import type { Store } from "./store";
import type { TokenFile } from "./sync";

/** Replay the retention window on each pass: late browser uploads cannot fall behind a cursor. */
export class Feed {
    private timer: NodeJS.Timeout | null = null;
    private initial: NodeJS.Timeout | null = null;
    private running = false;
    private generation = 0;
    constructor(private readonly store: Store, private readonly tokens: TokenFile) {}
    start(): void {
        this.timer = setInterval(() => void this.pull(), 180_000);
        this.initial = setTimeout(() => void this.pull(), 15_000);
    }
    stop(): void { this.generation++; if (this.timer) clearInterval(this.timer); if (this.initial) clearTimeout(this.initial); }
    cancel(): void { this.generation++; }
    async pull(): Promise<void> {
        if (this.running || this.store.loadFailed || !this.store.workspace.preferences.importKiwiTime) return;
        const target = this.store.workspace.sync?.targets.find((t) => t.product === "kiwi");
        const token = this.tokens.load();
        if (!target || !token) return;
        const generation = this.generation;
        const active = () => generation === this.generation && this.store.workspace.preferences.importKiwiTime && this.store.workspace.sync?.targets.some((t) => t.product === "kiwi" && t.serverURL === target.serverURL && t.deviceID === target.deviceID);
        this.running = true;
        this.store.setFeedStatus(true, null);
        try {
            const client = new KiwiClient(target.serverURL, token);
            const hello = await client.hello();
            if (!active()) return;
            if (!hello.user.id) throw new Error("Kiwi needs an update before it can share browser and Kiwi time.");
            const account = accountOf(target.serverURL, hello.user.id);
            if (!this.store.change((w) => { ensureFeed(w, account); })) return;
            const workspaceID = this.store.workspace.feed!.workspaceID;
            const since = new Date(Date.now() - this.store.workspace.preferences.retentionDays * 86400_000).toISOString();
            let cursor: string | null = null;
            const seen = new Set<string>();
            do {
                const page = parseFeedPage(await client.feed(since, workspaceID, cursor), Date.now());
                if (!active()) return;
                if (accountOf(target.serverURL, page.account_id) !== account) throw new Error("Kiwi's account changed during import. Reconnect before trying again.");
                const claim = await client.claimFeed(workspaceID, page.rows, localTimeZone());
                if (!active()) return;
                if (!Array.isArray(claim.claimed)) throw new Error("Kiwi sent an invalid import receipt.");
                const claimed = new Set(claim.claimed.map((r) => `${r.kind}:${r.id}`));
                if (!this.store.change((w) => { importFeed(w, { ...page, rows: page.rows.filter((r) => claimed.has(`${r.kind}:${r.id}`)) }, Date.now()); })) return;
                cursor = page.next;
                if (cursor && seen.has(cursor)) throw new Error("Kiwi repeated an import page. Try again later.");
                if (cursor) seen.add(cursor);
            } while (cursor && active());
            if (!active()) return;
            this.store.change(refreshReceipts);
            const receipts = Object.entries(this.store.workspace.feed!.receipts).map(([key, r]) => { const split = key.indexOf(":"); return { kind: key.slice(0, split), id: key.slice(split + 1), disposition: r.disposition }; });
            for (let i = 0; i < receipts.length && active(); i += 500) await client.reviewFeed(workspaceID, receipts.slice(i, i + 500));
        } catch (err) {
            if (active()) this.store.setFeedStatus(false, err instanceof Error ? err.message : "Could not import Kiwi time.");
        } finally {
            this.running = false;
            this.store.setFeedStatus(false, this.store.feedStatus.error);
        }
    }
}
