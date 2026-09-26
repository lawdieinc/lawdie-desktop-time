/* workspace.json on disk: atomic writes, a private mode, and one writer at a time. */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyWorkspace, parseWorkspace, WorkspaceError, type Workspace } from "@shared/model";

export class WorkspaceFile {
    constructor(readonly path: string) {}

    /** The file as written by this app or the Swift one; a missing file is an empty workspace. An unreadable one throws and is left untouched. */
    load(): Workspace {
        if (!existsSync(this.path)) return emptyWorkspace();
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
            writeFileSync(fd, String(process.pid));
            closeSync(fd);
            return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            const pid = Number(readFileSync(lockPath, "utf8").trim());
            if (Number.isFinite(pid) && pid !== process.pid && isAlive(pid)) {
                throw new WorkspaceError("This workspace is already open in another Time Capture process. Quit that instance before continuing.");
            }
            unlinkSync(lockPath); // stale: the holder is gone
        }
    }
    throw new WorkspaceError("Could not open the workspace lock.");
}

function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}
