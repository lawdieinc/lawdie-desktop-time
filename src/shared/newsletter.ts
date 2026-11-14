/* The app-updates email (2026-11-13): one release from `releases.ts` as a newsletter, a little longer than the
   What's new card (the release's `intro`, each item's `more`, its `picture`). Pure: `newsletterFor()` gives the
   subject, the HTML and the plain text; `scripts/newsletter.mjs` hands them to Resend, which owns the list, the
   sending and the unsubscribe page. Laid out as a time sheet: release and date in the header, the picture as
   "Exhibit A", the items as numbered lines. The HTML is email HTML on purpose: tables and inline styles in the
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
export const MARK_FILE = "kiwi.png";

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

const COLOR = { page: "#F3F0E8", cream: "#F9F6F2", card: "#FFFFFF", espresso: "#3D3731", taupe: "#7C7366", sand: "#D8D1C7", gold: "#8B5C2A" };
const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS = "'Source Sans 3', 'Source Sans Pro', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'Fragment Mono', Menlo, Consolas, monospace";
const FONTS = "https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Playfair+Display:ital,wght@0,600;0,800;1,600&family=Source+Sans+3:wght@400;600&display=swap";

const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What an item says in the email: its paragraph, else the card's one line. */
export const itemBody = (item: Release["items"][number]): string => item.more?.trim() || item.description;

/** The headline: the title with its last word in italic brown-gold. */
function headline(title: string): string {
    const words = title.trim().split(/\s+/);
    const last = words.pop() ?? "";
    const lead = words.length ? `${esc(words.join(" "))} ` : "";
    return `${lead}<span style="font-style:italic;color:${COLOR.gold};">${esc(last)}</span>`;
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
    const label = `font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:${COLOR.taupe};`;

    const items = release.items
        .map((item, i) => {
            const last = i === release.items.length - 1;
            const rule = `border-bottom:1px solid ${last ? COLOR.espresso : COLOR.sand};`;
            return `
          <tr>
            <td width="52" valign="top" style="width:52px;padding:28px 0;${rule}font-family:${MONO};font-size:15px;line-height:32px;color:${COLOR.gold};">${String(i + 1).padStart(2, "0")}</td>
            <td valign="top" style="padding:28px 0;${rule}">
              <h2 style="margin:0 0 10px 0;font-family:${SERIF};font-size:27px;line-height:32px;font-weight:600;letter-spacing:-0.3px;color:${COLOR.espresso};">${esc(item.title)}</h2>
              <p style="margin:0;font-family:${SANS};font-size:16px;line-height:25px;color:${COLOR.espresso};">${esc(itemBody(item))}</p>
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
  .nl-outer { padding: 12px 8px 24px 8px !important; }
  .nl-pad { padding-left: 20px !important; padding-right: 20px !important; }
  .nl-h1 { font-size: 46px !important; line-height: 48px !important; letter-spacing: -1.2px !important; }
  .nl-intro { font-size: 17px !important; line-height: 27px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLOR.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page};">
  <tr><td class="nl-outer" align="center" style="padding:32px 16px 40px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:624px;">
      <tr><td style="background:${COLOR.card};border:1px solid ${COLOR.sand};">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td class="nl-pad" style="padding:34px 36px 26px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="58" valign="middle" style="width:58px;"><img src="${esc(mark)}" width="46" height="46" alt="" style="display:block;width:46px;height:46px;border:0;"></td>
              <td valign="middle">
                <div style="font-family:${SERIF};font-size:28px;line-height:30px;font-weight:800;letter-spacing:-0.3px;color:${COLOR.espresso};">Lawdie</div>
                <div style="font-family:${SANS};font-size:14px;line-height:18px;color:${COLOR.taupe};">Time Capture</div>
              </td>
              <td valign="middle" align="right" style="font-family:${MONO};font-size:11px;line-height:21px;letter-spacing:1.2px;text-transform:uppercase;color:${COLOR.espresso};white-space:nowrap;">
                <span style="color:${COLOR.taupe};">Release</span>&nbsp;&nbsp;${esc(release.id)}<br>
                <span style="color:${COLOR.taupe};">Date</span>&nbsp;&nbsp;${esc(date)}
              </td>
            </tr></table>
          </td></tr>
          <tr><td class="nl-pad" style="padding:0 36px;"><div style="border-top:3px solid ${COLOR.espresso};font-size:0;line-height:0;">&nbsp;</div></td></tr>

          <tr><td class="nl-pad" style="padding:34px 36px 0 36px;">
            <p style="margin:0 0 16px 0;font-family:${MONO};font-size:12px;line-height:16px;letter-spacing:3px;text-transform:uppercase;color:${COLOR.gold};">Statement of changes</p>
            <h1 class="nl-h1" style="margin:0;font-family:${SERIF};font-size:72px;line-height:70px;font-weight:600;letter-spacing:-2.2px;color:${COLOR.espresso};">${headline(release.title)}</h1>${
                intro ? `
            <p class="nl-intro" style="margin:24px 0 0 0;font-family:${SANS};font-size:19px;line-height:30px;color:${COLOR.espresso};">${esc(intro)}</p>` : ""
            }
          </td></tr>${
              picture ? `

          <tr><td class="nl-pad" style="padding:34px 36px 0 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding:0 0 10px 0;${label}">Exhibit A</td>
              <td align="right" style="padding:0 0 10px 0;${label}">${esc(picture.label ?? "")}</td>
            </tr></table>
            <img src="${esc(picture.src)}" width="550" alt="${esc(picture.alt)}" style="display:block;width:100%;max-width:550px;height:auto;border:1px solid ${COLOR.sand};">
          </td></tr>` : ""
          }

          <tr><td class="nl-pad" style="padding:38px 36px 0 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="52" style="width:52px;padding:10px 0;border-top:1px solid ${COLOR.espresso};border-bottom:1px solid ${COLOR.espresso};${label}">No.</td>
                <td style="padding:10px 0;border-top:1px solid ${COLOR.espresso};border-bottom:1px solid ${COLOR.espresso};${label}">What changed</td>
              </tr>${items}
            </table>
          </td></tr>

          <tr><td class="nl-pad" style="padding:32px 36px 36px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td align="center" bgcolor="${COLOR.gold}" style="background:${COLOR.gold};border-radius:8px;">
                <a href="${esc(download)}" style="display:block;padding:18px 24px;font-family:${SANS};font-size:18px;line-height:22px;font-weight:600;color:${COLOR.cream};text-decoration:none;">Download the latest version</a>
              </td></tr>
              <tr><td align="center" style="padding:14px 0 0 0;${label}">macOS · Windows · Linux</td></tr>
            </table>
          </td></tr>
        </table>

      </td></tr>
      <tr><td style="padding:24px 8px 0 8px;font-family:${SANS};font-size:14px;line-height:22px;color:${COLOR.espresso};">
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

    return { name: `Time Capture ${release.id}`, subject, preheader, html, text, images: [mark, ...(picture ? [picture.src] : [])] };
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
