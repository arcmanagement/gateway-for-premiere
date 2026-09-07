# Adobe Developer Distribution submission

This file is the local source of truth for Marketplace listing `ac804039`.
Do not recall the submission or publish an approved listing without explicit confirmation.

## Submission status

- Submitted for review: `2026-08-30` (`Asia/Tokyo`)
- Review result received: `2026-09-07` (`Asia/Tokyo`)
- Listing details: `Rejected`; corrected draft saved on `2026-09-08`, not resubmitted
- Version `0.1.0`: `Rejected`
- Publishing preference: `Manually publish later`
- Remaining review requirement: provide a complete video demonstration before resubmission

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

  Requires the free Gateway for Premiere CLI and local broker on the same Mac. No third-party account or cloud service is required.
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

## Version 0.1.2

- CCX: `plugin/marketplace-dist/ac804039_premierepro.ccx`
- Public CCX: `https://github.com/arcmanagement/gateway-for-premiere/releases/download/v0.1.2/ac804039_premierepro.ccx`
- Requires another application on the same device: `Yes` (the local CLI and broker)
- Requires third-party login: `No`
- Supported language: `English`
- Release notes:

  ```text
  Initial release of Gateway for Premiere for Premiere Pro 26.3 and later. Provides a loopback-only CLI bridge for stable project and timeline snapshots, revision-checked clip and track edits, markers, effects and keyframes, transitions, MOGRT insertion, project backup, media import, and sequence export. Includes serialized requests and a persistent local request journal for fail-closed recovery.
  ```

## Note to Adobe reviewers

```text
Gateway for Premiere requires the free local CLI and broker on the same Mac. Install them with Homebrew: brew install arcmanagement/gateway-for-premiere/gateway-for-premiere. Then run: gateway-for-premiere daemon install. Homebrew installs the required Node.js runtime. No login, API key, Keychain entry, paid credential, or cloud service is required. Open a writable Adobe Premiere Pro project with an active sequence and run gateway-for-premiere doctor to confirm the invisible UXP plugin session. The source, documentation, CLI release, and CCX are available at https://github.com/arcmanagement/gateway-for-premiere. Test snapshot reads first, then use a revision-checked edit command with --confirm.
```

## Submission evidence

- [x] Installed the Marketplace CCX locally through Creative Cloud Desktop.
- [x] Ran `npm run verify:ccx` against the CCX created by UXP Developer Tool.
- [x] Restarted Premiere Pro and verified automatic Plugin connection without UXP Developer Tools.
- [x] Ran `gateway-for-premiere doctor`, `snapshot`, reversible edit smoke tests, and project integrity checks.
- [x] Published the initial source repository, immutable release tags, verified CLI package, and verified CCX release assets.
- [ ] Publish the renamed CLI package, Homebrew formula, and rebuilt CCX release assets before resubmission.
- [ ] Record and attach the complete video demonstration requested by Adobe.
- [x] Submitted the listing details and version `0.1.0` together for Adobe review after explicit confirmation.
- [x] Selected manual publishing after approval.
