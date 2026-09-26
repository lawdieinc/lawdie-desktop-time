/* The one place the workspace changes. Every mutation runs on a copy, is written to disk,
   and only then becomes the live state and reaches the window — the Swift app's rule,
   kept. A failed write leaves the old state and reports the error. */

import { WorkspaceError, emptyWorkspace, recover, validate, type Workspace } from "@shared/model";
import type { AppState } from "@shared/state";
import type { WorkspaceFile } from "./workspace";

export type { AppState };

export class Store {
    workspace: Workspace = emptyWorkspace();
    syncing = false;
    loadFailed = false;
    error: string | null = null;
    notice: string | null = null;
    private listeners = new Set<(state: AppState) => void>();

    constructor(readonly file: WorkspaceFile, readonly appVersion: string, readonly platform: NodeJS.Platform = process.platform) {
        try {
            this.workspace = file.load();
            const recovered = this.workspace.timer !== null;
            recover(this.workspace, Date.now());
            file.save(this.workspace);
            if (recovered) this.notice = "Your previous timer was saved at its last heartbeat. Start a new timer when you're ready.";
        } catch (err) {
            this.loadFailed = true;
            this.error = `Could not open your workspace. Your file has been left untouched. ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    snapshot(): AppState {
        return { workspace: this.workspace, syncing: this.syncing, loadFailed: this.loadFailed, error: this.error, notice: this.notice, platform: this.platform, appVersion: this.appVersion, workspacePath: this.file.path };
    }

    subscribe(listener: (state: AppState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    publish(): void {
        const state = this.snapshot();
        for (const listener of this.listeners) listener(state);
    }

    /** Apply a mutation. Returns false (and sets `error`) when it was refused or could not be saved. */
    change(mutation: (w: Workspace) => void): boolean {
        if (this.loadFailed) {
            this.error = "The workspace could not be loaded. Restore a backup or repair the file before making changes.";
            this.publish();
            return false;
        }
        const before = JSON.stringify(this.workspace);
        const next = structuredClone(this.workspace);
        try {
            mutation(next);
            validate(next);
            if (JSON.stringify(next) !== before) this.file.save(next);
            this.workspace = next;
            this.publish();
            return true;
        } catch (err) {
            this.error = err instanceof WorkspaceError || err instanceof Error ? err.message : String(err);
            this.publish();
            return false;
        }
    }

    setSyncing(on: boolean): void {
        this.syncing = on;
        this.publish();
    }

    say(notice: string | null): void {
        this.notice = notice;
        this.publish();
    }

    clearError(): void {
        this.error = null;
        this.publish();
    }
}
