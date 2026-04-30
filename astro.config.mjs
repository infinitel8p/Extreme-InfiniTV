// @ts-check
import { defineConfig } from "astro/config"
import tailwindcss from "@tailwindcss/vite"
import { optimizeTablerIconsImport } from "./src/plugins/vite-plugin-optimize-tabler-icons.ts"
import svelte from "@astrojs/svelte"

const hmrHost = process.env.XTREAM_HMR_HOST

export default defineConfig({
  vite: {
    plugins: [tailwindcss(), optimizeTablerIconsImport()],
    server: {
      host: "0.0.0.0",
      port: 4321,
      hmr: hmrHost
        ? { host: hmrHost, protocol: "ws", port: 4321 }
        : undefined,
    },
    build: {
      chunkSizeWarningLimit: 800,
    },
    optimizeDeps: {
      include: [
        "@tauri-apps/api/app",
        "@tauri-apps/plugin-process",
        "@tauri-apps/plugin-updater",
        "@tauri-apps/plugin-http",
        "@tauri-apps/plugin-fs",
        "@tauri-apps/plugin-dialog",
        "tauri-plugin-android-fs-api",
      ],
    },
  },

  integrations: [svelte()],
})
