/* Screenshots of the window in front, opt-in ("Take screenshots"), so a person reviewing
   their time can see what it was. Taken through Electron's desktopCapturer (macOS: the
   Screen Recording permission window titles already need; Windows: nothing to grant), of
   that one window only, as a JPEG in a folder beside the workspace. They never leave this
   computer: not synced, not sent to the AI. When to take one and which segment it belongs
   to is src/shared/model.ts (screenshotDue, addScreenshot); a file nothing refers to any
   more (dismissed, pruned, cleared, its entry deleted) is deleted by collect(). */

import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { desktopCapturer, net, protocol } from "electron";
import { isScreenshotName } from "@shared/model";

/** The window loads screenshots as lawdie-shot://shot/<name>; registered as privileged before the app is ready. */
export const SHOT_SCHEME = "lawdie-shot";
const SIZE = { width: 1440, height: 900 };
const QUALITY = 65;
/** A file this new may be one just taken and not attached yet: collect() leaves it. */
const COLLECT_GRACE_MS = 10 * 60_000;

export class Screenshots {
    /** The last failure, logged once per kind rather than every five minutes. */
    private warned = new Set<string>();

    constructor(readonly dir: string) {}

    /** The file for a name, or null for anything that is not a screenshot name (never a path). */
    file(name: string): string | null {
        return isScreenshotName(name) ? join(this.dir, name) : null;
    }

    /** Capture one window (get-windows' id: the CGWindowID on macOS, the HWND on Windows) to `name`. False when it could not be. */
    async take(windowID: number, name: string): Promise<boolean> {
        const file = this.file(name);
        if (!file) return false;
        try {
            const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: SIZE, fetchWindowIcons: false });
            const source = sources.find((s) => s.id.split(":")[1] === String(windowID));
            if (!source || source.thumbnail.isEmpty()) return this.fail(source ? "empty" : "not-found", `window ${windowID} ${source ? "came back empty" : "was not offered"}`);
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            await writeFile(file, source.thumbnail.toJPEG(QUALITY), { mode: 0o600 });
            return true;
        } catch (err) {
            return this.fail("error", err instanceof Error ? err.message : String(err));
        }
    }

    /** Delete every screenshot file not in `keep` (and older than a few minutes). */
    collect(keep: Set<string>, now = Date.now()): void {
        let names: string[];
        try { names = readdirSync(this.dir); } catch { return; }
        for (const name of names) {
            if (!isScreenshotName(name) || keep.has(name)) continue;
            const file = join(this.dir, name);
            try { if (now - statSync(file).mtimeMs > COLLECT_GRACE_MS) unlinkSync(file); } catch { /* gone already */ }
        }
    }

    /** Serve lawdie-shot://shot/<name> from the folder; anything else is not found. */
    serve(): void {
        protocol.handle(SHOT_SCHEME, (request) => {
            const file = this.file(decodeURIComponent(new URL(request.url).pathname.slice(1)));
            return file ? net.fetch(pathToFileURL(file).toString()) : new Response("Not found", { status: 404 });
        });
    }

    private fail(kind: string, message: string): false {
        if (!this.warned.has(kind)) console.warn("[screenshots]", message);
        this.warned.add(kind);
        return false;
    }
}
