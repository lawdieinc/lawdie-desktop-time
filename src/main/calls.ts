/* Who is recording from the microphone, for calls (src/shared/calls.ts says why): on macOS
   the mic-users helper (native/mic-users, built to resources/bin), on Windows the
   registry's record of microphone use. Asked every sample while capture is on; a failure
   is "no call", logged once. Linux has neither, so a call there counts only in front. */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { app } from "electron";
import { parseMacRecording, parseWindowsRecording } from "@shared/calls";

const ASK_TIMEOUT_MS = 3_000;
const WIN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

function helperPath(): string {
    const base = app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked") : app.getAppPath();
    return join(base, "resources", "bin", "mic-users");
}

function run(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: ASK_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

export class MicrophoneProbe {
    private warned = false;

    /** Owner ids (bundle ids, executable paths or names) recording right now. */
    async recording(): Promise<string[]> {
        try {
            if (process.platform === "darwin") return parseMacRecording(await run(helperPath(), []));
            if (process.platform === "win32") return parseWindowsRecording(await run("reg.exe", ["query", WIN_KEY, "/s"]));
        } catch (err) {
            if (!this.warned) console.warn("[calls] microphone use unavailable", err instanceof Error ? err.message : err);
            this.warned = true;
        }
        return [];
    }
}
