import type { Workspace } from "./model";

/** What the window sees. Built by the main process's Store, sent whole on every change. */
export type AppState = {
    workspace: Workspace;
    syncing: boolean;
    loadFailed: boolean;
    error: string | null;
    notice: string | null;
    platform: NodeJS.Platform;
    appVersion: string;
    workspacePath: string;
};
