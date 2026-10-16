// Builds resources/bin/screen-text, the macOS accessibility reader (native/screen-text),
// as one binary for Apple silicon and Intel. A no-op off macOS (Windows reads the screen
// through PowerShell, nothing to build) and when the binary is newer than its source.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";

if (process.platform !== "darwin") process.exit(0);
const src = "native/screen-text/main.swift", out = "resources/bin/screen-text";
if (existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs && process.argv[2] !== "--force") process.exit(0);
mkdirSync("resources/bin", { recursive: true });
const parts = ["arm64", "x86_64"].map((arch) => {
    const part = `resources/bin/screen-text-${arch}`;
    execFileSync("swiftc", ["-O", "-target", `${arch}-apple-macos11`, src, "-o", part], { stdio: "inherit" });
    return part;
});
execFileSync("lipo", ["-create", ...parts, "-output", out], { stdio: "inherit" });
for (const p of parts) rmSync(p);
console.log(`built ${out}`);
