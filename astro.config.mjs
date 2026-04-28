// @ts-check
import { defineConfig } from "astro/config"
import tailwindcss from "@tailwindcss/vite"
import { optimizeTablerIconsImport } from "./src/plugins/vite-plugin-optimize-tabler-icons.ts"
import svelte from "@astrojs/svelte"

// Optionally pin HMR to a specific LAN host (useful for testing the dev server
// from a phone / TV on the same network). Set XTREAM_HMR_HOST=192.168.x.y in
// .env or your shell to enable; otherwise Vite picks the right host itself.
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
      rollupOptions: {
        external: ["@tauri-apps/plugin-process", "@tauri-apps/plugin-updater"],
      },
    },
  },

  integrations: [svelte()],
})
