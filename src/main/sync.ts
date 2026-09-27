/* Sync to Kiwi, Lawdie CRM or both, main-process side: one token, kept in a file
   encrypted with Electron's safeStorage (Keychain on macOS, DPAPI on Windows, the keyring
   on Linux), never in the workspace or a backup. Both products accept the same token when
   the Time page that minted it registered it with the other. The client and the payload
   are in src/shared and are pure. */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { KiwiClient, KiwiFailure, PRODUCTS, destinationLabel, productsFor, type Destination, type Product } from "@shared/kiwi";
import { markSynced, syncBatches, syncRequest, type SyncTarget } from "@shared/model";
import type { Store } from "./store";

export const SYNC_EVERY_MS = 60_000;

export class TokenFile {
    constructor(readonly path: string) {}
    save(token: string): void {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, "utf8");
        writeFileSync(this.path, data, { mode: 0o600 });
    }
    load(): string | null {
        if (!existsSync(this.path)) return null;
        const data = readFileSync(this.path);
        try {
            return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString("utf8");
        } catch {
            return null;
        }
    }
    delete(): void {
        try { unlinkSync(this.path); } catch { /* already gone */ }
    }
}

const client = (product: Product, serverURL: string, token: string): KiwiClient => new KiwiClient(serverURL, token, fetch, 30_000, PRODUCTS[product].label);

export class Sync {
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly store: Store, private readonly tokens: TokenFile, private readonly deviceLabel: string) {}

    start(): void {
        this.timer = setInterval(() => { if (this.store.workspace.sync?.autoSync) void this.syncNow(); }, SYNC_EVERY_MS);
        setTimeout(() => { if (this.store.workspace.sync?.autoSync) void this.syncNow(); }, 5_000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }

    /** Pair with the token a Time page showed once. Every chosen product must say hello before anything is stored. */
    async connect(destination: Destination, servers: Partial<Record<Product, string>>, token: string): Promise<boolean> {
        const products = productsFor(destination);
        const names = destinationLabel(products);
        if (this.store.loadFailed) { this.store.error = `Restore or repair the workspace before connecting to ${names}.`; this.store.publish(); return false; }
        const trimmed = token.trim();
        if (!trimmed.startsWith("ldt_")) { this.store.error = `Paste the token ${names} showed when you connected this computer. It starts with ldt_.`; this.store.publish(); return false; }
        this.store.setSyncing(true);
        try {
            const targets: SyncTarget[] = [];
            for (const product of products) {
                const c = client(product, servers[product] ?? PRODUCTS[product].defaultServerURL, trimmed);
                const hello = await c.hello();
                if (!hello.ok) throw new KiwiFailure("bad_response", `${PRODUCTS[product].label} answered in a way this app does not understand.`);
                targets.push({ product, serverURL: c.baseURL, deviceID: hello.device.id, deviceName: hello.device.name, accountEmail: hello.user.email ?? null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] });
            }
            this.tokens.save(trimmed);
            const ok = this.store.change((w) => { w.sync = { targets, autoSync: true }; });
            if (!ok) { this.tokens.delete(); return false; }
            const first = targets[0];
            this.store.say(`Connected to ${names} as ${first.accountEmail ?? "your account"}. This ${this.deviceLabel} is “${first.deviceName}” there.`);
        } catch (err) {
            this.store.error = err instanceof Error ? err.message : String(err);
            this.store.publish();
            return false;
        } finally {
            this.store.setSyncing(false);
        }
        await this.syncNow();
        return true;
    }

    disconnect(): void {
        const names = destinationLabel((this.store.workspace.sync?.targets ?? []).map((t) => t.product));
        this.tokens.delete();
        if (this.store.change((w) => { w.sync = null; })) this.store.say(`Disconnected from ${names}. Nothing more leaves this computer; what was already synced stays in ${names}.`);
    }

    /** Push everything each destination should know. Safe to repeat: both upsert on the app's ids. */
    async syncNow(): Promise<void> {
        const state = this.store.workspace.sync;
        if (!state || this.store.syncing || this.store.loadFailed) return;
        const token = this.tokens.load();
        if (!token) {
            this.store.change((w) => { for (const t of w.sync?.targets ?? []) t.lastError = "The token is missing from this computer. Disconnect and connect again."; });
            return;
        }
        this.store.setSyncing(true);
        try {
            for (const target of state.targets) {
                try {
                    const c = client(target.product, target.serverURL, token);
                    const acknowledged: string[] = [];
                    for (const batch of syncBatches(syncRequest(this.store.workspace, this.store.appVersion, undefined, target))) {
                        await c.sync(batch);
                        acknowledged.push(...batch.deleted_entry_ids);
                    }
                    const now = Date.now();
                    this.store.change((w) => markSynced(w, now, acknowledged, target.product));
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.store.change((w) => { const t = w.sync?.targets.find((x) => x.product === target.product); if (t) t.lastError = message; });
                }
            }
        } finally {
            this.store.setSyncing(false);
        }
    }
}
