// @ts-check
import { defineConfig } from "astro/config"
import tailwindcss from "@tailwindcss/vite"
import mdx from "@astrojs/mdx"
import { rehypeDocLinks } from "./src/plugins/rehype-doc-links.mjs"
import { BASE } from "./site-base.mjs"

export default defineConfig({
  site: "https://infinitel8p.github.io",
  base: BASE,
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
  integrations: [mdx()],
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    rehypePlugins: [[rehypeDocLinks, { base: BASE }]],
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" },
      wrap: true,
    },
  },
})
