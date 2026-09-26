import type { api } from "./index";

declare global {
    interface Window {
        lawdie: typeof api;
    }
}

export {};
