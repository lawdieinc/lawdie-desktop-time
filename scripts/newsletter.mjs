#!/usr/bin/env node
/* The app-updates newsletter, sent through Resend (AGENTS.md "Newsletter"). The email itself is
   src/shared/newsletter.ts; this script only carries it.

     npm run newsletter -- preview [version]        the email as files in out/newsletter/ (no key needed)
     npm run newsletter -- draft [version]          a draft broadcast in Resend; nothing is sent
     npm run newsletter -- send <broadcast id>      sends that draft to the segment, after asking
                                  [--at "<time>"]   ... or schedules it ("in 1 hour", or ISO 8601)
     npm run newsletter -- contacts <file>          adds the file's addresses to the segment (new ones only)

   A version defaults to the newest release in src/shared/releases.ts. The email's pictures are the files in
   docs/newsletter/: `preview` reads them from the folder, `draft` refuses until they answer on GitHub (pushed).

   Environment (`npm run newsletter` reads a `.env` file at the repo root, which git ignores):
     RESEND_API_KEY       draft, send, contacts
     RESEND_SEGMENT_ID    draft, contacts: the segment the newsletter goes to
     NEWSLETTER_FROM      draft: e.g. "Lawdie <updates@lawdie.ai>", on a domain verified in Resend
     NEWSLETTER_REPLY_TO  draft, optional
     NEWSLETTER_ADDRESS   optional: the postal address printed in the footer

   There is no test send in Resend's API: after `draft`, open the broadcast in Resend's dashboard and press
   "Test Email", then `send` it. A contact Resend already has is never touched, so someone who unsubscribed
   is not subscribed again by a later `contacts` run. */

import { build } from "esbuild";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.resend.com";

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

/** The pure modules, bundled from TypeScript in memory. */
async function shared() {
    const out = await build({
        stdin: {
            contents: `export * from "./newsletter"; export { RELEASES, LATEST_RELEASE } from "./releases";`,
            resolveDir: join(root, "src/shared"),
            loader: "ts",
        },
        bundle: true,
        format: "esm",
        platform: "node",
        write: false,
        logLevel: "silent",
    });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

const env = (name) => process.env[name]?.trim() || fail(`${name} is not set.`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** One Resend call; a rate limit (10 a second per team) is waited out. */
async function resend(method, path, body) {
    const key = env("RESEND_API_KEY");
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(API + path, {
            method,
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "newsletter-script/1" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 429 && attempt < 5) {
            await sleep((Number(res.headers.get("retry-after")) || 1) * 1000);
            continue;
        }
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            /* not JSON: the status says enough */
        }
        return { ok: res.ok, status: res.status, json, message: json?.message ?? text.slice(0, 200) };
    }
}

async function releaseFor(lib, version) {
    if (!version) return lib.LATEST_RELEASE;
    return lib.RELEASES.find((r) => r.id === version) ?? fail(`No release ${version} in src/shared/releases.ts.`);
}

async function preview(version) {
    const lib = await shared();
    const release = await releaseFor(lib, version);
    // The pictures straight from docs/newsletter/, so the preview needs no push.
    const n = lib.newsletterFor(release, { unsubscribeURL: "#unsubscribe", address: process.env.NEWSLETTER_ADDRESS, imageBase: "../../docs/newsletter" });
    const dir = join(root, "out/newsletter");
    await mkdir(dir, { recursive: true });
    for (const image of n.images) await access(resolve(dir, image)).catch(() => fail(`Missing picture: ${resolve(dir, image)}`));
    await writeFile(join(dir, `${release.id}.html`), n.html);
    await writeFile(join(dir, `${release.id}.txt`), n.text);
    console.log(`Subject: ${n.subject}`);
    console.log(join(dir, `${release.id}.html`));
    console.log(join(dir, `${release.id}.txt`));
}

async function draft(version) {
    const lib = await shared();
    const release = await releaseFor(lib, version);
    const n = lib.newsletterFor(release, { address: process.env.NEWSLETTER_ADDRESS });
    // A mail client reads the pictures from the public repo: no draft until each one answers there.
    for (const image of n.images) {
        const got = await fetch(image, { method: "HEAD" }).catch(() => null);
        if (!got?.ok) fail(`A picture is not public yet (${got?.status ?? "no answer"}): ${image}\nPush docs/newsletter/ to main first.`);
    }
    const replyTo = process.env.NEWSLETTER_REPLY_TO?.trim();
    const res = await resend("POST", "/broadcasts", {
        segment_id: env("RESEND_SEGMENT_ID"),
        from: env("NEWSLETTER_FROM"),
        subject: n.subject,
        name: n.name,
        html: n.html,
        text: n.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
    });
    if (!res.ok) fail(`Resend refused the draft (${res.status}): ${res.message}`);
    console.log(`Draft made, nothing sent: ${n.subject}`);
    console.log(`  Broadcast id: ${res.json.id}`);
    console.log(`  Test it: https://resend.com/broadcasts/${res.json.id} → Test Email`);
    console.log(`  Then:    npm run newsletter -- send ${res.json.id}`);
}

async function send(id, args) {
    if (!id) fail("Which broadcast? npm run newsletter -- send <broadcast id>");
    const at = args.includes("--at") ? args[args.indexOf("--at") + 1] : undefined;
    if (args.includes("--at") && !at) fail('--at needs a time: --at "in 1 hour"');
    const found = await resend("GET", `/broadcasts/${encodeURIComponent(id)}`);
    if (!found.ok) fail(`Resend does not know broadcast ${id} (${found.status}): ${found.message}`);
    console.log(`Broadcast: ${found.json?.name ?? id}`);
    if (found.json?.subject) console.log(`Subject:   ${found.json.subject}`);
    console.log(at ? `Scheduled: ${at}` : "Sends now, to everyone subscribed in its segment. It cannot be recalled.");
    if (!args.includes("--yes")) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('Type "send" to go ahead: ');
        rl.close();
        if (answer.trim().toLowerCase() !== "send") fail("Not sent.");
    }
    const res = await resend("POST", `/broadcasts/${encodeURIComponent(id)}/send`, at ? { scheduled_at: at } : {});
    if (!res.ok) fail(`Resend refused to send (${res.status}): ${res.message}`);
    console.log(at ? "Scheduled." : "Sent.");
}

async function contacts(file) {
    if (!file) fail("Which file? npm run newsletter -- contacts <file with one address a line, or a CSV>");
    const lib = await shared();
    const emails = lib.emailsIn(await readFile(resolve(file), "utf8"));
    if (emails.length === 0) fail(`No addresses in ${file}.`);
    const segment = env("RESEND_SEGMENT_ID");
    let added = 0;
    const known = [];
    const failed = [];
    for (const email of emails) {
        // A contact Resend has is left exactly as it is: it may have unsubscribed.
        const existing = await resend("GET", `/contacts/${encodeURIComponent(email)}`);
        if (existing.ok) known.push(email);
        else if (existing.status !== 404) failed.push(`${email}: ${existing.status} ${existing.message}`);
        else {
            const made = await resend("POST", "/contacts", { email, segments: [{ id: segment }] });
            if (made.ok) added++;
            else failed.push(`${email}: ${made.status} ${made.message}`);
        }
        await sleep(250);
    }
    console.log(`${emails.length} addresses: ${added} added, ${known.length} already in Resend and left as they were, ${failed.length} failed.`);
    for (const line of failed) console.log(`  ${line}`);
    if (failed.length) process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const first = args.find((a) => !a.startsWith("--"));
if (command === "preview") await preview(first);
else if (command === "draft") await draft(first);
else if (command === "send") await send(first, args);
else if (command === "contacts") await contacts(first);
else fail("Usage: npm run newsletter -- preview [version] | draft [version] | send <broadcast id> [--at <time>] | contacts <file>");
