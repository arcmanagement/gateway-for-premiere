# Adobe Developer Distribution draft

This file is the local source of truth for Marketplace listing `ac804039`.
Do not submit the listing for review without an explicit final confirmation.

## Listing details

- Public plugin name: `Premiere Gateway`
- Subtitle: `AI-ready Premiere automation`
- Support email: `contact@arcm.co.jp`
- Help URL: `https://arcm.co.jp/`
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
- Requires another application on the same device: `Yes` (the local CLI and broker)
- Requires third-party login: `No`
- Supported language: `English`
- Release notes:

  ```text
  Initial release of Premiere Gateway for Premiere Pro 26.3 and later. Provides a loopback-only CLI bridge for stable project and timeline snapshots, revision-checked clip and track edits, markers, effects and keyframes, transitions, MOGRT insertion, project backup, media import, and sequence export. Includes serialized requests and a persistent local request journal for fail-closed recovery.
  ```

## Note to Adobe reviewers

```text
Premiere Gateway requires Node.js 22 or later and the free local CLI on the same Mac. Install the reviewed v0.1.0 package with `npm install --global https://github.com/arcmanagement/premiere-gateway/releases/download/v0.1.0/arcmanagement-premiere-gateway-0.1.0.tgz`, then run `premiere-gateway daemon install`. No login, API key, Keychain entry, or cloud service is required. Open any writable Premiere Pro project and run `premiere-gateway doctor` to confirm the invisible UXP plugin session before testing snapshot or revision-checked edit commands.
```

## Submission gates

- Install the Marketplace CCX locally through Creative Cloud Desktop.
- Run `npm run verify:ccx` against the CCX created by UXP Developer Tool.
- Restart Premiere Pro and verify automatic Plugin connection without UXP Developer Tools.
- Run `premiere-gateway doctor`, `snapshot`, and project integrity checks.
- Publish the source repository, immutable `v0.1.0` tag, and verified npm package release asset so Adobe reviewers can install the required CLI.
- Upload and save the listing/version draft only after action-time confirmation for the public support contact and files.
- Preview the complete submission and request a separate final confirmation before submitting it to Adobe review.
