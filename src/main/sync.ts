/* Kiwi sync, main-process side: the token lives in a file encrypted with Electron's
   safeStorage (Keychain on macOS, DPAPI on Windows, the keyring on Linux), never in the
   workspace or a backup. The client and the payload are in src/shared and are pure. */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { KiwiClient, KiwiFailure } from "@shared/kiwi";
import { markSynced, syncBatches, syncRequest } from "@shared/model";
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

    /** Pair with the token Kiwi showed once. Hello confirms it before anything is stored. */
    async connect(serverURL: string, token: string): Promise<boolean> {
        if (this.store.loadFailed) { this.store.error = "Restore or repair the workspace before connecting to Kiwi."; this.store.publish(); return false; }
        const trimmed = token.trim();
        if (!trimmed.startsWith("ldt_")) { this.store.error = "Paste the token Kiwi showed when you connected this computer. It starts with ldt_."; this.store.publish(); return false; }
        this.store.setSyncing(true);
        try {
            const client = new KiwiClient(serverURL, trimmed);
            const hello = await client.hello();
            if (!hello.ok) throw new KiwiFailure("bad_response", "Kiwi answered in a way this app does not understand.");
            this.tokens.save(trimmed);
            const ok = this.store.change((w) => {
                w.sync = { serverURL: client.baseURL, deviceID: hello.device.id, deviceName: hello.device.name, accountEmail: hello.user.email ?? null, autoSync: true, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] };
            });
            if (!ok) { this.tokens.delete(); return false; }
            this.store.say(`Connected to Kiwi as ${hello.user.email ?? "your account"}. This ${this.deviceLabel} is “${hello.device.name}” there.`);
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
        this.tokens.delete();
        if (this.store.change((w) => { w.sync = null; })) this.store.say("Disconnected from Kiwi. Nothing more leaves this computer; what was already synced stays in Kiwi.");
    }

    /** Push everything Kiwi should know. Safe to repeat: Kiwi upserts on the app's ids. */
    async syncNow(): Promise<void> {
        const state = this.store.workspace.sync;
        if (!state || this.store.syncing || this.store.loadFailed) return;
        const token = this.tokens.load();
        if (!token) {
            this.store.change((w) => { if (w.sync) w.sync.lastError = "The Kiwi token is missing from this computer. Disconnect and connect again."; });
            return;
        }
        this.store.setSyncing(true);
        try {
            const client = new KiwiClient(state.serverURL, token);
            const acknowledged: string[] = [];
            for (const batch of syncBatches(syncRequest(this.store.workspace, this.store.appVersion))) {
                await client.sync(batch);
                acknowledged.push(...batch.deleted_entry_ids);
            }
            const now = Date.now();
            this.store.change((w) => markSynced(w, now, acknowledged));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.store.change((w) => { if (w.sync) w.sync.lastError = message; });
        } finally {
            this.store.setSyncing(false);
        }
    }
}
