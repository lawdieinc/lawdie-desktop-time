import type { Workspace } from "./model";

/** What the window sees. Built by the main process's Store, sent whole on every change. */
export type AppState = {
    workspace: Workspace;
    syncing: boolean;
    feed: { running: boolean; error: string | null };
    loadFailed: boolean;
    error: string | null;
    notice: string | null;
    /** Matter suggestions: asking Kiwi now, and the last failure. */
    matters: { running: boolean; error: string | null };
    /** A newer version downloaded and waiting for a restart, or null. */
    updateReady: string | null;
    /** macOS permissions a switched-on feature needs and does not have (an update can lose them). */
    missing: { screenRecording: boolean; accessibility: boolean };
    platform: NodeJS.Platform;
    appVersion: string;
    workspacePath: string;
};
