# Gateway for Premiere repository rules

This repository is the source of truth for the local gateway that lets AI agents safely read and edit the project and sequence currently open in Adobe Premiere Pro.

## Boundaries

- Treat the Premiere project as the source of truth. Do not replace the post-edit source of truth with XML or external JSON.
- Use the Premiere UXP plugin, the fixed-token loopback broker, and the CLI as the standard path.
- Do not expose arbitrary JavaScript, ExtendScript, or the unsupported QE DOM.
- Every mutation must be allowlisted and explicitly confirmed. It must match the active project, active sequence, and timeline revision, and it must use an undoable transaction when Premiere exposes an Action.
- The fixed protocol token is `gateway-for-premiere`. It is not a credential. The broker must listen only on `127.0.0.1`, HTTP must require a custom header that normal browser requests do not send, and plugin WebSocket connections must accept only the measured Premiere UXP origin `file://` while rejecting HTTP(S) browser origins.
- `plugin/dist/` and `plugin/marketplace-dist/` are generated artifacts and are not sources of truth.
- The root `dist/` directory is a versioned release artifact for installing the CLI from GitHub. Keep it synchronized with `src/` through `npm run verify:dist`.
- Add MCP only as an adapter over the existing broker contract. Do not duplicate Premiere operations.

## Changes

- Check the target Premiere version against the official Premiere UXP API and official samples.
- If an operation is unavailable in the public UXP DOM, do not fall back automatically to ExtendScript or QE DOM.
- Treat caption editing, MOGRT, Dynamic Link, and effect parameters as separate read, write, and round-trip boundaries.
- Do not call an edit complete based only on a successful build or command. Inspect a real video or project.
- Use a test project or a backup for mutations. Do not modify a user's production project directly.

## Verification

```bash
npm run check
npm test
npm run build
npm run verify:dist
```

When plugin or DOM behavior changes, verify the plugin connection, snapshot, target operation, undo path, and state after reopening the project in Premiere Pro.
