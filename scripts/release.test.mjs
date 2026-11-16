import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dump, load } from "js-yaml";
import { publishRelease, validateArtifacts } from "./release.mjs";

const version = "0.18.3";
const tag = `v${version}`;
const mac = ["arm64", "x64"].flatMap((arch) => ["dmg", "zip"].map((ext) => `Lawdie-Time-Capture-mac-${arch}.${ext}`));
const windows = "Lawdie-Time-Capture-windows-setup.exe";
const linux = "Lawdie-Time-Capture-linux.AppImage";
const manifests = { "latest-mac.yml": mac, "latest.yml": [windows], "latest-linux.yml": [linux] };
let directory;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lawdie-release-"));
    for (const [manifest, names] of Object.entries(manifests)) {
        const files = [];
        for (const name of names) {
            const data = Buffer.from(`Installer bytes for ${name}`);
            await writeFile(join(directory, name), data);
            if (name !== linux) await writeFile(join(directory, `${name}.blockmap`), "block map");
            files.push({ url: name, sha512: createHash("sha512").update(data).digest("base64"), size: data.length });
        }
        // electron-builder emits the legacy path/sha512 alongside files[].
        await writeFile(join(directory, manifest), dump({ version, files, path: files[0].url, sha512: files[0].sha512 }));
    }
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const validate = () => validateArtifacts(directory, tag, version);
async function changeManifest(name, edit) {
    const info = load(await readFile(join(directory, name), "utf8"));
    edit(info);
    await writeFile(join(directory, name), dump(info));
}

describe("release artifact validation", () => {
    it("accepts complete electron-builder metadata for both Macs, NSIS and AppImage", async () => {
        const assets = await validate();
        expect(assets).toHaveLength(14);
        expect(assets.every((asset) => asset.digest.startsWith("sha256:") && asset.size > 0)).toBe(true);
        // Older builder output may omit size; sha512 is always required.
        await changeManifest("latest.yml", (info) => { delete info.files[0].size; });
        await expect(validate()).resolves.toHaveLength(14);
    });

    it.each([
        ...Object.keys(manifests), ...mac, windows, linux,
        ...[...mac, windows].map((name) => `${name}.blockmap`),
    ])("rejects a missing %s", async (name) => {
        await rm(join(directory, name));
        await expect(validate()).rejects.toThrow(`Missing release artifact: ${name}`);
    });

    it("rejects the incident's Linux-only output", async () => {
        for (const name of [...mac, windows, "latest.yml", "latest-mac.yml"]) await rm(join(directory, name));
        await expect(validate()).rejects.toThrow("Missing release artifact");
    });

    it.each(["v0.18.2", "v0.18.3-beta.1", "0.18.3"])("rejects mismatched/unsupported tag %s", async (otherTag) => {
        await expect(validateArtifacts(directory, otherTag, version)).rejects.toThrow("must match the stable package version");
    });

    it.each([
        ["wrong version", (info) => { info.version = "0.18.2"; }],
        ["missing files", (info) => { delete info.files; }],
        ["missing Mac architecture", (info) => { info.files.pop(); }],
        ["duplicate file", (info) => { info.files[1] = info.files[0]; }],
        ["nonexistent file", (info) => { info.files[0].url = "missing.zip"; }],
        ["external URL", (info) => { info.files[0].url = `https://example.com/${mac[0]}`; }],
        ["path traversal", (info) => { info.files[0].url = `../${mac[0]}`; }],
        ["cross-platform file", (info) => { info.files[0].url = windows; }],
        ["missing checksum", (info) => { delete info.files[0].sha512; }],
        ["wrong checksum", (info) => { info.files[0].sha512 = "not the checksum"; }],
        ["wrong size", (info) => { info.files[0].size += 1; }],
        ["bad legacy path", (info) => { info.path = "missing.zip"; }],
        ["bad legacy checksum", (info) => { info.sha512 = "wrong"; }],
        ["unexpected package references", (info) => { info.packages = { x64: { path: "missing.7z" } }; }],
    ])("rejects metadata with %s", async (_reason, edit) => {
        await changeManifest("latest-mac.yml", edit);
        await expect(validate()).rejects.toThrow();
    });

    it("detects corrupted installer bytes", async () => {
        await writeFile(join(directory, windows), "corrupted installer");
        await expect(validate()).rejects.toThrow("Checksum mismatch");
    });

    it("rejects empty artifacts, directories, malformed YAML and unexpected files", async () => {
        const original = await readFile(join(directory, windows));
        await writeFile(join(directory, windows), "");
        await expect(validate()).rejects.toThrow("Empty or non-file");
        await rm(join(directory, windows));
        await mkdir(join(directory, windows));
        await expect(validate()).rejects.toThrow("Empty or non-file");
        await rm(join(directory, windows), { recursive: true });
        await writeFile(join(directory, windows), original);
        await writeFile(join(directory, "latest.yml"), "files: [\n");
        await expect(validate()).rejects.toThrow();
        await writeFile(join(directory, "stale.exe"), "old installer");
        await expect(validate()).rejects.toThrow("Unexpected release artifacts");
    });
});

/** Fake only GitHub's API, with real on-disk validation and upload buffers. */
function githubMock(existing) {
    let remote = [];
    const repos = {
        getReleaseByTag: vi.fn(async () => {
            if (!existing) throw Object.assign(new Error("Not found"), { status: 404 });
            return { data: existing };
        }),
        createRelease: vi.fn(async () => ({ data: { id: 42, draft: true } })),
        listReleaseAssets: vi.fn(),
        deleteReleaseAsset: vi.fn(async () => {}),
        uploadReleaseAsset: vi.fn(async ({ name, data }) => {
            remote.push({ name, state: "uploaded", size: data.length, digest: `sha256:${createHash("sha256").update(data).digest("hex")}` });
        }),
        updateRelease: vi.fn(async () => {}),
    };
    const github = { rest: { repos }, paginate: vi.fn(async () => remote) };
    const publish = () => publishRelease({ github, repo: { owner: "lawdieinc", repo: "lawdie-desktop-time" }, directory, tag, version });
    return { github, repos, publish, get remote() { return remote; } };
}

describe("draft publication gate", () => {
    it("validates before creating a draft, then uploads and verifies before publishing", async () => {
        const { repos, publish, github } = githubMock();
        await publish();
        expect(repos.createRelease).toHaveBeenCalledWith(expect.objectContaining({ tag_name: tag, draft: true }));
        expect(repos.uploadReleaseAsset).toHaveBeenCalledTimes(14);
        expect(github.paginate).toHaveBeenCalledTimes(2);
        expect(repos.updateRelease).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ release_id: 42, draft: false, prerelease: false, make_latest: "true" }));
        expect(repos.updateRelease.mock.invocationCallOrder[0]).toBeGreaterThan(github.paginate.mock.invocationCallOrder[1]);
    });

    it("never contacts GitHub for incomplete builds", async () => {
        const { repos, publish } = githubMock();
        await rm(join(directory, "latest.yml"));
        await expect(publish()).rejects.toThrow("Missing release artifact");
        expect(repos.getReleaseByTag).not.toHaveBeenCalled();
        expect(repos.createRelease).not.toHaveBeenCalled();
    });

    it("refuses to modify an existing public release", async () => {
        const { repos, publish } = githubMock({ id: 42, draft: false });
        await expect(publish()).rejects.toThrow("Refusing to modify published release");
        expect(repos.createRelease).not.toHaveBeenCalled();
        expect(repos.deleteReleaseAsset).not.toHaveBeenCalled();
        expect(repos.uploadReleaseAsset).not.toHaveBeenCalled();
        expect(repos.updateRelease).not.toHaveBeenCalled();
    });

    it("propagates authorization/server errors without trying to create a release", async () => {
        const { repos, publish } = githubMock();
        repos.getReleaseByTag.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
        await expect(publish()).rejects.toThrow("Forbidden");
        expect(repos.createRelease).not.toHaveBeenCalled();
    });

    it("replaces all assets in an existing draft before retrying uploads", async () => {
        const { repos, publish, github } = githubMock({ id: 42, draft: true });
        github.paginate.mockResolvedValueOnce([{ id: 7, name: "stale.exe" }, { id: 8, name: windows }]);
        await publish();
        expect(repos.createRelease).not.toHaveBeenCalled();
        expect(repos.deleteReleaseAsset.mock.calls.map(([args]) => args.asset_id)).toEqual([7, 8]);
        expect(repos.uploadReleaseAsset.mock.invocationCallOrder[0]).toBeGreaterThan(repos.deleteReleaseAsset.mock.invocationCallOrder[1]);
        expect(repos.updateRelease).toHaveBeenCalledOnce();
    });

    it("keeps the draft unpublished if an upload fails partway through", async () => {
        const { repos, publish } = githubMock();
        repos.uploadReleaseAsset.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Upload failed"));
        await expect(publish()).rejects.toThrow("Upload failed");
        expect(repos.createRelease).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
        expect(repos.updateRelease).not.toHaveBeenCalled();
    });

    it.each(["missing", "size", "digest", "state", "extra"])("keeps the draft unpublished for a %s remote asset mismatch", async (fault) => {
        const mock = githubMock();
        mock.github.paginate.mockImplementationOnce(async () => []).mockImplementationOnce(async () => {
            const remote = mock.remote;
            if (fault === "missing") return remote.slice(1);
            if (fault === "extra") return [...remote, { name: "stale.exe" }];
            remote[0][fault] = fault === "size" ? 1 : "invalid";
            return remote;
        });
        await expect(mock.publish()).rejects.toThrow("remains a draft");
        expect(mock.repos.updateRelease).not.toHaveBeenCalled();
    });
});

it("gates the workflow on every matrix build and gives only the final job write access", async () => {
    const workflow = load(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "release-${{ inputs.tag || github.ref_name }}", "cancel-in-progress": false });
    const { build, publish } = workflow.jobs;
    expect(Object.keys(workflow.jobs)).toEqual(["build", "publish"]);
    expect(build.permissions).toBeUndefined();
    expect(build.strategy["fail-fast"]).toBe(false);
    expect(build.strategy.matrix.include.map((entry) => entry.target)).toEqual(["mac", "win", "linux"]);
    expect(publish.needs).toBe("build");
    expect(publish.if).toBeUndefined(); // default success(): a failed/cancelled matrix child skips publication
    expect(publish.permissions).toEqual({ contents: "write" });
    expect(build.steps.some((step) => step.uses === "actions/upload-artifact@v4")).toBe(true);
    expect(build.steps.some((step) => /gh-release|github-script/.test(step.uses ?? ""))).toBe(false);
    expect(publish.steps.find((step) => step.uses === "actions/download-artifact@v4").with).toMatchObject({ pattern: "release-*", "merge-multiple": true });
    expect(publish.steps.at(-1).with.script).toContain("await publishRelease(");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const target of ["mac", "win", "linux"]) expect(pkg.scripts[`package:${target}`]).toContain("--publish never");
    const config = load(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
    expect(config.mac.target).toEqual([{ target: "dmg", arch: ["arm64", "x64"] }, { target: "zip", arch: ["arm64", "x64"] }]);
    expect(config.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(config.linux.target).toEqual(["AppImage"]);
    // Ensure the workflow collects every file required by validation.
    for (const platform of build.strategy.matrix.include) {
        const manifest = { mac: "latest-mac.yml", win: "latest.yml", linux: "latest-linux.yml" }[platform.target];
        const names = manifests[manifest];
        const expected = [manifest, ...names, ...names.filter((name) => name !== linux).map((name) => `${name}.blockmap`)];
        const patterns = platform.assets.trim().split("\n").map((pattern) => new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`));
        expect(expected.every((name) => patterns.some((pattern) => pattern.test(`release/${name}`)))).toBe(true);
    }
});
