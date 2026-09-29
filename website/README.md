# LifePlan Website

Production URL: `https://ouyangyu.tech/life/`

This is the website for ouyangyu98's independently maintained edition. It must
not claim to be the upstream author's official distribution. The existing
domain homepage and the client's onboarding pages are outside this site's scope.

## Development

Uses the repository's existing React, Vite, TypeScript and Lucide dependencies.
No additional dependencies are required.

```sh
npm run website:dev
npm run website:check
npm run website:build
```

Development URL: `http://127.0.0.1:1423/life/`

The worker serves only `/life` and `/life/*`. Its asset binding strips the
prefix; Vite generates links with `/life/` as the base. Do not bind it to `/*`
or replace the existing homepage.

## Product Images

`scripts/website/capture-product.mjs` captures the current application with
isolated, fictional fixtures. It does not connect to the desktop database.
Set `PLAYWRIGHT_PATH` to an existing Playwright installation when needed.
The app development server must already be running on port 1420.

Never publish screenshots from the user's real desktop session.

## Downloads

`src/downloads.json` is the single source of truth for download metadata.
A missing asset renders a disabled, explicitly unpublished download button.
Never substitute upstream releases for this edition.

Only add assets after they have been published and verified. Include the exact
asset URL, byte size and SHA-256 checksum. Keep version and platform metadata
consistent across all three download options.

After publishing all three installation packages, update metadata with:

```sh
node scripts/website/sync-downloads.mjs
```

This verifies every binary's size and SHA-256 before replacing the manifest.
`GITHUB_TOKEN` is optional for GitHub API rate limits; it is never written to
the generated website. The command fails without changing the manifest if
any platform is missing or a binary cannot be verified.

## Verification

```sh
node --test tests/website/worker.test.mjs
node --test tests/website/site-ui.test.mjs
```

UI test screenshots go to the ignored `personal.local/website-check` directory.
Tests cover desktop/mobile overflow, image loading, the first viewport,
navigation, gallery keyboard interaction, the image dialog, FAQs and downloads.
Set `WEBSITE_REQUIRE_DOWNLOADS=1` after publication to require working links
for all three platforms and to check expanded checksums on mobile.

## Deployment

Use an already-authorized Wrangler installation:

```sh
wrangler deploy --config website/wrangler.jsonc
```

Verify the product URL, JS/CSS and images after deployment, and confirm that
`https://ouyangyu.tech/` still serves the original project homepage.
