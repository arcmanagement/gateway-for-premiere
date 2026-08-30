# Premiere Gateway

Premiere Gateway is a local bridge that lets AI agents and human editors work on the same Adobe Premiere Pro project and sequence. The CLI sends requests to a fixed-token loopback broker, and an invisible Premiere UXP plugin reads and edits the active Premiere DOM.

The Premiere project remains the source of truth. XML can still be used for rough cuts and interchange, but it does not replace the native project after a human has added effects, transitions, audio edits, captions, or Dynamic Link content.

## Requirements

- macOS
- Node.js 22 or later
- Adobe Premiere Pro 26.3 or later
- The Premiere Gateway CCX installed through Adobe Exchange or Creative Cloud Desktop

## Supported operations

- Inspect the active project and sequence.
- Capture a stable editing snapshot by reading project items and the timeline twice and accepting only matching identities and revisions.
- Inspect project items, video, audio, and caption track identities, clip placement, mute state, markers, effects, parameters, speed, and reverse state.
- Save a project or create a non-overwriting `.prproj` backup.
- Import media with project-item revision and postcondition checks.
- Remove unused media items and empty bins.
- Insert, overwrite, trim, move, clone, remove, rename, enable, or disable clips with revision checks.
- Rename video and audio tracks.
- Add, update, move, and remove sequence markers.
- Insert a `.mogrt` file and edit public primitive component parameters.
- Add and remove video or audio effects.
- Edit static parameters and keyframes.
- Add and remove video transitions.
- Export a sequence with an explicit Premiere or Adobe Media Encoder preset.
- Serialize requests in both the broker and plugin.
- Record write outcomes in a persistent UXP request journal and fail closed after uncertain outcomes.

Premiere Gateway does not expose arbitrary JavaScript, ExtendScript, or QE DOM. Every write command requires `--confirm` and the expected project GUID, sequence GUID, and timeline revision.

## Architecture

```text
premiere-gateway CLI
        | fixed-token HTTP on 127.0.0.1
        v
local broker
        | Origin file:// + fixed-token WebSocket
        v
Premiere UXP Plugin --> Premiere DOM --> active project / sequence
```

MCP is not part of the initial entry point. If typed tool discovery, event subscriptions, or multiple clients become necessary, MCP should be added as an adapter over the same broker contract.

## Install the CLI

Install the CLI from the official Homebrew tap:

```bash
brew install arcmanagement/premiere-gateway/premiere-gateway
premiere-gateway daemon install
premiere-gateway doctor
```

Homebrew installs the required Node.js runtime automatically.

Alternatively, install Node.js 22 or later and the immutable package attached to the release tag:

```bash
npm install --global https://github.com/arcmanagement/premiere-gateway/releases/download/v0.1.0/arcmanagement-premiere-gateway-0.1.0.tgz
premiere-gateway daemon install
premiere-gateway doctor
```

The CCX is installed through Adobe Exchange. The CLI runs the loopback broker on the same Mac. No PAT, Keychain entry, pairing step, third-party account, or cloud service is required.

`plugin build` is intended for source checkouts that create a CCX. Normal Marketplace users install the CCX and do not need the plugin compiler.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run verify:dist
npm link
```

`plugin/dist/` and `plugin/marketplace-dist/` are generated. The root `dist/` is committed as a release artifact so the CLI package can be installed without a compiler. CI rebuilds it and verifies that it matches `src/`.

## Local development plugin

```bash
npm run build:server
node dist/cli/index.js plugin build
node dist/cli/index.js daemon install
```

Add `plugin/dist/manifest.json` to Adobe UXP Developer Tool, then open `Window > UXP Plugins > Premiere Gateway` in Premiere Pro.

The development panel reconnects to the broker after it has been opened once. The CLI does not bring Premiere or a panel to the foreground for each command. Use `status` to check the connection.

## Marketplace plugin package

Use UXP Developer Tool's `Package...` action to create the CCX, then verify the package:

```bash
node dist/cli/index.js plugin build --mode invisible --distribution marketplace
npm run verify:ccx
```

The Adobe Developer Distribution plugin ID is `ac804039`. Marketplace builds always use this fixed ID and are separated from development builds.

`verify:ccx` checks the Marketplace ID, host, invisible launch mode, package files, source manifest semantics, exact `index.html` and `index.js` bytes, fixed protocol token, absence of obsolete secrets, and the 50 MB limit.

The fixed public protocol token is `premiere-gateway`. It is not used as a credential. HTTP requires it in a custom header to prevent accidental browser access to the loopback API. Plugin WebSocket connections accept only the measured Premiere UXP origin `file://` and reject HTTP(S) browser origins.

The invisible application-launch mode does not add a visible panel to Premiere's menu. Use the CLI `status` or `doctor` command to verify the session.

## Managed daemon

The broker is installed as a macOS LaunchAgent and starts at login:

```bash
premiere-gateway daemon status
premiere-gateway daemon stop
premiere-gateway daemon start
premiere-gateway daemon restart
premiere-gateway daemon uninstall --confirm
```

## Inspect the active edit

```bash
premiere-gateway doctor
premiere-gateway status
premiere-gateway snapshot --depth 4
premiere-gateway project
premiere-gateway project recovery
premiere-gateway project items --depth 4
premiere-gateway sequence
premiere-gateway capabilities
premiere-gateway journal --limit 20
```

`doctor` reports the fixed protocol access mode, managed daemon, broker connection, Premiere version, plugin session, request journal, active project, and active sequence. A live session proves that the plugin is connected, but the wire protocol cannot determine whether it was loaded by UXP Developer Tool or by an installed CCX. Verify a cold start by closing UXP Developer Tool, restarting Premiere, and observing the automatic session.

`snapshot` reads the full project-item tree once per observation, projects the requested depth from the same in-memory tree, and observes project items and the timeline twice in one plugin request. It returns only when the project identity, sequence identity, project-item revision, timeline revision, and embedded identities match in both observations. If a human edits during the read, it retries up to three times and then stops without producing a diff.

## Revision-checked edits

Use the GUIDs and revision returned by `sequence` or `snapshot`:

```bash
premiere-gateway timeline trim \
  --item-ref video:0:0 \
  --expect-revision REVISION \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --end-seconds 8.5 \
  --confirm
```

If the active project, sequence, or timeline changed after the snapshot, the mutation fails. Capture a new snapshot and recalculate the intended diff.

Requests for one Premiere session are serialized by both the broker and the plugin. The broker passes an execution-start deadline to the plugin, and the plugin checks it before a transaction or export. Once a write has been dispatched, the broker waits for the plugin's success or failure response instead of timing out independently.

Every mutation receives a request ID. Reusing the same ID does not replay the operation when the UXP journal already contains it. Supply an explicit ID with `--request-id REQUEST_ID` when reconciling an uncertain call.

The journal is stored as `request-journal-v1.json` in the plugin-specific UXP data folder. It stores operation names, project and sequence GUIDs, revisions, status, timestamps, and digests. It does not store raw payloads, media paths, or result bodies. Terminal entries are retained for seven days and up to 500 records. Unresolved `unknown_outcome` entries are never pruned automatically.

If Premiere or the plugin exits while a request is running, the entry becomes `unknown_outcome` on the next launch. It is never replayed automatically. Reconcile it against `journal` and the current `sequence`.

List every supported command with:

```bash
premiere-gateway --help
```

### Insert or overwrite a clip

```bash
premiere-gateway timeline insert \
  --project-item PROJECT_ITEM_ID \
  --time-seconds 5 \
  --video-track 0 \
  --audio-track 0 \
  --mode overwrite \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --expect-revision REVISION \
  --confirm
```

### Rename a track

```bash
premiere-gateway timeline track rename \
  --media-type audio \
  --track 0 \
  --name Dialogue \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --expect-revision REVISION \
  --confirm
```

### Back up a project

```bash
premiere-gateway project backup \
  --output /absolute/path/project.gateway-backup.prproj \
  --expect-project PROJECT_GUID \
  --confirm
```

Existing backup files are never overwritten. `project recovery` reports the active project identity and Premiere's Auto Save location. It preserves symbolic values such as `SameAsProject` or `MyDocuments`. Premiere's public UXP API does not expose whether Auto Save is enabled, its interval, or its retention count, so those fields are reported as location-only rather than inferred.

### Export a sequence

```bash
premiere-gateway sequence export \
  --output /absolute/path/output.mov \
  --preset /absolute/path/preset.epr \
  --expect-project PROJECT_GUID \
  --expect-sequence SEQUENCE_GUID \
  --expect-revision REVISION \
  --confirm
```

Exports never overwrite an existing file. The output extension must match the selected Premiere or Adobe Media Encoder preset.

## Initial release boundaries

- Backups are explicit. Automatic backup before every mutation is not implemented.
- Media import does not have an undoable Adobe Action. It is guarded by project, sequence, timeline, and project-item revisions, the request journal, and a new-item postcondition.
- Caption track identity, name, mute state, media type, and item count are visible. Premiere 26.3 does not expose a public caption-item read/write contract, so native caption-item editing is unsupported. A sequence with caption items is marked `opaque-captions` and normal mutations stop unless `--allow-incomplete-revision true` is explicitly supplied after visual review.
- Dynamic Link editing is unsupported.
- MOGRT insertion is supported. Public primitive parameters can be edited. Source text represented by an unavailable `TextDocument` value is not edited and causes incomplete revision protection.
- Static parameter edits reject existing time-varying parameters. Keyframe commands include time, value, and interpolation in the revision.
- Clip speed and reverse state are readable but not writable because Premiere Pro 26.3 does not expose public Actions for them.
- Premiere Pro 26.3.2 can expose some transitions as opaque `null` slots. Such a snapshot is marked `opaque-transitions`, and mutations stop unless `--allow-opaque-transitions true` is explicitly supplied after visual review.
- Missing component chains produce `incomplete-components` or `multiple-incomplete` reliability. Mutations stop unless `--allow-incomplete-revision true` is explicitly supplied after visual review.
- UXP Developer Tool's `Load & Watch` does not survive a Premiere restart. Marketplace builds use Adobe's invisible application-launch mode and must be cold-start tested from an installed CCX.
- The plugin manifest allows only `ws://localhost:1966`, while the broker listens only on `127.0.0.1`. Premiere Pro 26.3.2 rejects an IP-literal manifest entry, so the manifest uses `localhost`.

## References

- [Premiere UXP API](https://developer.adobe.com/premiere-pro/uxp/)
- [Premiere DOM API](https://developer.adobe.com/premiere-pro/uxp/ppro_reference/)
- [UXP Network Operations](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/network/)
- [Adobe Premiere UXP samples](https://github.com/AdobeDocs/uxp-premiere-pro-samples)
- [Package a UXP plugin](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/package/)
- [Install a UXP plugin](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/install/)
- [UXP Panels and Commands](https://developer.adobe.com/premiere-pro/uxp/plugins/concepts/panels-and-commands/)
- [Building your first UXP plugin: Invisible plugins](https://developer.adobe.com/premiere-pro/uxp/plugins/)
- [video-skills Issue #1](https://github.com/arcmanagement/video-skills/issues/1)
