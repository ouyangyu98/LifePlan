# LifePlan OY Releases

This repository publishes ouyangyu98's independent edition, not upstream builds.

## Identity And Data

- Installed app: `LifePlan OY`
- Identifier: `com.ouyangyu98.lifeplan`
- Binary: `lifeplan-oy`
- Stable data directory: `<system data directory>/LifePlanTodolist-ouyangyu98`
- Existing personal developer data: `LifePlanTodolist-ouyangyu98-dev`
- Updater: `https://github.com/ouyangyu98/LifePlan/releases/latest/download/latest.json`

Release builds ignore runtime `LIFEPLAN_ENV`; only the build-time channel applies.
Development builds may override the channel, but always remain in the independent
edition's namespace. No existing database is copied, opened or migrated by this
release process. Back up data before any future manual transfer.

## Publishing

1. Keep versions in package.json, package-lock.json, Cargo.toml, Cargo.lock and
   tauri.conf.json identical.
2. Run `npm run test:release`, `npm run build` and the Rust channel tests.
3. Push the reviewed commit and a matching `vX.Y.Z` tag.
   If the tag event does not start a run, dispatch the release workflow from
   `main` with that existing tag. Do not move or overwrite a version tag.
4. The release workflow builds Windows x64, macOS Apple Silicon and macOS Intel.
5. All three builds must finish before a draft release is created. Assets,
   updater signatures, latest.json and SHA256SUMS.txt are uploaded before the
   release becomes public. Existing public releases cannot be overwritten.
6. Run `node scripts/website/sync-downloads.mjs`, rebuild and deploy the website
   as described in website/README.md.

Repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` hold the updater signing material.
Only the public key belongs in source control. Keep an encrypted backup of the
private key and its password: replacing the public key prevents old clients
from accepting subsequent updates.

Updater signatures are not operating-system signing certificates. This edition
currently has no Apple notarization or Windows commercial code-signing
certificate. macOS bundles use ad-hoc signing. Keep this limitation visible on
the website and in release notes; never recommend disabling OS protections.
