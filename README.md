<p align="center">
  <img src="brand/logo.svg" width="120" alt="Sendit logo" />
</p>

<h1 align="center">Sendit</h1>

<p align="center">
  <b>Send anything between your phone and PC over Wi-Fi.</b><br />
  Share from any app. No cloud, no account, no upload to a server.
</p>

<p align="center">
  <a href="../../releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Rupesh9369/sendit?label=download" /></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue" />
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Android%20%7C%20Windows-lightgrey" />
</p>

---

## What it does

- **Phone → PC and PC → phone.** Text, links, photos, videos and any file.
- **Share from any app.** Pick Sendit in the Android share sheet. Links from Instagram, YouTube and others show their preview image and title.
- **One-tap text.** Select text in any app, tap **Send to Sendit**.
- **Folders.** Create folders on each device and keep items inside them.
- **Save and open.** Save received files to Downloads on the PC, or save or open them on the phone.
- **Pair once.** After pairing, the phone finds the PC again on the same Wi-Fi, even if the PC's address changes.
- **Private by design.** Data moves directly between your devices on your local network. Nothing is uploaded to a server.

## How it works

```
Android app  ──HTTP over Wi-Fi──▶  Windows app
(Expo / React Native)           (Tauri + Rust)
```

- The Windows app runs a small HTTP server on your local network (port `53320`). Every request needs a secret token that is created on first run.
- Pairing shows a QR code and a link on the PC. Scan it or paste the link on the phone. The token is saved on the phone.
- The phone syncs every 2 seconds while the PC is reachable: it uploads what you shared and downloads what the PC sent.
- Items are stored in each device's private app storage. Nothing leaves your Wi-Fi.

## Download

Get the latest build from the [Releases](../../releases/latest) page:

| File | For |
| --- | --- |
| `Sendit.apk` | Android phones. Open it from the Files app and allow installs when asked. |
| `Sendit.exe` | Windows, portable. Run it directly. |
| `Sendit_*_x64-setup.exe` | Windows installer. |
| `Sendit_*_x64_en-US.msi` | Windows installer (MSI). |

Windows may ask you to allow Sendit through the firewall on first run. Allow it on **private** networks, so the phone can reach the PC.

## Quick start

1. Install Sendit on the PC and on the phone. Both must be on the same Wi-Fi.
2. On the PC, click **Phone not connected** (top right) to show the pairing code.
3. On the phone, tap **Pair PC** and scan the code, or paste the link.
4. Send something. It appears on the other device within a few seconds.

## Build from source

Requirements: Node.js 20+, Rust (stable), Android Studio with the Android SDK, and the Microsoft C++ Build Tools on Windows.

```bash
# Phone (Android)
cd mobile
npm install
npx expo run:android --variant release

# PC (Windows)
cd desktop
npm install
npm run tauri build
```

For a development run use `npx expo start` in `mobile` and `npm run tauri dev` in `desktop`.

## Project layout

```
mobile/    Android app (Expo, React Native, TypeScript)
desktop/   Windows app (Tauri 2, Rust backend, TypeScript UI)
brand/     Logo and icon sources (SVG and PNG)
```

## Security and limits

- Sendit is for your own devices on your own network. Only use it on a Wi-Fi you trust.
- The phone talks to the PC over plain HTTP on the local network. The token protects against other devices, but the traffic is not encrypted. Do not use it on public Wi-Fi.
- The Android APK in Releases is signed with a debug key. Do not treat it as a store release.
- Folders are separate on each device. Moving an item on one device does not move it on the other.
- Link previews come from the page's Open Graph tags. Some sites do not provide them.

## Contributing

Issues and pull requests are welcome. Please keep changes small and tested, and describe how you tested them.

## License

[MIT](LICENSE)
