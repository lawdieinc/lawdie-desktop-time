/* The two calls the app makes to its sync destination — Kiwi, or Lawdie CRM; both answer
   the same paths under their own API base with the same device token. Plain fetch, no
   Electron, so it runs in the main process and under vitest alike. The token comes from
   the caller (main/sync.ts keeps it encrypted with safeStorage); it is never part of the
   workspace. */

import type { SyncRequest } from "./model";

/** The two products kept time can go to. */
export type Product = "kiwi" | "crm";
/** What the person chooses in Settings: one product, or both with the one token. */
export type Destination = Product | "both";

export const PRODUCTS: Record<Product, { label: string; defaultServerURL: string; pairHint: string }> = {
    kiwi: {
        label: "Kiwi",
        defaultServerURL: "https://lawdie.co/kiwi-api",
        pairHint: "In Kiwi, open Time → Captured activity → On your desktop and click “Connect a computer”.",
    },
    crm: {
        label: "Lawdie CRM",
        defaultServerURL: "https://crm-api.lawdie.co/api",
        pairHint: "In Lawdie CRM, open Time → On your desktop and click “Connect a computer”.",
    },
};

export const DESTINATION_LABELS: Record<Destination, string> = { kiwi: "Kiwi", crm: "Lawdie CRM", both: "Both" };

export const isProduct = (value: unknown): value is Product => value === "kiwi" || value === "crm";
export const isDestination = (value: unknown): value is Destination => isProduct(value) || value === "both";
/** The products a destination means, in the order they sync. */
export const productsFor = (destination: Destination): Product[] => (destination === "both" ? ["kiwi", "crm"] : [destination]);
/** "Kiwi", "Lawdie CRM", or "Kiwi and Lawdie CRM" — the products in a sentence. */
export const destinationLabel = (products: readonly Product[]): string => {
    const names = [...new Set(products)].map((p) => PRODUCTS[p].label);
    return names.length ? names.join(" and ") : PRODUCTS.kiwi.label;
};
/** Where to paste a token from, for a destination. A token from either Time page works for both. */
export const pairHint = (destination: Destination): string =>
    destination === "both"
        ? "In Kiwi or Lawdie CRM, open the Time page and click “Connect a computer”; the token it shows is registered with both."
        : PRODUCTS[destination].pairHint;

export const DEFAULT_SERVER_URL = PRODUCTS.kiwi.defaultServerURL;

export type HelloResponse = { ok: boolean; device: { id: string; name: string }; user: { email: string | null } };
export type SyncResponse = { ok: boolean; activities: number; entries: number; deleted: number };

export type KiwiFailureCode = "invalid_server_url" | "invalid_token" | "device_revoked" | "migration_pending" | "too_large" | "http" | "transport" | "bad_response";

export class KiwiFailure extends Error {
    constructor(public code: KiwiFailureCode, message: string) {
        super(message);
        this.name = "KiwiFailure";
    }
}

const messages = (product: string): Record<Exclude<KiwiFailureCode, "http" | "transport">, string> => ({
    invalid_server_url: `Enter the ${product} server address, such as ${product === "Kiwi" ? PRODUCTS.kiwi.defaultServerURL : PRODUCTS.crm.defaultServerURL}.`,
    invalid_token: `${product} did not accept this token. Connect this computer again from the Time page there and paste the new token.`,
    device_revoked: `This computer was disconnected in ${product}. Connect it again from the Time page there to resume syncing.`,
    migration_pending: `${product} is not ready for desktop sync yet (its database migration is pending).`,
    too_large: `${product} refused the sync as too large. Try again; the app sends it in smaller pieces.`,
    bad_response: `${product} answered in a way this app does not understand.`,
});

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
    private readonly messages: ReturnType<typeof messages>;
    /** `product` names the destination in every message: "Kiwi" or "Lawdie CRM". */
    constructor(serverURL: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 30_000, readonly product = "Kiwi") {
        this.messages = messages(product);
        const url = normalizeServerURL(serverURL);
        if (!url) throw new KiwiFailure("invalid_server_url", this.messages.invalid_server_url);
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
            throw new KiwiFailure("transport", `Could not reach ${this.product}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (response.ok) {
            try {
                return (await response.json()) as T;
            } catch {
                throw new KiwiFailure("bad_response", this.messages.bad_response);
            }
        }
        if (response.status === 401) {
            const code = await response.json().then((j) => (j as { code?: string }).code).catch(() => undefined);
            if (code === "device_revoked") throw new KiwiFailure("device_revoked", this.messages.device_revoked);
            throw new KiwiFailure("invalid_token", this.messages.invalid_token);
        }
        if (response.status === 413) throw new KiwiFailure("too_large", this.messages.too_large);
        if (response.status === 503) throw new KiwiFailure("migration_pending", this.messages.migration_pending);
        throw new KiwiFailure("http", `${this.product} answered with an unexpected status (${response.status}).`);
    }
}
