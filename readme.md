<p align="center">
  <img src="https://raw.githubusercontent.com/infinitel8p/xtream/refs/heads/main/src-tauri/icons/128x128@2x.png" alt="Extreme InfiniTV app icon - cross-platform IPTV player"/>
</p>

<h1 align="center">Extreme InfiniTV</h1>

<p align="center"><strong>A cross-platform IPTV player for Xtream Codes and M3U / M3U8 playlists.</strong></p>

<p align="center">
  Live TV with EPG, movies, series, offline downloads, and TV-remote (D-pad) navigation.<br/>
  Ships on Windows (Microsoft Store + installer), Android phone / tablet / TV (Google Play), macOS, Linux, and the web.
</p>

<p align="center">
  <a href="https://apps.microsoft.com/detail/9NN162Z0WXSR">
    <img src="https://img.shields.io/badge/Microsoft%20Store-Download-0078D6?logo=microsoft&logoColor=white" height="50" alt="Get Extreme InfiniTV on the Microsoft Store"/>
  </a>
  <a href="https://play.google.com/store/apps/details?id=com.infinitel8p.xtream">
    <img src="https://img.shields.io/badge/Google%20Play-Download-34A853?logo=google-play&logoColor=white" height="50" alt="Get Extreme InfiniTV on Google Play"/>
  </a>
  <a href="https://github.com/infinitel8p/xtream/releases/latest">
    <img src="https://img.shields.io/badge/GitHub-Releases-181717?logo=github&logoColor=white" height="50" alt="Download Extreme InfiniTV from GitHub Releases"/>
  </a>
</p>

<p align="center">
  <a href="https://github.com/infinitel8p/xtream/releases/latest"><img src="https://img.shields.io/github/v/release/infinitel8p/xtream?label=latest&color=a855f7" alt="Latest release"/></a>
  <a href="https://github.com/infinitel8p/xtream/releases"><img src="https://img.shields.io/github/downloads/infinitel8p/xtream/total?color=a855f7" alt="GitHub downloads"/></a>
  <a href="https://github.com/infinitel8p/xtream/stargazers"><img src="https://img.shields.io/github/stars/infinitel8p/xtream?color=a855f7" alt="GitHub stars"/></a>
  <img src="https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-64748b" alt="Supported platforms: Windows, macOS, Linux, Android"/>
</p>

## Screenshots

<p align="center">
  <img src="docs/screenshots/Desktop/home.png" alt="Extreme InfiniTV home screen showing Live TV, Movies, and Series tiles with Continue Watching strip" width="780"/>
</p>

<details>
<summary>More screenshots (Live TV, EPG, Movies, Series, Android TV, mobile)</summary>

| | | |
|---|---|---|
| <img src="docs/screenshots/Desktop/livetv.png" alt="Live TV channel list with inline EPG showing now/next programmes"/> | <img src="docs/screenshots/Desktop/movies.png" alt="Movies poster grid with category filtering"/> | <img src="docs/screenshots/Desktop/series.png" alt="Series detail view with seasons and episodes"/> |
| <img src="docs/screenshots/Desktop/epg.png" alt="Full XMLTV schedule grid for the EPG page"/> | <img src="docs/screenshots/Desktop/settings.png" alt="Settings page with playlists, display, network, and downloads"/> | <img src="docs/screenshots/Android-TV/home.png" alt="Extreme InfiniTV running on Android TV with D-pad focus"/> |

</details>

## Features

- **Two backends, one UI.** Sign in with Xtream Codes credentials (host / port / user / pass) or paste a direct `.m3u` / `.m3u8` URL. The app detects the mode automatically.
- **Live TV** with category filtering, channel search, virtualised list, and inline EPG (now / next / today).
- **Movies (VOD)** and **Series** library with poster grids, detail dialogs, and season / episode navigation.
- **Full schedule grid** on the EPG page, with timezone-aware "all times local" rendering.
- **Picture-in-picture** and a Video.js-powered player tuned for HLS.
- **Multiple playlists**, switchable from the sidebar without re-entering credentials.
- **TV-first navigation.** Spatial focus (D-pad / arrow keys) is wired across the whole app via `spatial-navigation-polyfill`. Hit targets, focus rings, and reflow tested for 10-foot UI.
- **Light and dark themes**, both first-class. Honours `prefers-color-scheme`, `prefers-reduced-motion`, and `prefers-contrast`.
- **Adjustable font scale** (Default / Medium / Large / X-Large) plus a responsive root size that scales the whole UI on 4K and 8K displays.
- **Self-updating Windows desktop build** via the Tauri updater (signed with minisign, served from GitHub Releases).
- **Offline-friendly persistence.** Credentials and preferences live in the OS app-data dir on Tauri builds, with a localStorage / cookie fallback on the web build.

## Install

| Platform | How | Updates |
| --- | --- | --- |
| Windows (Microsoft Store) | [apps.microsoft.com](https://apps.microsoft.com/detail/9NN162Z0WXSR) | Microsoft Store |
| Windows (sideload) | NSIS `.exe` (or `.msi`) from [Releases](https://github.com/infinitel8p/xtream/releases/latest) | In-app auto-updater |
| macOS (Apple Silicon + Intel) | Universal `.dmg` from [Releases](https://github.com/infinitel8p/xtream/releases/latest) | In-app auto-updater |
| Linux (Debian / Ubuntu / Mint) | `.deb` from [Releases](https://github.com/infinitel8p/xtream/releases/latest) | Manual |
| Linux (Fedora / openSUSE / RHEL) | `.rpm` from [Releases](https://github.com/infinitel8p/xtream/releases/latest) | Manual |
| Linux (any distro, portable) | `.AppImage` from [Releases](https://github.com/infinitel8p/xtream/releases/latest) | In-app auto-updater |
| Android phone / tablet | [Google Play](https://play.google.com/store/apps/details?id=com.infinitel8p.xtream) | Play Store |
| Android TV | Same APK, sideload via ADB or use Play Store on supported devices | Play Store |
| Web preview | Build with `pnpm build` and serve `dist/` (no auto-update, no native features) | Manual |

### via winget

The Microsoft Store listing is federated through `winget`, so you can install without opening the Store:

```powershell
winget install --id 9NN162Z0WXSR --source msstore
```

### macOS: "xtream.app" cannot be opened

The macOS build is not yet notarized by Apple, so Gatekeeper blocks it on first launch with a message like _"Apple could not verify xtream.app is free of malware"_. After dragging the app from the `.dmg` into `/Applications`, remove the quarantine flag from a Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/xtream.app
```

Then open the app normally. You only need to do this once per install.

## Develop

Requirements: [pnpm](https://pnpm.io) (the package manager is pinned in `package.json`), Node 20+, the Rust toolchain (only for `tauri` commands), and Android Studio for `tauri:android`.

```bash
pnpm install
pnpm dev                  # Astro + Svelte at http://localhost:4321
pnpm tauri dev            # Native Windows / desktop shell (auto-spawns pnpm dev)
pnpm tauri:android        # Android dev shell
```

The Astro dev server's HMR `host` is hardcoded to a LAN IP in `astro.config.mjs`. Update or remove that block if dev HMR fails on your machine.

There are no tests, linters, or formatters configured. TypeScript is in strict mode (`tsconfig.json` extends `astro/tsconfigs/strict`); the `@/*` alias maps to `src/*`.

## Credits

Copyright (c) 2025 Ludovico Ferrara.
