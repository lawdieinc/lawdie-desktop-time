import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KiwiClient, KiwiFailure } from "./kiwi";

afterEach(() => vi.restoreAllMocks());

describe("Kiwi request failures", () => {
    it.each(["headers", "body", "refusal body"] as const)("recognises its deadline while waiting for %s", async (phase) => {
        const controller = new AbortController();
        const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
        let ready!: () => void;
        const waiting = new Promise<void>((resolve) => { ready = resolve; });
        const server = createServer((_req, res) => {
            if (phase === "headers") ready();
            else {
                res.writeHead(phase === "body" ? 200 : 401, { "Content-Type": "application/json" });
                res.write('{"ok":'); // Headers arrive, but the body never finishes.
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Expected a local server port");
            const send = vi.fn<typeof fetch>(async (url, init) => {
                const response = await fetch(url, init);
                if (phase !== "headers") {
                    const read = response.text.bind(response);
                    vi.spyOn(response, "text").mockImplementation(() => {
                        const result = read();
                        ready();
                        return result;
                    });
                }
                return response;
            });
            const client = new KiwiClient(`http://127.0.0.1:${address.port}`, "t", send, 120_000);
            const result = client.hello();
            await waiting;
            // Fire the client's own deadline at a known phase, without timing races.
            const reason = new DOMException("The operation was aborted due to timeout", "TimeoutError");
            controller.abort(reason);
            const failure = await result.catch((err: unknown) => err);
            expect(failure).toBeInstanceOf(KiwiFailure);
            expect(failure).toMatchObject({ code: "timeout", message: "The request to Kiwi timed out." });
            expect((failure as KiwiFailure).cause).toBeInstanceOf(Error);
            if (phase === "headers") expect((failure as KiwiFailure).cause).toBe(reason);
            // Fetch implementations may report a body abort as AbortError or the signal's reason.
            else expect(["AbortError", "TimeoutError"]).toContain(((failure as KiwiFailure).cause as Error).name);
            expect(deadline).toHaveBeenCalledWith(120_000);
            expect(send).toHaveBeenCalledTimes(1);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
        }
    });

    it.each([
        new TypeError("fetch failed", { cause: new Error("connection reset") }),
        new DOMException("An unrelated timeout", "TimeoutError"),
        new DOMException("An unrelated abort", "AbortError"),
    ])("keeps a fetch failure distinct from its own deadline: $name", async (cause) => {
        const send = vi.fn<typeof fetch>().mockRejectedValue(cause);
        await expect(new KiwiClient("https://k.test", "t", send).hello()).rejects.toMatchObject({
            code: "transport", message: `Could not reach Kiwi: ${cause.message}`, cause,
        });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it.each([200, 401])("keeps a broken response stream distinct from malformed JSON (status %s)", async (status) => {
        const cause = new TypeError("terminated", { cause: new Error("connection reset") });
        const stream = new ReadableStream({ start(controller) { controller.error(cause); } });
        const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status }));
        await expect(new KiwiClient("https://k.test", "t", send).hello()).rejects.toMatchObject({ code: "transport", cause });
    });

    it.each(["not JSON: private response content", ""])("recognises malformed JSON without exposing its content: %j", async (body) => {
        const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
        const failure = await new KiwiClient("https://k.test", "t", send).hello().catch((err: unknown) => err);
        expect(failure).toBeInstanceOf(KiwiFailure);
        expect(failure).toMatchObject({ code: "bad_response", message: "Kiwi answered in a way this app does not understand." });
        // JSON.parse's SyntaxError may quote the response. It must not become a report's cause.
        expect((failure as KiwiFailure).cause).toBeUndefined();
    });

    it.each([
        [401, '{"code":"device_revoked"}', "device_revoked"],
        [401, '{"code":"invalid_device_token"}', "invalid_token"],
        [401, "not JSON", "invalid_token"],
        [401, "null", "invalid_token"],
        [413, "", "too_large"],
        [503, "", "migration_pending"],
        [500, "", "http"],
    ] as const)("preserves the refusal for status %s and body %j", async (status, body, code) => {
        const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
        await expect(new KiwiClient("https://k.test", "t", send).hello()).rejects.toMatchObject({ code, status: status === 500 ? 500 : undefined });
    });

    it("names the destination for a CRM timeout", async () => {
        const controller = new AbortController();
        controller.abort(new DOMException("Deadline expired", "TimeoutError"));
        vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
        const send = vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason);
        await expect(new KiwiClient("https://crm.test", "t", send, 30_000, "Lawdie CRM").hello()).rejects.toMatchObject({
            code: "timeout", message: "The request to Lawdie CRM timed out.", cause: controller.signal.reason,
        });
    });
});
