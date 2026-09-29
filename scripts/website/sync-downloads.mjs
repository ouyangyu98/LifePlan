import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repository = "ouyangyu98/LifePlan";
const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
  headers, signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Release lookup failed (${response.status}); the current download manifest was not changed.`);
const release = await response.json();
if (release.draft || release.prerelease || !release.tag_name || !Array.isArray(release.assets)) {
  throw new Error("Only a published stable release may populate the download page.");
}
const definitions = [
  { id: "mac-arm", name: "macOS", architecture: "Apple Silicon", detail: "适用于 M 系列芯片", extension: "DMG", pattern: /(?:aarch64|arm64).*\.dmg$/i },
  { id: "windows", name: "Windows", architecture: "x64", detail: "适用于 Intel / AMD 64 位电脑", extension: "EXE", pattern: /(?:x64|x86_64).*\.exe$/i },
  { id: "mac-intel", name: "macOS", architecture: "Intel", detail: "适用于 Intel 芯片 Mac", extension: "DMG", pattern: /(?:x64|x86_64).*\.dmg$/i },
];
const platforms = [];
for (const { pattern, ...platform } of definitions) {
  const matching = release.assets.filter(asset => pattern.test(asset.name) && asset.state === "uploaded");
  if (matching.length !== 1) throw new Error(`Expected one verified ${platform.id} asset, found ${matching.length}.`);
  const asset = matching[0];
  const url = new URL(asset.browser_download_url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${repository}/releases/download/`)) {
    throw new Error(`Unexpected download origin for ${asset.name}.`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 300 * 1024 * 1024) {
    throw new Error(`Unexpected asset size for ${asset.name}.`);
  }
  const download = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!download.ok || !download.body) throw new Error(`Download verification failed for ${asset.name}: ${download.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of download.body) {
    bytes += chunk.length;
    if (bytes > asset.size) throw new Error(`Downloaded size exceeds the published size for ${asset.name}.`);
    hash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (bytes !== asset.size || (asset.digest && asset.digest !== `sha256:${sha256}`)) {
    throw new Error(`Checksum or size mismatch for ${asset.name}.`);
  }
  platforms.push({ ...platform, asset: { name: asset.name, url: url.toString(), bytes, sha256 } });
}
await writeFile(fileURLToPath(new URL("../../website/src/downloads.json", import.meta.url)), `${JSON.stringify({
  version: release.tag_name, publishedAt: release.published_at, releaseUrl: release.html_url, platforms,
}, null, 2)}\n`);
console.log(`Verified all ${platforms.length} downloads from ${release.tag_name}. Rebuild the website before deploying.`);
