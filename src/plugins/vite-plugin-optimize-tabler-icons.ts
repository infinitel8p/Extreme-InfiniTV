import MagicString from "magic-string"
import type { Plugin } from "vite"

/**
 * Optimizes the import of Tabler Icons Svelte package by importing only the icons in the bundle that are used.
 * see https://github.com/tabler/tabler-icons/issues/669#issuecomment-1993756128
 *
 * @example
 * This
 * import { IconActivity, IconChevronDown } from "@tabler/icons-svelte";
 *
 * Will be transformed on build to
 * import IconActivity from "@tabler/icons-svelte/icons/activity";
 * import IconChevronDown from "@tabler/icons-svelte/icons/chevron-down";
 */
export function optimizeTablerIconsImport(): Plugin {
  return {
    name: "tabler-svelte-optimizer",
    transform(code, id) {
      const ms = new MagicString(code, { filename: id })

      ms.replace(
        /([ \t]*)import\s+\{([^;]*?)}\s+from\s+['"]@tabler\/icons-svelte['"];?/g,
        (match, whitespace: string, importNames: string) => {
          const hasSemi = match.endsWith(";")
          const imports = importNames
            .split(",")
            .map((v) => v.trim())
            .map((name) => {
              const newName = name
                .replace(/([A-Z]|[0-9]+)/g, "-$1")
                .toLowerCase()
                .slice(6)
              return `${whitespace}import ${name} from '@tabler/icons-svelte/icons/${newName}'${hasSemi ? ";" : ""}`
            })
          return imports.join("\n")
        }
      )

      if (ms.hasChanged()) {
        return {
          code: ms.toString(),
          map: ms.generateMap(),
        }
      }
    },
  }
}
