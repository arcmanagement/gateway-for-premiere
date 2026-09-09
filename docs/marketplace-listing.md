# Adobe Developer Distribution submission

This file is the local source of truth for Marketplace listing `ac804039`.
Do not recall the submission or publish an approved listing without explicit confirmation.

## Submission status

- Submitted for review: `2026-08-30` (`Asia/Tokyo`)
- Latest review result received: `2026-09-09` (`Asia/Tokyo`)
- Listing details: `Rejected`; next corrected version is not resubmitted
- Version `0.1.0`: `Rejected`
- Publishing preference: `Manually publish later`
- Remaining review requirements:
  - provide signed GitHub Release installers for macOS and Windows that do not require Homebrew;
  - demonstrate a successful local broker connection; and
  - provide a complete video showing command results inside Premiere Pro.

## Listing details

- Public plugin name: `Gateway for Premiere`
- Subtitle: `AI automation for Premiere`
- Support email: `contact@arcm.co.jp`
- Help URL: `https://github.com/arcmanagement/gateway-for-premiere`
- Description:

  ```text
  This plugin requires installation and use of a companion application. Companion applications may include generative AI capabilities and be able to perform actions on your behalf, including accessing your files, exporting data, and generating content in your Adobe application. You are responsible for determining whether the use of this plugin and its companion application is appropriate for your project.

  Gateway for Premiere connects local automation and AI agents to the active Adobe Premiere Pro project through an invisible UXP plugin and a loopback-only broker.

  Inspect a stable project and timeline snapshot, then perform revision-checked edits from Gateway for Premiere. Supported operations include media import, clip insert and overwrite edits, trim, move, clone, remove and update, track renaming, markers, effects and keyframes, transitions, MOGRT insertion, project backup, and sequence export.

  Write operations require explicit confirmation and the expected project, sequence, and timeline revision. Requests are serialized, undoable where Premiere exposes an action, and recorded in a local request journal to prevent unsafe replay after an uncertain result.

  Premiere projects remain the source of truth. Gateway for Premiere does not expose arbitrary JavaScript, ExtendScript, or the unsupported QE DOM.

  Requires the free Gateway for Premiere companion and local broker on the same macOS or Windows computer. No third-party account or cloud service is required.
  ```

  Adobe suggested `AI-ready automation for Premiere`, but the Developer Distribution subtitle field allows only 30 characters. The saved 26-character subtitle above preserves the requested `for Premiere` branding form.

## Media

- Icon: `assets/marketplace/gateway-for-premiere-icon-192.png`
- Source: `assets/marketplace/gateway-for-premiere-icon.svg`
- Screenshot: `assets/marketplace/gateway-for-premiere-screenshot-1360x800.png`

## Categories and tags

- Categories: `Tools & Automation`, `Collaboration`
- Tags: `video editing`, `automation`, `AI agents`, `CLI`, `workflow`

## Services

- Privacy policy: `https://arcm.co.jp/privacy-policy`
- Terms of service: leave blank unless Adobe validation makes it mandatory; ArcManagement does not currently publish a product terms URL.
- Purchase method: `Free`

## Version 0.1.3

- Planned CCX: `plugin/marketplace-dist/ac804039_premierepro.ccx`
- Current public CCX: `https://github.com/arcmanagement/gateway-for-premiere/releases/download/v0.1.2/ac804039_premierepro.ccx`
- Requires another application on the same device: `Yes` (the local CLI and broker)
- Requires third-party login: `No`
- Supported language: `English`
- Release notes:

  ```text
  Initial release of Gateway for Premiere for Premiere Pro 26.3 and later. Provides a loopback-only CLI bridge for stable project and timeline snapshots, revision-checked clip and track edits, markers, effects and keyframes, transitions, MOGRT insertion, project backup, media import, and sequence export. Includes serialized requests and a persistent local request journal for fail-closed recovery.
  ```

## Note to Adobe reviewers

```text
Gateway for Premiere requires its free local companion on the same computer. Download the installer for the review computer from the latest GitHub release at https://github.com/arcmanagement/gateway-for-premiere/releases/latest: Gateway-for-Premiere-<version>-Windows.exe on Windows, or Gateway-for-Premiere-<version>-macOS-universal.pkg on macOS. Each installer includes Node.js, installs the CLI, and starts the local broker automatically; Homebrew is not required. No login, API key, Keychain entry, paid credential, or cloud service is required. Open a writable Adobe Premiere Pro project with an active sequence and run gateway-for-premiere doctor to confirm the invisible UXP plugin session. If the plugin reports Reconnecting, run gateway-for-premiere daemon status and follow the troubleshooting section in the Help URL. Test snapshot reads first, then use a revision-checked edit command with --confirm.
```

## Submission evidence

- [x] Installed the Marketplace CCX locally through Creative Cloud Desktop.
- [x] Ran `npm run verify:ccx` against the CCX created by UXP Developer Tool.
- [x] Restarted Premiere Pro and verified automatic Plugin connection without UXP Developer Tools.
- [x] Ran `gateway-for-premiere doctor`, `snapshot`, reversible edit smoke tests, and project integrity checks.
- [x] Published the initial source repository, immutable release tags, verified CLI package, and verified CCX release assets.
- [ ] Publish a signed, notarized universal macOS installer and its checksum in the next GitHub release.
- [ ] Publish an Authenticode-signed Windows installer and its checksum in the next GitHub release.
- [ ] Verify the Windows installer lifecycle and loopback broker on a clean Windows user without installing Premiere Pro.
- [ ] Verify the installer and CCX connection from a clean macOS user without Homebrew or UXP Developer Tool.
- [ ] Record and attach a complete video that visibly shows the resulting changes inside Premiere Pro.
- [x] Submitted the listing details and version `0.1.0` together for Adobe review after explicit confirmation.
- [x] Selected manual publishing after approval.
