# Adobe Developer Distribution submission

This file is the local source of truth for Marketplace listing `ac804039`.
Do not recall the submission or publish an approved listing without explicit confirmation.

## Submission status

- Submitted for review: `2026-08-30` (`Asia/Tokyo`)
- Listing details: `In review`
- Version `0.1.0`: `In review`
- Publishing preference: `Manually publish later`

## Listing details

- Public plugin name: `Premiere Gateway`
- Subtitle: `AI-ready Premiere automation`
- Support email: `contact@arcm.co.jp`
- Help URL: `https://github.com/arcmanagement/premiere-gateway`
- Description:

  ```text
  Premiere Gateway connects local automation and AI agents to the active Adobe Premiere Pro project through an invisible UXP plugin and a loopback-only broker.

  Inspect a stable project and timeline snapshot, then perform revision-checked edits from the premiere-gateway CLI. Supported operations include media import, clip insert and overwrite edits, trim, move, clone, remove and update, track renaming, markers, effects and keyframes, transitions, MOGRT insertion, project backup, and sequence export.

  Write operations require explicit confirmation and the expected project, sequence, and timeline revision. Requests are serialized, undoable where Premiere exposes an action, and recorded in a local request journal to prevent unsafe replay after an uncertain result.

  Premiere projects remain the source of truth. Premiere Gateway does not expose arbitrary JavaScript, ExtendScript, or the unsupported QE DOM.

  Requires the free premiere-gateway CLI and local broker on the same Mac. No third-party account or cloud service is required.
  ```

## Media

- Icon: `assets/marketplace/premiere-gateway-icon-192.png`
- Source: `assets/marketplace/premiere-gateway-icon.svg`
- Screenshot: `assets/marketplace/premiere-gateway-screenshot-1360x800.png`

## Categories and tags

- Categories: `Tools & Automation`, `Collaboration`
- Tags: `video editing`, `automation`, `AI agents`, `CLI`, `workflow`

## Services

- Privacy policy: `https://arcm.co.jp/privacy-policy`
- Terms of service: leave blank unless Adobe validation makes it mandatory; ArcManagement does not currently publish a product terms URL.
- Purchase method: `Free`

## Version 0.1.0

- CCX: `plugin/marketplace-dist/ac804039_premierepro.ccx`
- Public CCX: `https://github.com/arcmanagement/premiere-gateway/releases/download/v0.1.1/ac804039_premierepro.ccx`
- Requires another application on the same device: `Yes` (the local CLI and broker)
- Requires third-party login: `No`
- Supported language: `English`
- Release notes:

  ```text
  Initial release of Premiere Gateway for Premiere Pro 26.3 and later. Provides a loopback-only CLI bridge for stable project and timeline snapshots, revision-checked clip and track edits, markers, effects and keyframes, transitions, MOGRT insertion, project backup, media import, and sequence export. Includes serialized requests and a persistent local request journal for fail-closed recovery.
  ```

## Note to Adobe reviewers

```text
Premiere Gateway requires the free local CLI and broker on the same Mac. Install them with Homebrew: brew install arcmanagement/premiere-gateway/premiere-gateway. Then run: premiere-gateway daemon install. Homebrew installs the required Node.js runtime. No login, API key, Keychain entry, paid credential, or cloud service is required. Open a writable Adobe Premiere Pro project with an active sequence and run premiere-gateway doctor to confirm the invisible UXP plugin session. The source, documentation, CLI release, and CCX are available at https://github.com/arcmanagement/premiere-gateway. Test snapshot reads first, then use a revision-checked edit command with --confirm.
```

## Submission evidence

- [x] Installed the Marketplace CCX locally through Creative Cloud Desktop.
- [x] Ran `npm run verify:ccx` against the CCX created by UXP Developer Tool.
- [x] Restarted Premiere Pro and verified automatic Plugin connection without UXP Developer Tools.
- [x] Ran `premiere-gateway doctor`, `snapshot`, reversible edit smoke tests, and project integrity checks.
- [x] Published the source repository, immutable release tags, verified CLI package, and verified CCX release assets.
- [x] Submitted the listing details and version `0.1.0` together for Adobe review after explicit confirmation.
- [x] Selected manual publishing after approval.
