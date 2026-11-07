import { describe, expect, it } from "vitest";
import { CONTEXT_KEYS, MAX_PER_GROUP_HOUR, cleanNotice, createGroupBudget, featuresOn, fingerprintOf, firstFrame, framesOf, parseQueue, scrubCauses, scrubText, type NoticeLike } from "./errorReport";

describe("error reports", () => {
    it("scrubs what could name a person, a file or a secret", () => {
        expect(scrubText("ENOENT: /Users/jane/Documents/Clients/Acme/Lease v3.docx not found")).toBe("ENOENT: ~/Documents/Clients/Acme/Lease v3.docx not found");
        expect(scrubText("EPERM: C:\\Users\\Jane Doe\\AppData\\x")).toBe("EPERM: ~\\AppData\\x");
        expect(scrubText("mail to jane@acme.com failed with 4a1b2c3d-1111-2222-3333-444455556666")).toBe("mail to <email> failed with <id>");
        expect(scrubText("token sk_live_abcdefghijkl and Bearer abcdefghijklmnop")).toBe("token [redacted] and Bearer [redacted]");
        expect(scrubText("deadbeefdeadbeefdeadbeef on port 54321   now")).toBe("<hex> on port <n> now");
        expect(scrubText("x".repeat(900)).length).toBe(500);
    });
    it("keeps only the frames of a stack and names a group by its first one", () => {
        const stack = "Error: /Users/jane/secret.docx\n    at keepStretch (/Users/jane/app/out/main/index.js:120:5)\n    at Object.<anonymous> (/x/y.js:1:1)";
        expect(framesOf(stack)).toBe("at keepStretch (~/app/out/main/index.js:<n>:5)\nat Object.<anonymous> (/x/y.js:1:1)");
        expect(firstFrame(stack)).toBe("at keepStretch index.js");
        expect(framesOf(undefined)).toBeUndefined();
        expect(framesOf("no frames here")).toBeUndefined();
        expect(fingerprintOf("store", { name: "TypeError", message: "x is not a function at 12345", stack })).toBe("store\nTypeError\nat keepStretch index.js\nx is not a function at <n>");
        // Two releases, one bug: the path changes, the group does not.
        expect(firstFrame(stack.replace("/Users/jane/app", "/Applications/App.app/Contents"))).toBe(firstFrame(stack));
    });
    it("follows causes three deep, scrubbed, frames only", () => {
        const deepest = Object.assign(new Error("four jane@x.com"), { cause: new Error("five") });
        const err = new Error("top", { cause: Object.assign(new Error("two /Users/jane/f"), { cause: Object.assign(new Error("three"), { cause: deepest }) }) });
        const c = scrubCauses(err)!;
        expect([c.message, c.cause?.message, c.cause?.cause?.message, c.cause?.cause?.cause]).toEqual(["two ~/f", "three", "four <email>", undefined]);
        expect(c.stack?.split("\n").every((l) => l.startsWith("at "))).toBe(true);
        expect(scrubCauses(new Error("alone"))).toBeUndefined();
    });
    it("lets ten notices a group an hour through, then none until the next hour", () => {
        let t = 0;
        const ok = createGroupBudget(MAX_PER_GROUP_HOUR, () => t);
        for (let i = 0; i < 10; i++) expect(ok("a")).toBe(true);
        expect(ok("a")).toBe(false);
        expect(ok("b")).toBe(true);
        t = 3_600_001;
        expect(ok("a")).toBe(true);
    });
    it("strips a notice to the scrubbed message, frames, causes and allowed context", () => {
        const notice: NoticeLike = {
            message: "boom /Users/jane/x", stack: "Error: boom\n    at f (/Users/jane/a.js:1:2)", originalError: new Error("boom", { cause: new Error("why jane@x.com") }),
            backtrace: [{ file: "/Users/jane/app/out/main/index.js", method: "f", number: 1, column: 2, source: { "1": "const secret = 1" } }],
            details: { row: "secret" }, context: { scope: "store", version: "0.14.0", title: "Secret.docx", install: "4a1b2c3d-1111-2222-3333-444455556666", source: "desktop" }, params: { a: 1 }, session: { s: 1 }, headers: { h: 1 }, cookies: { c: 1 }, cgiData: { HOME: "/Users/jane" }, url: "file:///x",
        };
        cleanNotice(notice);
        expect(notice.message).toBe("boom ~/x");
        expect(notice.stack).toBe("at f (~/a.js:1:2)");
        expect((notice.cause as { message: string }).message).toBe("why <email>");
        expect(notice.context).toEqual({ scope: "store", version: "0.14.0", install: "4a1b2c3d-1111-2222-3333-444455556666", source: "desktop" });
        expect(notice.backtrace).toEqual([{ file: "~/app/out/main/index.js", method: "f", number: 1, column: 2, source: undefined }]);
        expect(Object.keys(notice.context!).every((k) => (CONTEXT_KEYS as readonly string[]).includes(k))).toBe(true);
        expect([notice.details, notice.params, notice.session, notice.headers, notice.cookies, notice.cgiData, notice.url]).toEqual([{}, {}, {}, {}, {}, {}, undefined]);
    });
    it("names the switches that are on", () => {
        expect(featuresOn({ captureEnabled: true, captureTitles: true, suggestMatters: true }, ["kiwi"])).toBe("capture,titles,ai,sync:kiwi");
        expect(featuresOn({})).toBe("none");
    });
    it("reads a queue file, torn last line and all, keeping the last fifty", () => {
        const line = (n: number) => JSON.stringify({ at: "t", scope: "s", name: "Error", message: `m${n}`, context: {} });
        const text = Array.from({ length: 60 }, (_, n) => line(n)).join("\n") + "\n{\"scope\":\"s\",\"mess";
        const q = parseQueue(text);
        expect(q.length).toBe(50);
        expect(q[0].message).toBe("m10");
        expect(parseQueue("")).toEqual([]);
    });
});
