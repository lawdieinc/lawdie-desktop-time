import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

/* Start at login. An OS setting, not a workspace preference: it belongs to this user account
   on this machine, and the OS is the source of truth (a person can remove the login item in
   System Settings or Task Manager without the app knowing). Windows and Linux launch with
   `--login`; macOS cannot pass arguments to a login item and reports it as wasOpenedAtLogin. */

const LOGIN_FLAG = "--login";
const linuxAutostart = (): string => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "lawdie-time-capture.desktop");

export function openAtLogin(): boolean {
    if (process.platform === "linux") return existsSync(linuxAutostart());
    return app.getLoginItemSettings({ args: [LOGIN_FLAG] }).openAtLogin;
}

export function setOpenAtLogin(on: boolean): void {
    if (process.platform === "linux") {
        const file = linuxAutostart();
        if (!on) { rmSync(file, { force: true }); return; }
        // An AppImage runs from a temporary mount; $APPIMAGE is the file that survives a reboot.
        const exec = process.env.APPIMAGE ?? process.execPath;
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Lawdie Time Capture\nExec="${exec}" ${LOGIN_FLAG}\nX-GNOME-Autostart-enabled=true\n`);
        return;
    }
    app.setLoginItemSettings({ openAtLogin: on, args: [LOGIN_FLAG] });
}

export function launchedAtLogin(): boolean {
    return process.argv.includes(LOGIN_FLAG) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true);
}
