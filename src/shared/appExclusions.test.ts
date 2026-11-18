import { describe, expect, it } from "vitest";
import { appChoices, excludedApps, exclusionID, fallbackName, searchApps, usedApps, withExclusions } from "./appExclusions";
import { emptyWorkspace, isExcluded, type Activity } from "./model";

const act = (ownerID: string, app: string, minutes: number, extra: Partial<Activity> = {}): Activity => ({
    id: globalThis.crypto.randomUUID(), app, ownerID, title: null, startedAt: "2026-11-18T10:00:00.000Z",
    endedAt: new Date(Date.parse("2026-11-18T10:00:00.000Z") + minutes * 60_000).toISOString(), disposition: "pending", projectID: null, ...extra,
} as Activity);

describe("app exclusions", () => {
    it("stores a bundle id as it is and a path as its file name, which isExcluded matches", () => {
        expect(exclusionID("com.apple.Notes")).toBe("com.apple.Notes");
        expect(exclusionID("C:\\Program Files\\Signal\\Signal.exe")).toBe("Signal.exe");
        expect(exclusionID("/usr/bin/signal-desktop")).toBe("signal-desktop");
        expect(exclusionID("keepass.exe")).toBe("keepass.exe");
        const prefs = { ...emptyWorkspace().preferences, excludedOwnerIDs: [exclusionID("C:\\Program Files\\Signal\\Signal.exe")] };
        expect(isExcluded(prefs, "C:\\Program Files\\Signal\\Signal.exe")).toBe(true);
    });

    it("lists the apps used, most time first, without browsers, this app, manual or imported time", () => {
        const w = emptyWorkspace();
        w.activities = [
            act("com.microsoft.Word", "Microsoft Word", 30), act("com.microsoft.Word", "Microsoft Word", 30),
            act("com.apple.Notes", "Notes", 40), act("com.google.Chrome", "Google Chrome", 90),
            act("co.lawdie.timecapture.desktop", "Lawdie Time Capture", 90), act("manual", "Added by you", 90),
            act("kiwi", "Kiwi", 90, { origin: "kiwi" } as Partial<Activity>),
        ];
        expect(usedApps(w).map((a) => [a.name, a.seconds])).toEqual([["Microsoft Word", 3600], ["Notes", 2400]]);
    });

    it("joins installed and used apps once, the installed name and path winning", () => {
        const all = appChoices(
            [{ id: "com.apple.Notes", name: "Notes", path: "/System/Applications/Notes.app" }, { id: "com.apple.Safari", name: "Safari", path: "/Applications/Safari.app" }],
            [{ id: "com.apple.notes", name: "Notes helper", seconds: 60 }, { id: "Signal.exe", name: "Signal", seconds: 5 }],
        );
        expect(all).toEqual([
            { id: "com.apple.Notes", name: "Notes", path: "/System/Applications/Notes.app", seconds: 60 },
            { id: "Signal.exe", name: "Signal", seconds: 5 },
        ]);
    });

    it("names excluded ids, known or not", () => {
        const named = excludedApps(["com.1password.1password", "com.example.Private-App", "com.apple.Notes"], [{ id: "com.apple.notes", name: "Notes", path: "/x" }]);
        expect(named.map((a) => a.name)).toEqual(["1Password", "Private-App", "Notes"]);
        expect(named[2].id).toBe("com.apple.Notes");
        expect(named.map((a) => a.named)).toEqual([true, false, true]);
        const defaults = ["com.apple.keychainaccess", "1password.exe", "signal-desktop"];
        expect(excludedApps(defaults, [], "darwin").map((a) => a.id)).toEqual(["com.apple.keychainaccess"]);
        expect(excludedApps(defaults, [], "win32").map((a) => a.id)).toEqual(["1password.exe", "signal-desktop"]);
        expect(fallbackName("keepass.exe")).toBe("KeePass");
        expect(fallbackName("signal.exe")).toBe("signal");
    });

    it("searches every word, names that start with the query first", () => {
        const apps = [{ id: "a", name: "Microsoft Word" }, { id: "b", name: "WordPerfect" }, { id: "c", name: "Notes" }];
        expect(searchApps(apps, "word").map((a) => a.name)).toEqual(["WordPerfect", "Microsoft Word"]);
        expect(searchApps(apps, "micro word").map((a) => a.name)).toEqual(["Microsoft Word"]);
        expect(searchApps(apps, "")).toHaveLength(3);
    });

    it("adds ids once, case ignored, keeping the order", () => {
        expect(withExclusions(["com.apple.Notes"], ["com.apple.notes", "C:\\x\\Signal.exe", "Signal.exe"])).toEqual(["com.apple.Notes", "Signal.exe"]);
    });
});
