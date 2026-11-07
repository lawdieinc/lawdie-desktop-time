import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Bundles are not minified: error reports (src/main/errors.ts) carry stack frames, and
// readable frames need no source map upload. A desktop app does not care about the bytes.
export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        resolve: { alias: { "@shared": resolve("src/shared") } },
        // The Honeybadger key, from the release workflow's secret; empty anywhere else, so nothing is sent.
        define: { __HONEYBADGER_API_KEY__: JSON.stringify(process.env.HONEYBADGER_API_KEY ?? "") },
        build: { minify: false },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        resolve: { alias: { "@shared": resolve("src/shared") } },
        build: { minify: false },
    },
    renderer: {
        plugins: [react()],
        resolve: { alias: { "@shared": resolve("src/shared"), "@renderer": resolve("src/renderer/src") } },
        build: { minify: false },
    },
});
