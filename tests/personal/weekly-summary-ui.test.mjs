import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1422";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("weekly summary keeps planned time, weekly notes, history and optional visibility", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-09T12:00:00") });
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    const summaries = {
      "2026-10-05": {
        space_id: "weekly-test", week_start: "2026-10-05", content: "", updated_at: 1, total_minutes: 240,
        categories: [
          { id: 1, name: "工作", color: "#1677ff", minutes: 180, percentage: 75 },
          { id: 2, name: "成长", color: "#389e0d", minutes: 60, percentage: 25 },
        ],
      },
      "2026-09-28": {
        space_id: "weekly-test", week_start: "2026-09-28", content: "上周复盘", updated_at: 2, total_minutes: 90,
        categories: [{ id: null, name: "未分类", color: "#8c98a5", minutes: 90, percentage: 100 }],
      },
      "2026-09-21": {
        space_id: "weekly-test", week_start: "2026-09-21", content: "", updated_at: 0, total_minutes: 0, categories: [],
      },
    };
    window.weeklyFixture = { summaries };
    window.calls = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        window.calls.push({ cmd, args });
        if (cmd === "get_startup_notice" || cmd === "get_events" || cmd === "get_actions" || cmd === "get_ai_tasks") return cmd === "get_startup_notice" ? null : [];
        if (cmd === "get_weekly_summary") {
          return structuredClone(summaries[args.weekStart] || {
            space_id: "weekly-test", week_start: args.weekStart, content: "", updated_at: 0, total_minutes: 0, categories: [],
          });
        }
        if (cmd === "save_weekly_note") {
          const previous = summaries[args.weekStart] || {
            space_id: args.spaceId, week_start: args.weekStart, total_minutes: 0, categories: [],
          };
          summaries[args.weekStart] = { ...previous, content: args.content, updated_at: Date.now() };
          return structuredClone(summaries[args.weekStart]);
        }
        if (cmd === "list_weekly_records") {
          const all = Object.values(summaries)
            .filter((item) => item.content.trim() || item.total_minutes)
            .sort((a, b) => b.week_start.localeCompare(a.week_start));
          const filtered = args.beforeWeekStart ? all.filter((item) => item.week_start < args.beforeWeekStart) : all;
          return structuredClone(filtered.slice(0, args.limit));
        }
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
  };
  try {
    await page.goto(`${baseUrl}/#/weekly-summary`);
    await page.getByRole("heading", { name: "周总结", exact: true }).waitFor();
    await page.getByLabel("本周已安排 4 小时", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".weekly-summary-breakdown tbody tr").allTextContents(), ["工作3 小时75%", "成长1 小时25%"]);
    await page.locator(".md-wysiwyg").fill("这周推进顺利");
    await page.waitForFunction(() => window.weeklyFixture.summaries["2026-10-05"].content === "这周推进顺利");
    await shot("weekly-summary-desktop.png");

    await page.getByRole("button", { name: "上一周", exact: true }).click();
    await page.getByRole("heading", { name: "9月28日 - 10月4日", exact: true }).waitFor();
    await page.locator(".md-wysiwyg").fill("上周的新思考");
    await page.waitForFunction(() => window.weeklyFixture.summaries["2026-09-28"].content === "上周的新思考");
    await page.getByRole("button", { name: /^本\s*周$/ }).click();
    await page.waitForFunction(() => document.querySelector(".md-wysiwyg")?.textContent === "这周推进顺利");
    assert.equal(await page.locator(".weekly-summary-record").count(), 2);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("选择周记录", { exact: true }).waitFor();
    await shot("weekly-summary-mobile.png");
    assert.equal(await page.locator(".weekly-summary-page").evaluate((el) => el.scrollWidth <= el.clientWidth), true);

    await page.setViewportSize({ width: 1280, height: 850 });
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.locator("#feature-weeklySummary").click();
    assert.equal(await page.getByRole("link", { name: "周总结", exact: true }).count(), 0);
    const callsBeforeRedirect = await page.evaluate(() => window.calls.filter((call) => call.cmd.includes("weekly")).length);
    await page.evaluate(() => { window.location.hash = "#/weekly-summary"; });
    await page.waitForURL("**/#/daily-list");
    assert.equal(await page.evaluate(() => window.calls.filter((call) => call.cmd.includes("weekly")).length), callsBeforeRedirect);
    assert.deepEqual(errors, []);
  } catch (error) {
    await shot("weekly-summary-failure.png");
    throw error;
  } finally {
    await browser.close();
  }
});
