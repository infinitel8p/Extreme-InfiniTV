# Privacy Policy for Extreme InfiniTV: IPTV Player

**Effective Date:** May 1, 2026
**Last Updated:** August 31, 2026

This Privacy Policy describes how **Extreme InfiniTV: IPTV Player** (the "App") handles information when you use it. The App is published on the Google Play Store and Microsoft Store under the developer name **Ludovico Ferrara** (also doing business as **InfiniteL8p**), referred to in this document as "we", "our", or "us".

The App was previously distributed under the name "xtream" prior to a 1.2.0 rebrand. The Android package identifier remains `com.infinitel8p.xtream` for installation continuity. References in source code, store metadata, or update artifacts to either name refer to the same App.

---

## 1. Information We Collect

We do **not** collect, store, or process any personal data on our servers.

The App:
- Does **not** require you to create an account with us.
- Does **not** contain analytics, advertising, attribution, or crash-reporting services, and does **not** send usage statistics to us or anyone else.
- Stores minimal data (such as preferences, watch history, favorites, watchlist, and download progress) **locally on your device** using local storage, cookies, or platform-equivalent secure storage (Tauri Store on desktop, scoped storage / SAF on Android).

The only service we operate is a small metadata relay described in Section 3. It exists so the App can fetch artwork and episode details from TheTVDB without shipping an API key inside the App, and we do not use it to collect or store personal data.

---

## 2. How the App Works

- All Xtream Codes server URLs, M3U / M3U8 playlist URLs, and EPG / XMLTV URLs you connect to are entirely user-provided.
- The App contacts the servers you explicitly configure and plays or displays the content those servers return. Beyond those, it contacts only the small set of supporting services listed in Section 3 (metadata lookups, update checks, and the optional Discord Rich Presence integration).
- We have no access to, nor control over, the third-party servers, content, or accounts you choose to connect to.

---

## 3. Third-Party Services

- The App does **not** integrate with third-party analytics, advertising networks, attribution SDKs, or crash-reporting services.
- **Metadata lookups (TheTVDB).** To show posters, cast, and episode details, the App looks up the titles you open on **TheTVDB** through a relay we operate (`xt-tvdb-proxy.infinitel8p.com`). The relay's only purpose is to authenticate requests to TheTVDB; it receives the title being looked up and, like any web server, sees your IP address, which is used solely for short-lived rate limiting. It requires no account, and we do not store your lookups or use them to identify you. This feature is enabled by default and can be turned off in the App's Settings.
- **Metadata lookups (TMDB, optional).** If you add your own TMDB API key in Settings, titles you open are sent directly from your device to **TMDB** to fetch trailers, cast, and similar titles. Without a key, no TMDB requests are made. This product uses the TMDB API but is not endorsed or certified by TMDB.
- **Update checks (GitHub).** The App contacts **GitHub** (github.com) to check for new versions and to display release notes. These requests go directly from your device to GitHub and are subject to GitHub's own privacy policy.
- The App contains an optional **Discord Rich Presence** integration on desktop platforms (Windows, macOS, Linux). When enabled per playlist in Settings, the App publishes the title of the content you are currently viewing to your local Discord client via Discord's IPC protocol so it appears on your own Discord profile. This integration runs entirely between the App and your locally installed Discord client, and can be disabled at any time in the App's Settings.
- External websites or third-party media you access through the App (provider servers, YouTube trailers opened via your default browser, etc.) have their own privacy policies. We encourage you to review them separately.

---

## 4. Data Storage & Security

- All settings, credentials for IPTV providers you choose to add, favorites, watchlist, recents, and download history are stored **locally on your device**.
- Aside from the metadata relay described in Section 3, no data is transmitted to servers we operate. There is no user account system and no central database of personal data that could be accessed or compromised.
- A user-initiated **Backup export / import** feature in Settings can produce a JSON file containing your local state (playlists, preferences, app settings) for you to save to your own device or cloud storage. This file is created only when you explicitly request it, and is never uploaded anywhere by the App.

---

## 5. Permissions

The App requests platform permissions only as needed for its core function:

- **Internet access** - to contact the IPTV provider servers and EPG sources you configure.
- **Storage / file access** - to download movies and episodes to a folder you choose, and to read those files back for offline playback.
- **Notifications** (where applicable) - to surface download completion and update events.

The App does not request access to contacts, microphone, camera, location, SMS, call logs, or other sensitive device data.

---

## 6. Children's Privacy

The App is **not intended for children under 13** (or the minimum age in your jurisdiction). We do not knowingly collect any data from children.

---

## 7. Changes to This Policy

We may update this Privacy Policy if the App's features change. Updates will be reflected with a new "Last Updated" date at the top of this document.

---

## 8. Contact Us

If you have questions about this Privacy Policy, you can reach us at:

- **Developer:** Ludovico Ferrara (InfiniteL8p)
- **App:** Extreme InfiniTV: IPTV Player (Android package id: `com.infinitel8p.xtream`)
- **Email:** admin@infinitel8p.com
- **Source code and issue tracker:** https://github.com/infinitel8p/Extreme-InfiniTV

---

*Disclaimer: This Privacy Policy is provided for informational purposes and does not constitute legal advice. You should consult a lawyer to ensure compliance with any applicable regulations in your region.*
