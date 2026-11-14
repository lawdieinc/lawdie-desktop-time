import { describe, expect, it } from "vitest";
import { DOWNLOAD_URL, IMAGE_BASE, UNSUBSCRIBE_PLACEHOLDER, emailsIn, itemBody, newsletterFor } from "./newsletter";
import { LATEST_RELEASE, type Release } from "./releases";

const release: Release = {
    id: "9.1.0",
    date: "2026-11-09",
    title: "Faster <review> & more",
    intro: "Two things changed.",
    items: [
        { icon: "clock", title: "Approve", description: "Keep a row as shown.", more: "Approve keeps the row \"as shown\"." },
        { icon: "matter", title: "Matters", description: "Move time between matters." },
    ],
};

describe("the newsletter", () => {
    it("says more than the card: the intro and an item's paragraph, else its one line", () => {
        const n = newsletterFor(release);
        expect(n.subject).toBe("Lawdie Time Capture 9.1.0: Faster <review> & more");
        expect(n.name).toBe("Time Capture 9.1.0");
        expect(n.preheader).toBe("Two things changed.");
        expect(itemBody(release.items[0])).toBe('Approve keeps the row "as shown".');
        expect(itemBody(release.items[1])).toBe("Move time between matters.");
        expect(n.text).toContain("9 November 2026");
        expect(n.text).toContain("Two things changed.");
        expect(n.text).toContain('1. Approve\nApprove keeps the row "as shown".');
        expect(n.text).toContain("2. Matters\nMove time between matters.");
        expect(n.text).not.toContain("Keep a row as shown.");
    });

    it("escapes what it prints in the HTML", () => {
        const { html } = newsletterFor(release);
        expect(html).toContain("Faster &lt;review&gt; &amp; more");
        expect(html).toContain("&quot;as shown&quot;");
        expect(html).not.toContain("<review>");
    });

    it("always carries an unsubscribe link, Resend's own unless one is given, and the download", () => {
        const n = newsletterFor(release);
        expect(n.html).toContain(`href="${UNSUBSCRIBE_PLACEHOLDER}"`);
        expect(n.text).toContain(`Unsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}`);
        expect(n.html).toContain(`href="${DOWNLOAD_URL}"`);
        const preview = newsletterFor(release, { unsubscribeURL: "#unsubscribe", address: "1 Main St, Atlanta" });
        expect(preview.html).toContain('href="#unsubscribe"');
        expect(preview.html).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
        expect(preview.html).toContain("1 Main St, Atlanta");
        expect(preview.text).toContain("1 Main St, Atlanta");
    });

    it("stands without an intro, opening on the items' titles", () => {
        const n = newsletterFor({ ...release, intro: undefined });
        expect(n.preheader).toBe("Approve · Matters");
        expect(n.text).not.toContain("Two things changed.");
    });

    it("shows the brand mark and the release's picture, read from the repo unless a preview says where", () => {
        const plain = newsletterFor(release);
        expect(plain.images).toEqual([`${IMAGE_BASE}/kiwi.png`]);
        expect(plain.html).not.toContain("Exhibit A");
        const pictured = { ...release, picture: { file: "9.1.0-review.jpg", alt: 'The "review" screen', label: "To review" } };
        const n = newsletterFor(pictured);
        expect(n.images).toEqual([`${IMAGE_BASE}/kiwi.png`, `${IMAGE_BASE}/9.1.0-review.jpg`]);
        expect(n.html).toContain(`src="${IMAGE_BASE}/9.1.0-review.jpg"`);
        expect(n.html).toContain('alt="The &quot;review&quot; screen"');
        expect(n.html).toContain("Exhibit A");
        expect(newsletterFor(pictured, { imageBase: "../pictures/" }).images).toEqual(["../pictures/kiwi.png", "../pictures/9.1.0-review.jpg"]);
    });

    it("numbers the items and sets the title's last word apart", () => {
        const { html } = newsletterFor(release);
        expect(html).toContain(">01</td>");
        expect(html).toContain(">02</td>");
        expect(html).toMatch(/Faster &lt;review&gt; &amp; <span[^>]*>more<\/span>/);
    });

    it("has an intro and a paragraph for every item of the newest release", () => {
        expect(LATEST_RELEASE.intro?.length).toBeGreaterThan(40);
        for (const item of LATEST_RELEASE.items) expect(item.more?.length ?? 0).toBeGreaterThan(item.description.length);
    });

    it("reads addresses from a list or a CSV, each once", () => {
        expect(emailsIn("email,name\nAnn@Firm.com,Ann\n\nbob@firm.co.uk\nann@firm.com\nnot an address\n")).toEqual(["ann@firm.com", "bob@firm.co.uk"]);
    });
});
