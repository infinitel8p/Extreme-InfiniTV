# Flathub submission

1. Fork `flathub/flathub` on GitHub with "Copy the master branch only" unchecked.
2. `git clone --branch=new-pr git@github.com:<you>/flathub.git && cd flathub`
3. `git checkout -b extreme-infinitv new-pr`
4. Copy `io.github.infinitel8p.ExtremeInfiniTV.yml`, `io.github.infinitel8p.ExtremeInfiniTV.metainfo.xml`, and `flathub.json` from this folder into the root of that checkout, commit, push.
5. Open a PR against the `new-pr` base branch (title: `Add io.github.infinitel8p.ExtremeInfiniTV`).
6. Once comments are resolved, a reviewer (or you, once invited) comments `bot, build` to trigger a test build.
7. After approval and merge, Flathub creates `github.com/flathub/io.github.infinitel8p.ExtremeInfiniTV`; the external-data-checker config already in the manifest (`x-checker-data`) picks up new stable GitHub releases automatically from then on - no extra setup needed.

## Before opening the PR

- **AI-generated content**: Flathub's Generative AI policy forbids AI-generated manifests, metadata, or PR text. This package was drafted by an AI agent as a starting point. Read every file, rewrite anything you would not personally vouch for in your own words, and write the PR description yourself. Also disable automatic Copilot reviews on your fork before opening the PR.
- **No aarch64 build yet**: the current stable release (v1.7.0) only publishes an amd64 `.deb`. `flathub.json` restricts the build to `x86_64` for now; add an `aarch64`-only source once a release ships one, and drop `flathub.json` at that point.
- **App ID vs. repo name**: the ID's last component is `ExtremeInfiniTV` (no hyphen), so the calculated repo URL (`github.com/infinitel8p/ExtremeInfiniTV`) does not exactly match the real repo (`Extreme-InfiniTV`). Flathub's own docs say this needs a manual reviewer check - the `vcs-browser` URL in the metainfo points at the real repo to make that easy.
- **Binary packaging, not source build**: the module extracts the official release `.deb` rather than compiling from source, following Tauri's own Flathub guide. Flathub's default preference is building from source; be ready to explain why (Rust/npm offline vendoring for a Tauri app is heavy) if a reviewer asks, and point at other Tauri/Electron apps on Flathub that got the same exception.
- **Discord IPC socket**: `--filesystem=xdg-run/discord-ipc-0` has no portal alternative; reviewers sometimes ask about this - Discord Rich Presence in Settings is the only thing that uses it.
- **Screenshots**: reused from `docs/screenshots/Desktop/` (1300x850, above the 1000x700 quality-guideline suggestion). Not a hard requirement, but consider recapturing at a smaller size for the "featured" bar later.

## Permissions rationale

Every static permission a reviewer will ask about, and why it's there:

- `--talk-name=org.kde.StatusNotifierWatcher`: the tray icon (`tray.rs`, on by default via close-to-tray) registers itself through `libayatana-appindicator3`, which calls `RegisterStatusNotifierItem` on this name. Both KDE and GNOME's AppIndicator extension implement the same watcher name. No portal covers tray icons.
- `--talk-name=org.freedesktop.Notifications`: `notify-rust` (the Linux backend behind `@tauri-apps/plugin-notification`) calls this D-Bus name directly rather than going through the `org.freedesktop.portal.Notification` portal, so it needs an explicit grant.
- `--filesystem=xdg-run/discord-ipc-0`: see above.
- `--filesystem=xdg-download`: default landing spot for movie/series downloads. The Settings folder picker itself uses Tauri's dialog plugin, which on Linux is `rfd`'s GTK backend (`GtkFileChooserNative`); GTK auto-detects the Flatpak sandbox and routes that dialog through the file-chooser portal, so picking a folder outside `xdg-download` (e.g. `~/Videos`, a mounted drive) is granted dynamically at pick time - the static permission does not need to be widened for that case. One known gap: resuming an in-progress download after an app restart re-opens the previously-picked path directly (not through a fresh portal pick), so if that path is outside `xdg-download` and the portal grant didn't persist, resume can fail under Flatpak specifically. Not fixed here; flag it if a reviewer or user hits it.
- Nothing here requests `com.canonical.AppMenu.Registrar` (or the related `com.canonical.indicator.application` / `com.canonical.Unity` names some Electron apps request) - those cover exporting a native window menu bar to Unity's global menu, and this app has no window menu bar, only the tray's own popup menu, so there's nothing to justify that grant.

## Common reviewer flags

- Manifest key ordering, JSON/YAML style (run `flatpak-builder-lint manifest` locally if you have Flatpak).
- Summary/description wording, icon quality, missing release notes.
- Static permissions not justified by a portal (see "Permissions rationale" above).
