// @ts-check
import js from "@eslint/js"
import tseslint from "typescript-eslint"
import svelte from "eslint-plugin-svelte"
import astro from "eslint-plugin-astro"
import globals from "globals"

export default [
  {
    ignores: [
      "dist/**",
      ".astro/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "buildfiles/**",
      "dump/**",
      ".netlify/**",
      "src/scripts/spatial-navigation.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  ...astro.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        AndroidWebSettings: "readonly",
        AndroidPip: "readonly",
        AndroidFs: "readonly",
      },
    },
    rules: {
      "no-empty": ["warn", { allowEmptyCatch: false }],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/triple-slash-reference": "off",
      "no-undef": "off",
      "no-prototype-builtins": "off",
      "no-cond-assign": ["error", "except-parens"],
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "warn",
      "no-unreachable-loop": "error",
      "no-useless-assignment": "warn",
      "no-self-assign": "warn",
      "no-control-regex": "warn",
      "no-var": "off",
      "preserve-caught-error": "warn",
    },
  },

  {
    files: ["**/*.svelte"],
    rules: {
      "prefer-const": "off",
      "svelte/no-at-html-tags": "warn",
      "svelte/prefer-svelte-reactivity": "warn",
      "svelte/require-each-key": "warn",
      "svelte/no-dom-manipulating": "warn",
    },
  },

  {
    files: ["**/*.astro"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  {
    files: ["src/scripts/capture-screenshots.mjs", "src/plugins/**/*.ts"],
    rules: {
      "no-empty": "off",
    },
  },
]
