# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

The plugin has exactly one version, kept identical in `manifest.json`, `package.json`, `versions.json`
and a section of this file; `npm run release` refuses to build when they disagree. The installed version is
shown in the plugin settings header ("Obsyncher vX.Y.Z") and in the status bar tooltip, and every device
publishes its version so the others can see it under "Devices seen on the server".

## [0.2.1] — 2026-09-29

Prepared for the Obsidian community plugin directory: the code now passes the official
`eslint-plugin-obsidianmd` rule set (the one the directory's automated review is based on) with no errors or warnings.

### Changed
- **Requires Obsidian 1.8.7 or newer** (`minAppVersion`), because the plugin uses APIs introduced in 1.6.6 and 1.8.7.
- The settings tab is described with Obsidian's declarative settings API: on Obsidian 1.13+ all Obsyncher
  settings show up in the settings search; older versions draw the same rows the classic way. Looks and works as before.
- Node.js APIs are loaded only in the desktop app, from one guarded place; nothing Node-specific runs on phones.
- Manifest description no longer contains characters the directory does not allow.
- README: new **Disclosures** section (network use, files outside the vault, no telemetry).

### Fixed
- Timers use `window` timers (work correctly in Obsidian pop-out windows).
- Stricter typing of everything read from JSON (config file, server metadata, journal).
- Plugin unloading no longer returns a promise Obsidian does not wait for.

## [0.2.0] — 2026-09-29

First public release.

### Changed
- The user interface is English only (the Ukrainian translation was removed).
- All documentation rewritten in English; the README is now a step-by-step guide for every platform.
- `manifest.json`: author **Mr.Racoon**, `authorUrl` added. `package.json`: author, repository and keywords.

### Added
- GitHub Actions workflow that builds the plugin and attaches `main.js`, `manifest.json` and `styles.css`
  to a GitHub release when a version tag is pushed.

## [0.1.4] — 2026-09-29

### Changed
- `manifest.json` author set to **Mr.Racoon**.

## [0.1.3] — 2026-09-29

### Fixed
- A full scan listed the server folders one by one. Over the phone relay every folder listing is a slow
  round trip, so even a repeated scan took about a minute. Folders are now listed in parallel (up to 8):
  1430 entries over a real relay went from 49 s to 8 s, a full sync on the phone from 65 s to 20 s.

## [0.1.2] — 2026-09-29

### Fixed
- The first sync of a phone (~1300 notes) took more than 25 minutes because files were compared one at a time,
  each costing several round trips through the relay. A full scan now reconciles up to 8 files in parallel.
- During a long sync the device stopped sending its heartbeat and looked offline to the others, so
  "Device … deleted file …" pop-ups did not appear. The heartbeat now runs outside the task queue.
- A file another device had just deleted could come back. This happened when this device had no sync base for
  it yet (first sync, or a copy put there by another tool): the copy looked new and was uploaded again. Now a
  local copy that is not newer than the deletion is removed; a newer local edit still wins over the deletion.
- Saving the key import dialog with an empty field showed a confusing "Not a PEM/OpenSSH private key".

### Added
- The plugin version is shown in the settings header, the status bar tooltip and the console on load.
- Every device publishes its version; "Devices seen on the server" shows each one and marks a device ⚠
  when it runs a different version than this one.
- `CHANGELOG.md` and a version consistency check in `npm run release`.

## [0.1.1] — 2026-09-29

### Fixed
- Desktop: "Test connection" said OK, but "Sync" failed with an SFTP channel error and kept reconnecting forever.
  One file that could not be synced (for example `bad:name.md`, a name Windows does not allow) dropped the whole
  connection. Such items are now skipped and listed under "Not synced"; everything else is synced.
- Files whose names differ only by letter case (`Note.md` / `note.md`) no longer overwrite each other.
- A server folder that cannot be read is no longer treated as "deleted" (which would have deleted local copies).
- Races between "Sync", "Reconnect" and closing the settings window.
- "SFTP channel closed" now includes the real reason the connection dropped.
- Phone: a key given by an explicit path was never found, because plugins on Android cannot read files outside
  the vault.

### Added
- "Import key…": the private key is stored encrypted on the device (AES-256-GCM, device-bound).
- The relay address defaults to `ws://<server address>:8022`; phones no longer show a transport choice.
- `server/install-relay.sh`: installs, reinstalls (run it again) and removes (`--uninstall`) the relay.
- "Test connection" also checks that the remote folder is writable.

## [0.1.0] — 2026-09-29

First working version: an SSH/SFTP client in pure TypeScript (Windows, Linux, and Android through a WebSocket
relay), three-way sync with a local hash base, a live journal between devices, deletion pop-ups, last writer wins,
Permanent save with `sync_ignore` and `*.old` files, a mass-deletion guard and encrypted passwords.
