/* The firm's logo from its website, for the invoice letterhead (2026-11-04). Pure: given the
   home page's HTML, the image addresses worth trying, best first. The main process fetches
   them in order and keeps the first that decodes to a picture at least LOGO_MIN_PX wide.

   What a site offers, roughly in order of how much it looks like a logo: an apple-touch-icon
   (a square PNG of the mark, 180 px), the Open Graph or Twitter image (a wide card that often
   is the logo on a background, sometimes a photo), an `icon` link with a size, then the
   well-known paths a site has without declaring them. An SVG cannot be decoded here, so it
   is skipped; so is a data: URL. */

export const LOGO_MIN_PX = 48;

/** "lawdie.co", "https://www.lawdie.co/about" → "https://www.lawdie.co": the site a person typed, as a page address. */
export function siteURL(typed: string): string | null {
    const t = typed.trim().replace(/^(https?:)?\/\//i, "").replace(/\/.*$/, "").toLowerCase();
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? `https://${t}` : null;
}

/** The image addresses the page names, best first, absolute, each once. */
export function logoCandidates(html: string, base: string): string[] {
    const out: { url: string; rank: number }[] = [];
    const add = (href: string | undefined, rank: number): void => {
        if (!href) return;
        const raw = href.trim().replace(/&amp;/g, "&");
        if (/^data:/i.test(raw) || /\.svg(\?|#|$)/i.test(raw)) return;
        try {
            const url = new URL(raw, base).toString();
            if (!/^https?:/.test(url) || out.some((o) => o.url === url)) return;
            out.push({ url, rank });
        } catch { /* not an address */ }
    };
    const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(2).find((v) => v !== undefined);
    for (const tag of html.match(/<(link|meta)\b[^>]*>/gi) ?? []) {
        const rel = (attr(tag, "rel") ?? "").toLowerCase(), prop = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
        if (/apple-touch-icon/.test(rel)) add(attr(tag, "href"), 0);
        else if (prop === "og:image" || prop === "og:image:url" || prop === "og:image:secure_url") add(attr(tag, "content"), 1);
        else if (prop === "twitter:image" || prop === "twitter:image:src") add(attr(tag, "content"), 2);
        else if (/\bicon\b/.test(rel)) {
            const size = Number((attr(tag, "sizes") ?? "").match(/(\d+)x/)?.[1] ?? 0);
            add(attr(tag, "href"), size >= LOGO_MIN_PX ? 3 : 5);
        }
    }
    for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/logo.png", "/favicon.png", "/favicon.ico"]) add(path, 4);
    return out.sort((a, b) => a.rank - b.rank).map((o) => o.url);
}
