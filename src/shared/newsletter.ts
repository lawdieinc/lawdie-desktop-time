/* The app-updates email (2026-11-13): one release from `releases.ts` as a newsletter, a little longer than the
   What's new card (the release's `intro`, each item's `more`, its `picture`). Pure: `newsletterFor()` gives the
   subject, the HTML and the plain text; `scripts/newsletter.mjs` hands them to Resend, which owns the list, the
   sending and the unsubscribe page. Laid out on espresso and cream: a dark top with the title very large, the
   release's picture across the line where dark meets cream, the items as numbered sections (an item's own picture
   under its words), one download button. The HTML is email HTML on purpose: tables and inline styles in the
   brand's colours (docs/brand.md), since mail clients drop most stylesheets; the fonts fall back to Georgia and
   Arial where a client will not load them. The pictures are files in `docs/newsletter/`, read by the mail client
   from this public repo (`IMAGE_BASE`), so they show only once that folder is pushed. */

import { releaseDateLabel, type Release } from "./releases";

/** Resend puts each recipient's own unsubscribe link here when it sends a broadcast. */
export const UNSUBSCRIBE_PLACEHOLDER = "{{{RESEND_UNSUBSCRIBE_URL}}}";

/** Always the newest release's page, with every installer. */
export const DOWNLOAD_URL = "https://github.com/lawdieinc/lawdie-desktop-time/releases/latest";

/** `docs/newsletter/` on main, as anyone's mail client can fetch it. */
export const IMAGE_BASE = "https://raw.githubusercontent.com/lawdieinc/lawdie-desktop-time/main/docs/newsletter";

/** The brand mark in the header, a file in `docs/newsletter/`. */
export const MARK_FILE = "lawdie-mark.png";

export type NewsletterOptions = {
    /** Where "Download" goes. */
    downloadURL?: string;
    /** The unsubscribe link; the Resend placeholder unless a preview stands in for it. */
    unsubscribeURL?: string;
    /** The sender's postal address, printed in the footer when given. */
    address?: string;
    /** Where the pictures are read from; a preview points at the folder itself. */
    imageBase?: string;
};

export type Newsletter = {
    /** Resend's internal name for the broadcast. */
    name: string;
    subject: string;
    /** The line a mail client shows after the subject. */
    preheader: string;
    html: string;
    text: string;
    /** Every picture the HTML shows, as the address it is read from. */
    images: string[];
};

const COLOR = { page: "#F3F0E8", cream: "#F9F6F2", card: "#FFFFFF", espresso: "#3D3731", taupe: "#7C7366", sand: "#D8D1C7", gold: "#8B5C2A", rule: "#5F5850" };
const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS = "'Source Sans 3', 'Source Sans Pro', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'Fragment Mono', Menlo, Consolas, monospace";
const FONTS = "https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Playfair+Display:ital,wght@0,600;0,800;1,600&family=Source+Sans+3:wght@400;600&display=swap";

const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What an item says in the email: its paragraph, else the card's one line. */
export const itemBody = (item: Release["items"][number]): string => item.more?.trim() || item.description;

/** The headline: the title with its last word in italic over a brown-gold line. */
function headline(title: string): string {
    const words = title.trim().split(/\s+/);
    const last = words.pop() ?? "";
    const lead = words.length ? `${esc(words.join(" "))} ` : "";
    return `${lead}<span style="font-style:italic;border-bottom:6px solid ${COLOR.gold};">${esc(last)}</span>`;
}

export function newsletterFor(release: Release, options: NewsletterOptions = {}): Newsletter {
    const download = options.downloadURL ?? DOWNLOAD_URL;
    const unsubscribe = options.unsubscribeURL ?? UNSUBSCRIBE_PLACEHOLDER;
    const address = options.address?.trim();
    const base = (options.imageBase ?? IMAGE_BASE).replace(/\/+$/, "");
    const date = releaseDateLabel(release.date);
    const intro = release.intro?.trim();
    const preheader = intro ?? release.items.map((i) => i.title).join(" · ");
    const subject = `Lawdie Time Capture ${release.id}: ${release.title}`;
    const why = "You are getting this because you use Lawdie Time Capture.";
    const mark = `${base}/${MARK_FILE}`;
    const picture = release.picture ? { ...release.picture, src: `${base}/${release.picture.file}` } : null;
    const images = [mark, ...(picture ? [picture.src] : [])];
    const mono = `font-family:${MONO};text-transform:uppercase;`;
    // "0.18.0" reads as "V 0.18" beside the name; a patch release keeps its last number.
    const version = release.id.replace(/\.0$/, "");

    const items = release.items
        .map((item, i) => {
            const rule = i === release.items.length - 1 ? "" : `border-bottom:1px solid ${COLOR.sand};`;
            const src = item.picture ? `${base}/${item.picture.file}` : null;
            if (src) images.push(src);
            return `
          <tr>
            <td class="nl-no" width="76" valign="top" style="width:76px;padding:40px 0;${rule}font-family:${MONO};font-size:34px;line-height:40px;color:${COLOR.gold};">${String(i + 1).padStart(2, "0")}</td>
            <td valign="top" style="padding:40px 0;${rule}">
              <h2 class="nl-h2" style="margin:0 0 14px 0;font-family:${SERIF};font-size:32px;line-height:38px;font-weight:600;letter-spacing:-0.4px;color:${COLOR.espresso};">${esc(item.title)}</h2>
              <p style="margin:0;font-family:${SANS};font-size:17px;line-height:27px;color:${COLOR.espresso};">${esc(itemBody(item))}</p>${
                  src ? `
              <img src="${esc(src)}" width="468" alt="${esc(item.picture?.alt ?? "")}" style="display:block;width:100%;max-width:468px;height:auto;margin:20px 0 0 0;border:1px solid ${COLOR.sand};border-radius:10px;">` : ""
              }
            </td>
          </tr>`;
        })
        .join("");

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
<link rel="stylesheet" href="${FONTS}">
<style>
@media (max-width: 520px) {
  .nl-pad { padding-left: 22px !important; padding-right: 22px !important; }
  .nl-top { padding-top: 40px !important; padding-bottom: 40px !important; }
  .nl-h1 { font-size: 52px !important; line-height: 54px !important; letter-spacing: -1.4px !important; }
  .nl-h1 span { border-bottom-width: 4px !important; }
  .nl-intro { font-size: 18px !important; line-height: 28px !important; }
  .nl-no { width: 46px !important; font-size: 22px !important; }
  .nl-h2 { font-size: 26px !important; line-height: 31px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLOR.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page};">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:${COLOR.cream};">

      <tr><td class="nl-pad" bgcolor="${COLOR.espresso}" style="background:${COLOR.espresso};padding:28px 48px;border-bottom:1px solid ${COLOR.rule};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="52" valign="middle" style="width:52px;"><img src="${esc(mark)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border:0;"></td>
          <td valign="middle" style="font-family:${SERIF};font-size:26px;line-height:30px;font-weight:800;letter-spacing:-0.3px;color:${COLOR.cream};">Lawdie</td>
          <td valign="middle" align="right" style="${mono}font-size:12px;line-height:16px;letter-spacing:2px;color:${COLOR.sand};">Time Capture · V ${esc(version)}</td>
        </tr></table>
      </td></tr>

      <tr><td class="nl-pad nl-top" bgcolor="${COLOR.espresso}" style="background:${COLOR.espresso};padding:64px 48px 56px 48px;">
        <p style="margin:0 0 22px 0;${mono}font-size:13px;line-height:18px;letter-spacing:3px;color:${COLOR.sand};">What's new · ${esc(date)}</p>
        <h1 class="nl-h1" style="margin:0;font-family:${SERIF};font-size:84px;line-height:84px;font-weight:600;letter-spacing:-2.6px;color:${COLOR.cream};">${headline(release.title)}</h1>${
            intro ? `
        <p class="nl-intro" style="margin:34px 0 0 0;font-family:${SANS};font-size:20px;line-height:31px;color:${COLOR.sand};">${esc(intro)}</p>` : ""
        }
      </td></tr>${
          picture ? `

      <tr><td class="nl-pad" align="center" bgcolor="${COLOR.cream}" style="background:${COLOR.cream};background-image:linear-gradient(${COLOR.espresso} 0%,${COLOR.espresso} 46%,${COLOR.cream} 46%,${COLOR.cream} 100%);padding:0 48px;">
        <img src="${esc(picture.src)}" width="544" alt="${esc(picture.alt)}" style="display:block;width:100%;max-width:544px;height:auto;border:1px solid ${COLOR.sand};border-radius:12px;">
      </td></tr>` : ""
      }

      <tr><td class="nl-pad" style="padding:12px 48px 0 48px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}
        </table>
      </td></tr>

      <tr><td class="nl-pad" style="padding:8px 48px 0 48px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" bgcolor="${COLOR.gold}" style="background:${COLOR.gold};border-radius:8px;">
            <a href="${esc(download)}" style="display:block;padding:18px 24px;font-family:${SANS};font-size:18px;line-height:22px;font-weight:600;color:${COLOR.cream};text-decoration:none;">Download the latest version</a>
          </td></tr>
          <tr><td align="center" style="padding:14px 0 0 0;${mono}font-size:11px;line-height:16px;letter-spacing:2px;color:${COLOR.taupe};">macOS · Windows · Linux</td></tr>
        </table>
      </td></tr>

      <tr><td class="nl-pad" style="padding:36px 48px 44px 48px;font-family:${SANS};font-size:14px;line-height:22px;color:${COLOR.taupe};">
        ${esc(why)} <a href="${esc(unsubscribe)}" style="color:${COLOR.gold};text-decoration:underline;">Unsubscribe</a>${address ? `<br>${esc(address)}` : ""}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`;

    const text = [
        `Lawdie Time Capture ${release.id} · ${date}`,
        "",
        release.title,
        ...(intro ? ["", intro] : []),
        ...release.items.flatMap((item, i) => ["", `${i + 1}. ${item.title}`, itemBody(item)]),
        "",
        `Download the latest version: ${download}`,
        "",
        why,
        `Unsubscribe: ${unsubscribe}`,
        ...(address ? [address] : []),
        "",
    ].join("\n");

    return { name: `Time Capture ${release.id}`, subject, preheader, html, text, images };
}

/** The addresses in a pasted list or a CSV export: one a line (the first on it), lower-cased, each once. */
export function emailsIn(source: string): string[] {
    const found = new Set<string>();
    for (const line of source.split(/\r?\n/)) {
        const m = line.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
        if (m) found.add(m[0].toLowerCase());
    }
    return [...found];
}
