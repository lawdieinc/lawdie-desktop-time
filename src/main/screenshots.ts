/* Screenshots of the window in front, opt-in ("Take screenshots"), so a person reviewing
   their time can see what it was. Taken through Electron's desktopCapturer (macOS: the
   Screen Recording permission window titles already need; Windows: nothing to grant), of
   that one window only, as a JPEG in a folder beside the workspace. They never leave this
   computer: not synced, not sent to the AI. When to take one and which segment it belongs
   to is src/shared/model.ts (screenshotDue, addScreenshot); a file nothing refers to any
   more (dismissed, pruned, cleared, its entry deleted) is deleted by collect(). */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { report } from "./errors";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { desktopCapturer, net, protocol, systemPreferences } from "electron";
import { isScreenshotName, screenshotsToDelete } from "@shared/model";

/** The window loads screenshots as lawdie-shot://shot/<name>; registered as privileged before the app is ready. */
export const SHOT_SCHEME = "lawdie-shot";
const SIZE = { width: 1440, height: 900 };
const QUALITY = 65;
/** A file this new may be one just taken and not attached yet: collect() leaves it. */
const COLLECT_GRACE_MS = 10 * 60_000;
/** A capture still going after this long is abandoned; the next one is due in five minutes. */
const CAPTURE_TIMEOUT_MS = 10_000;
/** Holds the time a fresh workspace started beside older screenshots (`protectExisting`). */
const PROTECT_FILE = ".kept-before";

export class Screenshots {
    /** The last failure, logged once per kind rather than every five minutes. */
    private warned = new Set<string>();

    constructor(readonly dir: string) {}

    /** The file for a name, or null for anything that is not a screenshot name (never a path). */
    file(name: string): string | null {
        return isScreenshotName(name) ? join(this.dir, name) : null;
    }

    /**
     * Capture one window (get-windows' id: the CGWindowID on macOS, the HWND on Windows) to `name`. False when it
     * could not be. Without Screen Recording macOS still answers, with the wallpaper: no permission, no screenshot.
     * The capture is given CAPTURE_TIMEOUT_MS, and is saved only if `stillInFront` says the window was still the
     * one in front once it was taken (a private app brought forward meanwhile is never pictured).
     */
    async take(windowID: number, name: string, stillInFront: () => Promise<boolean> = async () => true): Promise<boolean> {
        const file = this.file(name);
        if (!file) return false;
        if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") return false;
        try {
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS); });
            const sources = await Promise.race([desktopCapturer.getSources({ types: ["window"], thumbnailSize: SIZE, fetchWindowIcons: false }), timeout]).finally(() => clearTimeout(timer));
            if (!sources) return this.fail("timeout", `window capture took over ${CAPTURE_TIMEOUT_MS / 1000} s`);
            const source = sources.find((s) => s.id.split(":")[1] === String(windowID));
            if (!source || source.thumbnail.isEmpty()) return this.fail(source ? "empty" : "not-found", `window ${windowID} ${source ? "came back empty" : "was not offered"}`);
            if (!(await stillInFront())) return false;
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            await writeFile(file, source.thumbnail.toJPEG(QUALITY), { mode: 0o600 });
            return true;
        } catch (err) {
            return this.fail("error", err instanceof Error ? err.message : String(err));
        }
    }

    /** Delete every screenshot file not in `keep` (and older than a few minutes), never one from before a fresh start (`protectExisting`). */
    collect(keep: Set<string>, now = Date.now()): void {
        let names: string[];
        try { names = readdirSync(this.dir); } catch { return; }
        const files = names.filter(isScreenshotName).flatMap((name) => { try { return [{ name, mtimeMs: statSync(join(this.dir, name)).mtimeMs }]; } catch { return []; } });
        for (const name of screenshotsToDelete(files, keep, now, COLLECT_GRACE_MS, this.protectedBefore())) {
            try { unlinkSync(join(this.dir, name)); } catch { /* gone already */ }
        }
    }

    /**
     * The workspace was started fresh (its file was missing) beside screenshots already on disk: they belong to a
     * workspace this one replaced, so collect() never deletes them. Remembered in the folder, since the new file
     * is saved at once and the next launch would not know.
     */
    protectExisting(now = Date.now()): void {
        try {
            if (!readdirSync(this.dir).some(isScreenshotName) || this.protectedBefore() !== null) return;
            writeFileSync(join(this.dir, PROTECT_FILE), String(now), { mode: 0o600 });
            report("screenshots", new Error("Workspace started fresh beside existing screenshots; they are kept"), { reason: "fresh workspace" });
        } catch { /* no folder: nothing to protect */ }
    }

    private protectedBefore(): number | null {
        try { const t = Number(readFileSync(join(this.dir, PROTECT_FILE), "utf8").trim()); return Number.isFinite(t) ? t : null; } catch { return null; }
    }

    /** Serve lawdie-shot://shot/<name> from the folder; anything else is not found. */
    serve(): void {
        protocol.handle(SHOT_SCHEME, (request) => {
            const file = this.file(decodeURIComponent(new URL(request.url).pathname.slice(1)));
            return file ? net.fetch(pathToFileURL(file).toString()) : new Response("Not found", { status: 404 });
        });
    }

    private fail(kind: string, message: string): false {
        if (!this.warned.has(kind)) report("screenshots", new Error(message), { reason: kind });
        this.warned.add(kind);
        return false;
    }
}
