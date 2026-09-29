import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));

test("independent installer identity and updater never target upstream", () => {
  assert.equal(config.identifier, "com.ouyangyu98.lifeplan");
  assert.equal(config.productName, "LifePlan OY");
  assert.equal(config.mainBinaryName, "lifeplan-oy");
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/ouyangyu98/LifePlan/releases/latest/download/latest.json",
  ]);
  const publicKey = Buffer.from(config.plugins.updater.pubkey, "base64").toString("utf8");
  assert.match(publicKey, /minisign public key: 74E3C386F944CECE/);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.doesNotMatch(read("src-tauri/src/lib.rs"), /github\.com\/9527GC\/LifePlan\/releases/);
});

test("all release and lockfile versions agree", () => {
  assert.equal(JSON.parse(read("package.json")).version, config.version);
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, config.version);
  assert.equal(lock.packages[""].version, config.version);
  assert.equal(read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1], config.version);
  assert.equal(read("src-tauri/Cargo.lock").match(/name = "life-plan-todolist"\nversion = "([^"]+)"/)?.[1], config.version);
});

test("development sessions do not install production updates", () => {
  assert.match(read("src/lib/updater.ts"), /if \(import\.meta\.env\.DEV\) return null;\s+return check\(\)/);
});

test("every packaging workflow preserves the independent channel", () => {
  for (const name of ["release.yml", "build-macos.yml"]) {
    const workflow = read(`.github/workflows/${name}`);
    assert.match(workflow, /LIFEPLAN_ENV: ouyangyu98/);
    assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:/);
  }
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /--tag "\$RELEASE_TAG"/);
  assert.doesNotMatch(workflow, /^\s+GITHUB_REF_NAME:/m);
  assert.match(workflow, /--draft --verify-tag/);
  assert.ok(workflow.indexOf("gh release upload") < workflow.indexOf("--draft=false --latest"));
  assert.equal(JSON.parse(read("src-tauri/tauri.macos.conf.json")).bundle.macOS.signingIdentity, "-");
});
