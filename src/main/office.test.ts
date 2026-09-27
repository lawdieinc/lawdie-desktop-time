import { describe, expect, it } from "vitest";
import { OfficeProbe, PROBE_CACHE_MS, officeApp, parseProbeOutput } from "./office";

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
        expect(parseProbeOutput("NAME=Re: settlement\r\nPATH=\r\nTEXT=Adam Brookman — Re: settlement — Hi,\r\n")).toEqual({
            name: "Re: settlement",
            path: null,
            excerpt: "Adam Brookman — Re: settlement — Hi,",
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
