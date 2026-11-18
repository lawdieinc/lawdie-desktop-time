/**
 * The apps installed on this computer, for Settings → Capture → "Apps that stay private" (src/shared/appExclusions.ts).
 * macOS: the .app bundles in the Applications folders, named and identified from their Info.plist. Windows: the Start
 * menu's shortcuts and the programs they open. Linux: the .desktop files and their Exec. Worked out once a run.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { app, dialog, nativeImage, shell, type BrowserWindow } from "electron";
import type { AppChoice } from "@shared/appExclusions";

const plistJSON = (file: string): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => {
        execFile("plutil", ["-convert", "json", "-o", "-", file], { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => {
            if (err) { resolve(null); return; }
            try { resolve(JSON.parse(out) as Record<string, unknown>); } catch { resolve(null); }
        });
    });

/** A Mac .app bundle as an app: its bundle id and the name Finder shows. */
export async function macBundle(path: string): Promise<AppChoice | null> {
    const info = await plistJSON(join(path, "Contents", "Info.plist"));
    const id = typeof info?.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : null;
    if (!id) return null;
    // Finder's name is the bundle's file name; the plist's is only for a bundle named oddly.
    const plistName = [info?.CFBundleDisplayName, info?.CFBundleName].find((n): n is string => typeof n === "string" && !!n.trim());
    return { id, name: basename(path, ".app") || plistName || id, path };
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const listDir = (dir: string): string[] => { try { return readdirSync(dir).map((n) => join(dir, n)); } catch { return []; } };

async function macApps(): Promise<AppChoice[]> {
    const dirs = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices/Applications", join(homedir(), "Applications")];
    const bundles: string[] = [];
    for (const dir of dirs) for (const p of listDir(dir)) {
        if (p.endsWith(".app")) bundles.push(p);
        else if (dir === "/Applications" && isDir(p)) for (const q of listDir(p)) if (q.endsWith(".app")) bundles.push(q); // a vendor folder
    }
    const out: AppChoice[] = [];
    for (let i = 0; i < bundles.length; i += 16) out.push(...(await Promise.all(bundles.slice(i, i + 16).map(macBundle))).filter((a): a is AppChoice => !!a));
    return out;
}

function windowsApps(): AppChoice[] {
    const roots = [join(process.env.ProgramData ?? "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"), join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs")];
    const out: AppChoice[] = [];
    const walk = (dir: string, depth: number): void => {
        for (const p of listDir(dir)) {
            if (p.toLowerCase().endsWith(".lnk")) {
                try {
                    const target = shell.readShortcutLink(p).target;
                    if (target && target.toLowerCase().endsWith(".exe") && !/uninst/i.test(target)) out.push({ id: basename(target), name: basename(p, ".lnk"), path: target });
                } catch { /* not a program shortcut */ }
            } else if (depth < 2 && isDir(p)) walk(p, depth + 1);
        }
    };
    for (const r of roots) walk(r, 0);
    return out;
}

function linuxApps(): AppChoice[] {
    const dirs = ["/usr/share/applications", "/usr/local/share/applications", join(homedir(), ".local", "share", "applications"), "/var/lib/flatpak/exports/share/applications"];
    const out: AppChoice[] = [];
    for (const dir of dirs) for (const p of listDir(dir)) {
        if (!p.endsWith(".desktop")) continue;
        try {
            const text = readFileSync(p, "utf8");
            const entry = text.split(/\n\[/)[0];
            if (/^NoDisplay=true/m.test(entry) || /^Type=(?!Application)/m.test(entry)) continue;
            const name = entry.match(/^Name=(.+)$/m)?.[1]?.trim();
            const exec = entry.match(/^Exec=(.+)$/m)?.[1]?.trim().split(/\s+/)[0]?.replace(/^"|"$/g, "");
            if (name && exec && !exec.includes("=")) out.push({ id: basename(exec), name, path: exec.startsWith("/") ? exec : null });
        } catch { /* unreadable */ }
    }
    return out;
}

let cached: Promise<AppChoice[]> | null = null;

/** Installed apps, once a run. A failure is an empty list: the apps captured and "Choose an app…" still work. */
export function installedApps(): Promise<AppChoice[]> {
    cached ??= (async () => {
        try {
            if (process.platform === "darwin") return await macApps();
            if (process.platform === "win32") return windowsApps();
            return linuxApps();
        } catch { return []; }
    })();
    return cached;
}

const icons = new Map<string, string | null>();

/** An app's icon as a data URL, small, or null. */
export async function appIcon(path: string): Promise<string | null> {
    if (icons.has(path)) return icons.get(path) ?? null;
    let url: string | null = null;
    try {
        if (existsSync(path)) {
            // macOS: getFileIcon gives a .app bundle the generic icon; Quick Look's thumbnail is the app's own.
            const img = process.platform === "darwin" ? await nativeImage.createThumbnailFromPath(path, { width: 64, height: 64 }) : await app.getFileIcon(path, { size: "large" });
            url = img.isEmpty() ? null : img.resize({ width: 32, height: 32, quality: "best" }).toDataURL();
        }
    } catch { url = null; }
    icons.set(path, url);
    return url;
}

/** "Choose an app file…": a .app on macOS, a program elsewhere. */
export async function chooseApp(parent: BrowserWindow | null): Promise<AppChoice | null> {
    const mac = process.platform === "darwin";
    const options: Electron.OpenDialogOptions = {
        title: "Choose an app to keep private",
        defaultPath: mac ? "/Applications" : undefined,
        properties: ["openFile"],
        filters: mac ? [{ name: "Apps", extensions: ["app"] }] : process.platform === "win32" ? [{ name: "Programs", extensions: ["exe"] }] : [],
    };
    const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const file = res.filePaths[0];
    if (res.canceled || !file) return null;
    if (mac) return macBundle(file.replace(/(\.app)\/.*$/, "$1"));
    return { id: basename(file), name: basename(file).replace(/\.exe$/i, ""), path: file };
}
