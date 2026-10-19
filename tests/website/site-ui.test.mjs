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
const expectedVersion = process.env.WEBSITE_EXPECT_VERSION;

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
    for (const label of ["每日回顾", "周总结"]) {
      await page.getByRole("tab", { name: new RegExp(`^${label}`) }).click();
      await page.getByRole("button", { name: `放大查看${label}界面`, exact: true }).click();
      const preview = page.getByRole("dialog", { name: `${label}界面大图`, exact: true });
      await preview.waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector(".image-dialog img");
        return image?.complete && image.naturalWidth > 0;
      });
      assert.equal(await preview.locator("img").evaluate(el => el.complete && el.naturalWidth > 0), true);
      await preview.getByRole("button", { name: "关闭大图", exact: true }).click();
    }
    await page.getByRole("heading", { name: "从梳理，到每天的推进与回顾。", exact: true }).waitFor();
    await page.getByText("时间、推进事项和完成事项分别怎么算？", { exact: true }).click();
    const countingFaq = page.locator(".faq-list details").filter({ hasText: "时间、推进事项和完成事项分别怎么算？" });
    assert.match(await countingFaq.textContent(), /不是自动测得的实际工作时长/);
    assert.match(await countingFaq.textContent(), /恢复为待办/);
    await page.getByText("更新版本会丢失历史数据吗？", { exact: true }).click();
    assert.match(await page.locator(".faq-list details").filter({ hasText: "更新版本会丢失历史数据吗？" }).textContent(), /沿用原有数据目录/);
    await page.getByText("这里的 AI 任务会自动执行吗？", { exact: true }).click();
    const faq = page.locator(".faq-list details").filter({ hasText: "这里的 AI 任务会自动执行吗？" });
    assert.equal(await faq.getAttribute("open"), "");
    assert.match(await faq.textContent(), /不会。/);
    for (const anchor of await page.locator('a[target="_blank"]').all()) {
      assert.match(await anchor.getAttribute("rel"), /noopener/);
      assert.match(await anchor.getAttribute("href"), /^https:\/\/github\.com\//);
    }
    assert.equal(await page.locator(".download-card").count(), 2);
    if (expectedVersion) await page.locator(".release-badge").getByText(expectedVersion, { exact: true }).waitFor();
    for (const card of await page.locator(".download-card").all()) {
      const download = card.locator(".download-button");
      if (requireDownloads) assert.ok(await download.getAttribute("href"), "Every platform must be downloadable");
      if (await download.getAttribute("href")) {
        assert.match(await download.getAttribute("href"), /^https:\/\/github\.com\/ouyangyu98\/LifePlan\/releases\/download\//);
        if (expectedVersion) assert.ok((await download.getAttribute("href")).includes(`/releases/download/${expectedVersion}/`));
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
