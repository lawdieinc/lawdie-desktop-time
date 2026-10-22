// Builds the macOS helpers into resources/bin, each one binary for Apple silicon and
// Intel: screen-text, the accessibility reader (native/screen-text), and mic-users, which
// says who is recording (native/mic-users, for calls). A no-op off macOS (Windows asks
// through PowerShell and the registry, nothing to build) and for a binary newer than its source.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";

if (process.platform !== "darwin") process.exit(0);
mkdirSync("resources/bin", { recursive: true });
for (const name of ["screen-text", "mic-users"]) {
    const src = `native/${name}/main.swift`, out = `resources/bin/${name}`;
    if (existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs && process.argv[2] !== "--force") continue;
    const parts = ["arm64", "x86_64"].map((arch) => {
        const part = `resources/bin/${name}-${arch}`;
        execFileSync("swiftc", ["-O", "-target", `${arch}-apple-macos11`, src, "-o", part], { stdio: "inherit" });
        return part;
    });
    execFileSync("lipo", ["-create", ...parts, "-output", out], { stdio: "inherit" });
    for (const p of parts) rmSync(p);
    console.log(`built ${out}`);
}
