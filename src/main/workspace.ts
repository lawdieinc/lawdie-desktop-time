/* workspace.json on disk: atomic writes, a private mode, and one writer at a time. */

import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { emptyWorkspace, parseWorkspace, WorkspaceError, type Workspace } from "@shared/model";

export class WorkspaceFile {
    /** True once load() found no file and started an empty workspace. */
    startedFresh = false;

    constructor(readonly path: string) {}

    /** The file as written by this app or the Swift one; a missing file is an empty workspace. An unreadable one throws and is left untouched. */
    load(): Workspace {
        if (!existsSync(this.path)) { this.startedFresh = true; return emptyWorkspace(); }
        return parseWorkspace(readFileSync(this.path, "utf8"));
    }

    save(workspace: Workspace): void {
        const dir = dirname(this.path);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = join(dir, `.workspace-${process.pid}-${Date.now()}.tmp`);
        writeFileSync(tmp, JSON.stringify(workspace, null, 2), { mode: 0o600 });
        renameSync(tmp, this.path);
        try { chmodSync(this.path, 0o600); } catch { /* Windows has no POSIX mode; the user profile is already private */ }
    }
}

/** A second process must never overwrite the running one's workspace. Returns the release function. */
export function acquireLock(directory: string): () => void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, "workspace.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = openSync(lockPath, "wx", 0o600);
            writeFileSync(fd, `${process.pid} ${bootTime()}`);
            closeSync(fd);
            return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            if (!lockIsStale(readFileSync(lockPath, "utf8"), bootTime(), process.pid, isAlive)) {
                throw new WorkspaceError("This workspace is already open in another Time Capture process. Quit that instance before continuing.");
            }
            unlinkSync(lockPath); // stale: the holder is gone
        }
    }
    throw new WorkspaceError("Could not open the workspace lock.");
}

/** When this computer started, to the minute: a lock written before a restart is stale whatever its process number now names. */
function bootTime(): number {
    return Math.round((Date.now() - uptime() * 1000) / 60_000) * 60_000;
}

/**
 * Whether a lock file's holder is gone. "<pid> <boot ms>" (0.16.3 on): stale when written before this computer
 * last started, or when that process has ended. A bare "<pid>" (earlier versions) has only the process to go by.
 */
export function lockIsStale(content: string, boot: number, self: number, alive: (pid: number) => boolean): boolean {
    const [pidText, bootText] = content.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || pid === self) return true;
    if (bootText !== undefined && Math.abs(Number(bootText) - boot) > 2 * 60_000) return true;
    return !alive(pid);
}

/** Leftovers of a save cut short (a crash between the write and the rename) in the workspace's folder. */
export function removeStaleTemps(directory: string, now = Date.now()): void {
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
        if (!/^\.workspace-\d+-\d+\.tmp$/.test(name)) continue;
        const file = join(directory, name);
        try { if (now - statSync(file).mtimeMs > 60_000) unlinkSync(file); } catch { /* gone already */ }
    }
}

/** How many daily copies of the workspace are kept beside it, in backups/. */
export const BACKUP_DAYS = 7;

/**
 * Once a day, a copy of the workspace as it was: backups/workspace-YYYY-MM-DD.json beside it, the newest
 * BACKUP_DAYS kept. Never of a file that is missing or empty.
 */
export function backupDaily(path: string, now = new Date()): void {
    try {
        if (!existsSync(path) || statSync(path).size === 0) return;
        const dir = join(dirname(path), "backups");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const stem = basename(path, ".json");
        const target = join(dir, `${stem}-${day}.json`);
        if (!existsSync(target)) { copyFileSync(path, target); try { chmodSync(target, 0o600); } catch { /* Windows */ } }
        const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
        const old = readdirSync(dir).filter((n) => pattern.test(n)).sort().reverse().slice(BACKUP_DAYS);
        for (const n of old) try { unlinkSync(join(dir, n)); } catch { /* gone */ }
    } catch { /* a backup that fails never stops the app */ }
}

function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}
