/* Calls: the one exception to "only the app in front counts". A call goes on while the
   person works in another window, and it is the work: so while a call app is recording
   from the microphone, the call gets the time wherever the focus is. Teams and Zoom keep
   the microphone open while muted, so a muted call still counts. Browsers never count
   (Meet in a tab is the extension's), and an excluded call app is not captured.

   Who is recording: on macOS Core Audio's process list (native/mic-users, 14.2+); on
   Windows the registry's record of microphone use, where a LastUsedTimeStop of 0 after a
   start means "now". Pure: the list of call apps and both parsers are tested here; the
   asking is src/main/calls.ts. */

export type CallApp = { key: string; name: string };

/** macOS bundle id prefixes: a call app's audio often runs in a helper (com.microsoft.teams2.helper…). */
const MAC_CALL_APPS: [string, CallApp][] = [
    ["com.microsoft.teams", { key: "teams", name: "Microsoft Teams" }],
    ["us.zoom.", { key: "zoom", name: "Zoom" }],
    ["cisco-systems.spark", { key: "webex", name: "Webex" }],
    ["com.cisco.webex", { key: "webex", name: "Webex" }],
    ["com.webex.", { key: "webex", name: "Webex" }],
    ["com.tinyspeck.slackmacgap", { key: "slack", name: "Slack" }],
    ["com.apple.facetime", { key: "facetime", name: "FaceTime" }],
    ["com.skype.", { key: "skype", name: "Skype" }],
    ["com.ringcentral.", { key: "ringcentral", name: "RingCentral" }],
    ["com.goto.", { key: "goto", name: "GoTo Meeting" }],
];

/** Windows executables, by basename. */
const WIN_CALL_APPS: Record<string, CallApp> = {
    "ms-teams.exe": { key: "teams", name: "Microsoft Teams" },
    "teams.exe": { key: "teams", name: "Microsoft Teams" },
    "zoom.exe": { key: "zoom", name: "Zoom" },
    "cpthost.exe": { key: "zoom", name: "Zoom" },
    "webex.exe": { key: "webex", name: "Webex" },
    "ciscocollabhost.exe": { key: "webex", name: "Webex" },
    "atmgr.exe": { key: "webex", name: "Webex" },
    "slack.exe": { key: "slack", name: "Slack" },
    "skype.exe": { key: "skype", name: "Skype" },
    "ringcentral.exe": { key: "ringcentral", name: "RingCentral" },
    "g2mcomm.exe": { key: "goto", name: "GoTo Meeting" },
};

/** Store (packaged) apps are recorded by package family, not by executable. */
const WIN_PACKAGES: [string, string][] = [
    ["msteams_", "ms-teams.exe"],
    ["microsoftteams_", "ms-teams.exe"],
    ["microsoft.skypeapp_", "skype.exe"],
];

/** The call app an owner id names (bundle id on macOS, executable path or name on Windows), if any. */
export function callApp(ownerID: string): CallApp | null {
    const lower = ownerID.toLowerCase();
    for (const [prefix, app] of MAC_CALL_APPS) if (lower.startsWith(prefix)) return app;
    const base = lower.split(/[\\/]/).pop() ?? lower;
    return WIN_CALL_APPS[base] ?? null;
}

/** The call in progress: the first call app among those recording, with the id it was seen by. */
export function activeCall(recording: readonly string[]): { app: CallApp; ownerID: string } | null {
    for (const ownerID of recording) {
        const app = callApp(ownerID);
        if (app) return { app, ownerID };
    }
    return null;
}

/** native/mic-users: one bundle id per line; "UNSUPPORTED" (macOS before 14.2) is no one. */
export function parseMacRecording(output: string): string[] {
    return output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "UNSUPPORTED");
}

/**
 * `reg query …\ConsentStore\microphone /s`: a block per app, a key line then its values.
 * In use now = started and not yet stopped. NonPackaged keys are paths with "#" for "\";
 * packaged ones are mapped to their executable.
 */
export function parseWindowsRecording(output: string): string[] {
    const found: string[] = [];
    let key: string | null = null, start = 0, stop = -1;
    const flush = () => {
        if (key && start > 0 && stop === 0) {
            const leaf = key.split("\\").pop() ?? "";
            if (/\\NonPackaged\\/i.test(key)) found.push(leaf.replace(/#/g, "\\"));
            else {
                const pkg = WIN_PACKAGES.find(([prefix]) => leaf.toLowerCase().startsWith(prefix));
                if (pkg) found.push(pkg[1]);
            }
        }
        key = null; start = 0; stop = -1;
    };
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.trim();
        if (/^HKEY_/i.test(line)) { flush(); key = line; continue; }
        const m = /^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)$/i.exec(line);
        if (!m || !key) continue;
        const value = parseInt(m[2], 16);
        if (m[1].toLowerCase() === "lastusedtimestart") start = value; else stop = value;
    }
    flush();
    return found;
}
