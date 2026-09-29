import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const base = process.env.WEBSITE_TEST_URL || "http://127.0.0.1:1423/life/";
const screenshots = process.env.UI_SCREENSHOT_DIR || "personal.local/website-check";
const requireDownloads = process.env.WEBSITE_REQUIRE_DOWNLOADS === "1";

test("website renders real assets, responsive layouts, accessible navigation, gallery and honest downloads", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mkdir(screenshots, { recursive: true });
  try {
    for (const [width, height] of [[1440, 900], [1920, 1080], [768, 1024], [390, 844], [360, 780]]) {
      await page.setViewportSize({ width, height });
      await page.goto(base);
      await page.getByRole("heading", { name: "LifePlan.", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => { for (const image of document.images) image.loading = "eager"; });
      await page.locator("footer").scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `No horizontal overflow at ${width}`);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      const firstFold = await page.locator(".principles-strip").boundingBox();
      assert.ok(firstFold.y < height, `The next section is visible at ${width}`);
      const screenshotName = `${width}-website.png`;
      await page.screenshot({ path: path.join(screenshots, screenshotName), fullPage: true });
      await page.screenshot({ path: path.join(screenshots, `${width}-first-fold.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await page.getByRole("tab", { name: "事件篮", exact: true }).click();
    assert.equal(await page.getByRole("tab", { name: "事件篮", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("button", { name: "放大查看事件篮界面", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "事件篮界面大图", exact: true });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "放大查看事件篮界面");
    await page.getByRole("tab", { name: "事件篮", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: /心得/ }).getAttribute("aria-selected"), "true");
    await page.getByRole("button", { name: "放大查看心得界面", exact: true }).click();
    await page.getByRole("button", { name: "关闭大图", exact: true }).click();
    await page.getByText("这里的 AI 任务会自动执行吗？", { exact: true }).click();
    const faq = page.locator(".faq-list details").filter({ hasText: "这里的 AI 任务会自动执行吗？" });
    assert.equal(await faq.getAttribute("open"), "");
    assert.match(await faq.textContent(), /不会。/);
    for (const anchor of await page.locator('a[target="_blank"]').all()) {
      assert.match(await anchor.getAttribute("rel"), /noopener/);
      assert.match(await anchor.getAttribute("href"), /^https:\/\/github\.com\//);
    }
    assert.equal(await page.locator(".download-card").count(), 2);
    for (const card of await page.locator(".download-card").all()) {
      const download = card.locator(".download-button");
      if (requireDownloads) assert.ok(await download.getAttribute("href"), "Every platform must be downloadable");
      if (await download.getAttribute("href")) {
        assert.match(await download.getAttribute("href"), /^https:\/\/github\.com\/ouyangyu98\/LifePlan\/releases\/download\//);
        await card.locator(".checksum summary").click();
        assert.match(await card.locator(".checksum code").textContent(), /^[a-f0-9]{64}$/);
      } else {
        assert.equal(await download.isDisabled(), true);
        assert.match(await download.textContent(), /准备中/);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    if (requireDownloads) {
      for (const summary of await page.locator(".checksum summary").all()) await summary.click();
      await page.locator(".installation-note summary").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator("#downloads").screenshot({ path: path.join(screenshots, "mobile-downloads.png") });
    }
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "与 AI 并行", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "打开导航", exact: true }).getAttribute("aria-expanded"), "false");
    assert.match(page.url(), /#parallel$/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
