import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { load, JSON_SCHEMA } from "js-yaml";

// Keep in step with electron-builder.yml. Both Mac architectures need a zip for
// the updater as well as the dmg offered on the download page.
const channels = {
    "latest-mac.yml": [
        "Lawdie-Time-Capture-mac-arm64.dmg",
        "Lawdie-Time-Capture-mac-arm64.zip",
        "Lawdie-Time-Capture-mac-x64.dmg",
        "Lawdie-Time-Capture-mac-x64.zip",
    ],
    "latest.yml": ["Lawdie-Time-Capture-windows-setup.exe"],
    "latest-linux.yml": ["Lawdie-Time-Capture-linux.AppImage"],
};
const installers = Object.values(channels).flat();
const required = [
    ...Object.keys(channels), ...installers,
    ...installers.filter((name) => !name.endsWith(".AppImage")).map((name) => `${name}.blockmap`),
];

/** Read-only: no release is created unless every platform's output is complete. */
export async function validateArtifacts(directory, tag, version) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) {
        throw new Error(`Release tag ${tag} must match the stable package version v${version}`);
    }
    const names = await readdir(directory);
    for (const name of required) {
        if (!names.includes(name)) throw new Error(`Missing release artifact: ${name}`);
    }
    if (names.some((name) => !required.includes(name))) throw new Error("Unexpected release artifacts");

    const assets = [];
    for (const name of required) {
        const file = join(directory, name);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size === 0) throw new Error(`Empty or non-file artifact: ${name}`);
        const sha512 = createHash("sha512");
        const sha256 = createHash("sha256");
        for await (const chunk of createReadStream(file)) { sha512.update(chunk); sha256.update(chunk); }
        assets.push({ name, size: stat.size, sha512: sha512.digest("base64"), digest: `sha256:${sha256.digest("hex")}` });
    }
    for (const [name, expected] of Object.entries(channels)) {
        const info = load(await readFile(join(directory, name), "utf8"), { schema: JSON_SCHEMA });
        if (info?.version !== version) throw new Error(`Wrong version in ${name}`);
        if (!Array.isArray(info.files) || info.files.length !== expected.length || info.packages != null) {
            throw new Error(`Invalid files in ${name}`);
        }
        const seen = new Set();
        for (const file of info.files) {
            // Only exact local filenames from this platform: no URLs, traversal or
            // references into another platform's output, even when that file exists.
            if (!file || !expected.includes(file.url) || seen.has(file.url)) throw new Error(`Invalid reference in ${name}`);
            seen.add(file.url);
            const asset = assets.find((asset) => asset.name === file.url);
            if (file.sha512 !== asset.sha512) throw new Error(`Checksum mismatch for ${file.url} in ${name}`);
            if (file.size != null && file.size !== asset.size) throw new Error(`Size mismatch for ${file.url} in ${name}`);
        }
        const legacy = info.files.find((file) => file.url === info.path);
        if (!legacy || info.sha512 !== legacy.sha512) throw new Error(`Invalid legacy path/checksum in ${name}`);
    }
    return assets;
}

/** Called only by the dependent release job. Upload failures leave a draft. */
export async function publishRelease({ github, repo, directory, tag, version }) {
    const assets = await validateArtifacts(directory, tag, version);
    let release;
    try {
        ({ data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag }));
    } catch (err) {
        if (err.status !== 404) throw err;
    }
    if (release && !release.draft) throw new Error(`Refusing to modify published release ${tag}`);
    if (!release) {
        ({ data: release } = await github.rest.repos.createRelease({
            ...repo, tag_name: tag, name: tag, draft: true, generate_release_notes: true,
        }));
    }
    const release_id = release.id;
    // Start a draft retry from a clean set; never mix assets from different builds.
    const previous = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id, per_page: 100 });
    for (const asset of previous) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
    for (const asset of assets) {
        await github.rest.repos.uploadReleaseAsset({
            ...repo, release_id, name: asset.name,
            headers: { "content-type": "application/octet-stream", "content-length": asset.size },
            data: await readFile(join(directory, asset.name)),
        });
    }
    // GitHub's stored bytes must agree too. Do not expose a partial or damaged
    // upload, even if the upload API returned without throwing.
    const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id, per_page: 100 });
    if (uploaded.length !== assets.length || assets.some((asset) => !uploaded.some((remote) =>
        remote.name === asset.name && remote.state === "uploaded" && remote.size === asset.size && remote.digest === asset.digest))) {
        throw new Error(`Uploaded assets do not match the validated artifacts; ${tag} remains a draft`);
    }
    await github.rest.repos.updateRelease({ ...repo, release_id, draft: false, prerelease: false, make_latest: "true" });
}
