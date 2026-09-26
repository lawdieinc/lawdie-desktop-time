/* The two calls the app makes to Kiwi. Plain fetch, no Electron, so it runs in the main
   process and under vitest alike. The token comes from the caller (main/sync.ts keeps it
   encrypted with safeStorage); it is never part of the workspace. */

import type { SyncRequest } from "./model";

export const DEFAULT_SERVER_URL = "https://lawdie.co/kiwi-api";

export type HelloResponse = { ok: boolean; device: { id: string; name: string }; user: { email: string | null } };
export type SyncResponse = { ok: boolean; activities: number; entries: number; deleted: number };

export type KiwiFailureCode = "invalid_server_url" | "invalid_token" | "device_revoked" | "migration_pending" | "too_large" | "http" | "transport" | "bad_response";

export class KiwiFailure extends Error {
    constructor(public code: KiwiFailureCode, message: string) {
        super(message);
        this.name = "KiwiFailure";
    }
}

const MESSAGES: Record<Exclude<KiwiFailureCode, "http" | "transport">, string> = {
    invalid_server_url: "Enter the Kiwi server address, such as https://lawdie.co/kiwi-api.",
    invalid_token: "Kiwi did not accept this token. Connect this computer again from Kiwi's Time page and paste the new token.",
    device_revoked: "This computer was disconnected in Kiwi. Connect it again from Kiwi's Time page to resume syncing.",
    migration_pending: "Kiwi is not ready for desktop sync yet (its database migration is pending).",
    too_large: "Kiwi refused the sync as too large. Try again; the app sends it in smaller pieces.",
    bad_response: "Kiwi answered in a way this app does not understand.",
};

/** An http(s) URL with a host, without a trailing slash, or null. */
export function normalizeServerURL(text: string): string | null {
    const trimmed = text.trim().replace(/\/+$/, "");
    try {
        const url = new URL(trimmed);
        if (!["http:", "https:"].includes(url.protocol) || !url.host) return null;
        return trimmed;
    } catch {
        return null;
    }
}

export class KiwiClient {
    readonly baseURL: string;
    constructor(serverURL: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 30_000) {
        const url = normalizeServerURL(serverURL);
        if (!url) throw new KiwiFailure("invalid_server_url", MESSAGES.invalid_server_url);
        this.baseURL = url;
    }

    hello(): Promise<HelloResponse> {
        return this.send<HelloResponse>("GET", "desktop-time/hello");
    }

    sync(request: SyncRequest): Promise<SyncResponse> {
        return this.send<SyncResponse>("POST", "desktop-time/sync", request);
    }

    private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
        let response: Response;
        try {
            response = await this.fetchImpl(`${this.baseURL}/${path}`, {
                method,
                headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            throw new KiwiFailure("transport", `Could not reach Kiwi: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (response.ok) {
            try {
                return (await response.json()) as T;
            } catch {
                throw new KiwiFailure("bad_response", MESSAGES.bad_response);
            }
        }
        if (response.status === 401) {
            const code = await response.json().then((j) => (j as { code?: string }).code).catch(() => undefined);
            if (code === "device_revoked") throw new KiwiFailure("device_revoked", MESSAGES.device_revoked);
            throw new KiwiFailure("invalid_token", MESSAGES.invalid_token);
        }
        if (response.status === 413) throw new KiwiFailure("too_large", MESSAGES.too_large);
        if (response.status === 503) throw new KiwiFailure("migration_pending", MESSAGES.migration_pending);
        throw new KiwiFailure("http", `Kiwi answered with an unexpected status (${response.status}).`);
    }
}
