import { describe, expect, it } from "vitest";
import { OfficeProbe, PROBE_CACHE_MS, officeApp, officeExcerpt, parseProbeOutput } from "./office";

describe("officeApp", () => {
    it("recognises the four Office apps by macOS bundle id and Windows executable", () => {
        expect(officeApp("com.microsoft.Word")).toBe("word");
        expect(officeApp("com.microsoft.Powerpoint")).toBe("powerpoint");
        expect(officeApp("com.microsoft.Outlook")).toBe("outlook");
        expect(officeApp("C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE")).toBe("word");
        expect(officeApp("C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE")).toBe("excel");
        expect(officeApp("C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE")).toBe("outlook");
        expect(officeApp("com.apple.Preview")).toBeNull();
        expect(officeApp("C:\\Windows\\notepad.exe")).toBeNull();
    });
});

describe("parseProbeOutput", () => {
    it("reads the NAME/PATH/TEXT lines a script prints, TEXT spanning lines", () => {
        const out = "NAME=Whitfield motion 2026-014.docx\nPATH=/Users/a/Documents/Whitfield motion 2026-014.docx\nTEXT=MEMORANDUM\rRe: Whitfield v. Meridian,   Matter 2026-014\n";
        expect(parseProbeOutput(out)).toEqual({
            name: "Whitfield motion 2026-014.docx",
            path: "/Users/a/Documents/Whitfield motion 2026-014.docx",
            excerpt: "MEMORANDUM Re: Whitfield v. Meridian, Matter 2026-014",
        });
    });

    it("reads Windows line endings and an email with no path", () => {
        expect(parseProbeOutput("NAME=Re: settlement\r\nPATH=\r\nTEXT=Adam Brookman · Re: settlement · Hi,\r\n")).toEqual({
            name: "Re: settlement",
            path: null,
            excerpt: "Adam Brookman · Re: settlement · Hi,",
        });
    });

    it("treats an unsaved document's name-as-path as no path", () => {
        expect(parseProbeOutput("NAME=Presentation1\nPATH=Presentation1\nTEXT=")).toEqual({ name: "Presentation1", path: null, excerpt: null });
        expect(parseProbeOutput("NAME=a.docx\nPATH=C:\\Users\\a\\a.docx\nTEXT=")?.path).toBe("C:\\Users\\a\\a.docx");
    });

    it("is null for nothing open, or output that is not the protocol", () => {
        expect(parseProbeOutput("")).toBeNull();
        expect(parseProbeOutput("\n")).toBeNull();
        expect(parseProbeOutput("execution error: Not authorized to send Apple events to Microsoft Word. (-1743)")).toBeNull();
        expect(parseProbeOutput("NAME=\nPATH=\nTEXT=")).toBeNull();
    });

    it("bounds the excerpt", () => {
        const out = `NAME=a.docx\nPATH=/a.docx\nTEXT=${"x".repeat(5000)}`;
        expect(parseProbeOutput(out)?.excerpt).toHaveLength(600);
    });
});

describe("OfficeProbe", () => {
    const doc = "NAME=a.docx\nPATH=/a.docx\nTEXT=hello";

    it("asks only Office apps, caches an answer, and asks again after the window", async () => {
        let calls = 0;
        const probe = new OfficeProbe(async () => { calls += 1; return doc; });
        expect(await probe.probe("com.apple.Preview", 0)).toBeNull();
        expect(calls).toBe(0);
        expect(await probe.probe("com.microsoft.Word", 0)).toMatchObject({ name: "a.docx" });
        expect(await probe.probe("com.microsoft.Word", 1000)).toMatchObject({ name: "a.docx" });
        expect(calls).toBe(1);
        await probe.probe("com.microsoft.Word", PROBE_CACHE_MS + 1);
        expect(calls).toBe(2);
    });

    it("reads a refusal or timeout as nothing, remembers why, and does not throw", async () => {
        const probe = new OfficeProbe(async () => { throw new Error("Not authorized to send Apple events to Microsoft Word. (-1743)"); });
        expect(await probe.probe("com.microsoft.Word")).toBeNull();
        expect(probe.lastError.get("word")).toMatch(/Not authorized/);
    });

    it("shares one in-flight ask between overlapping samples", async () => {
        let calls = 0;
        const probe = new OfficeProbe(() => new Promise((r) => { calls += 1; setTimeout(() => r(doc), 10); }));
        const [a, b] = await Promise.all([probe.probe("com.microsoft.Word", 0), probe.probe("com.microsoft.Word", 0)]);
        expect(a).toEqual(b);
        expect(calls).toBe(1);
    });

    it("does nothing on a platform without a runner", async () => {
        const probe = new OfficeProbe(null);
        expect(probe.supported).toBe(false);
        expect(await probe.probe("com.microsoft.Word")).toBeNull();
    });
});

describe("what is on screen, as one line (2026-11-22)", () => {
    it("Excel: the sheet, then each filled cell on screen with its address, from where the window is scrolled", () => {
        // As the Mac script prints it: sheet, the visible range's address, then rows of tab-separated cells (empty ones too).
        const raw = "Damages\n$C$10:$F$40\nClaimant\tAmount\t\t\nHarmon\t42,000\t\t\n\t\t\t\n\tTotal\t$57,950.50\t";
        expect(officeExcerpt("excel", raw)).toBe("Sheet “Damages” · C10 Claimant · D10 Amount · C11 Harmon · D11 42,000 · D13 Total · E13 $57,950.50");
        // Windows prints the address without dollars; columns past Z are two letters.
        expect(officeExcerpt("excel", "Q1\nY1:AB2\n\t\tx\ty")).toBe("Sheet “Q1” · AA1 x · AB1 y");
        expect(officeExcerpt("excel", "Only a sheet")).toBe("Sheet “Only a sheet”");
        const doc = parseProbeOutput("NAME=Damages.xlsx\nPATH=/Users/a/Damages.xlsx\nTEXT=Damages\nA1:B2\nClaimant\tAmount\nHarmon\t42000", "excel");
        expect(doc?.excerpt).toBe("Sheet “Damages” · A1 Claimant · B1 Amount · A2 Harmon · B2 42000");
    });

    it("PowerPoint: the slide on screen and its text; Word: the text around the cursor, paragraphs as spaces", () => {
        expect(officeExcerpt("powerpoint", "2/12\nDamages summary\nLost wages $42,000\rMedical $12,850.50")).toBe("Slide 2 of 12 · Damages summary · Lost wages $42,000 · Medical $12,850.50");
        expect(officeExcerpt("powerpoint", "")).toBe("");
        expect(parseProbeOutput("NAME=Motion.docx\nPATH=/Users/a/Motion.docx\nTEXT=MOTION TO COMPEL\rParagraph 4. Plaintiff requests", "word")?.excerpt).toBe("MOTION TO COMPEL Paragraph 4. Plaintiff requests");
    });

    it("bounds a long sheet to the excerpt limit", () => {
        const rows = Array.from({ length: 60 }, (_, i) => Array.from({ length: 26 }, (_, j) => `v${i}-${j}`).join("\t")).join("\n");
        expect(parseProbeOutput(`NAME=Big.xlsx\nPATH=/a/Big.xlsx\nTEXT=Big\nA1:Z60\n${rows}`, "excel")!.excerpt!.length).toBeLessThanOrEqual(600);
    });
});
