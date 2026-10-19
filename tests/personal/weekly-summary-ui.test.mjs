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
    const arrangement = (date, notes, parallel = false) => ({ list_date: date, start_time: "09:00", end_time: "10:00", actual_notes: notes, parallel });
    const item = (id, overrides = {}) => ({
      id, title: `项目行动 ${id}`, description: null, event_id: 10, event_title: "产品迭代", category_name: "工作", category_color: "#1677ff",
      event_completed: false, status: 0, completed_at: null, completed_in_week: false, planned_minutes: 60,
      arrangements: [arrangement("2026-10-05", "推进了一步")], ...overrides,
    });
    const summaries = {
      "2026-10-05": {
        space_id: "weekly-test", week_start: "2026-10-05", content: "", updated_at: 1, total_minutes: 240,
        categories: [
          { id: 1, name: "工作", color: "#1677ff", minutes: 180, percentage: 75 },
          { id: 2, name: "成长", color: "#389e0d", minutes: 60, percentage: 25 },
        ],
        items: [
          item(1, { title: "梳理需求", planned_minutes: 120, arrangements: [arrangement("2026-10-05", "第一天复盘"), arrangement("2026-10-06", "第二天复盘")] }),
          item(2, { title: "交付方案", status: 1, completed_at: new Date("2026-10-08T18:00:00").getTime(), completed_in_week: true }),
          item(3, { title: "临时完成的事项", event_id: null, event_title: null, category_name: null, status: 1,
            completed_at: new Date("2026-10-09T09:00:00").getTime(), completed_in_week: true, planned_minutes: 0, arrangements: [] }),
          item(4, { title: "上周已完成的事项", status: 1, completed_at: new Date("2026-10-02T09:00:00").getTime() }),
          item(5, { title: "并行调研", event_id: 20, event_title: "资料整理", planned_minutes: 0, arrangements: [arrangement("2026-10-07", "调研结果", true)] }),
          ...Array.from({ length: 7 }, (_, index) => item(index + 6, index < 2 ? {
            event_id: 30, event_title: "学习计划", category_name: "成长", category_color: "#389e0d",
            event_completed: true, status: 1, planned_minutes: index === 0 ? 180 : 150,
          } : index === 2 ? { event_id: 40, event_title: "直播压测", planned_minutes: 300 } : {})),
        ],
      },
      "2026-09-28": {
        space_id: "weekly-test", week_start: "2026-09-28", content: "上周复盘", updated_at: 2, total_minutes: 90,
        categories: [{ id: null, name: "未分类", color: "#8c98a5", minutes: 90, percentage: 100 }],
        items: [],
      },
      "2026-09-21": {
        space_id: "weekly-test", week_start: "2026-09-21", content: "", updated_at: 0, total_minutes: 0, categories: [], items: [],
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
            space_id: "weekly-test", week_start: args.weekStart, content: "", updated_at: 0, total_minutes: 0, categories: [], items: [],
          });
        }
        if (cmd === "save_weekly_note") {
          const previous = summaries[args.weekStart] || {
            space_id: args.spaceId, week_start: args.weekStart, total_minutes: 0, categories: [], items: [],
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
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true, animations: "disabled" });
  };
  try {
    await page.goto(`${baseUrl}/#/weekly-summary`);
    await page.getByRole("heading", { name: "周总结", exact: true }).waitFor();
    await page.getByLabel("本周已安排 4 小时", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".weekly-summary-breakdown tbody tr").allTextContents(), ["工作3 小时75%", "成长1 小时25%"]);
    const detailWidth = await page.locator(".weekly-summary-detail").evaluate((el) => el.clientWidth);
    await page.getByRole("button", { name: "收起周记录", exact: true }).click();
    assert.equal(await page.getByRole("complementary", { name: "周记录" }).getByText("最近周记录", { exact: true }).isVisible(), false);
    assert.ok(await page.locator(".weekly-summary-detail").evaluate((el) => el.clientWidth) > detailWidth);
    await page.locator(".md-wysiwyg").fill("收起周记录也可保存");
    await page.waitForFunction(() => window.weeklyFixture.summaries["2026-10-05"].content === "收起周记录也可保存");
    await page.getByRole("button", { name: "展开周记录", exact: true }).click();
    await page.getByText("最近周记录", { exact: true }).waitFor();
    const items = page.getByRole("region", { name: "本周事项", exact: true });
    assert.equal(await page.locator(".weekly-summary-notes").evaluate((el) =>
      Boolean(el.compareDocumentPosition(document.querySelector(".weekly-items")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    const showHandled = () => items.getByText("本周处理 11", { exact: true }).click();
    const showCompleted = () => items.getByText("本周完成 2", { exact: true }).click();
    await items.getByText("本周处理 11", { exact: true }).waitFor();
    assert.equal(await items.locator(".weekly-item-row").count(), 11);
    assert.equal(await items.locator(".weekly-item-row:visible").count(), 0);
    assert.equal(await items.locator('.weekly-items-group-toggle[aria-expanded="false"]').count(), 4);
    await items.getByRole("button", { name: "展开事件：产品迭代", exact: true }).click();
    assert.equal(await items.getByRole("button", { name: /展开其余|收起事项/ }).count(), 0);
    assert.deepEqual(await items.locator(".weekly-items-group-title").allTextContents(), ["产品迭代", "学习计划", "直播压测", "资料整理"]);
    await items.getByLabel("产品迭代本周安排 8 小时", { exact: true }).waitFor();
    await items.getByLabel("学习计划本周安排 5 小时 30 分钟", { exact: true }).waitFor();
    const learning = items.locator(".weekly-items-group").filter({ has: page.locator(".weekly-items-group-title", { hasText: "学习计划" }) });
    await learning.getByText("事件已完成", { exact: true }).waitFor();
    assert.equal(await items.locator(".weekly-items-group").first().getByText("事件已完成", { exact: true }).count(), 0);
    assert.deepEqual(await learning.locator(".weekly-item-duration").allTextContents(), ["3 小时", "2 小时 30 分钟"]);
    await learning.getByRole("button", { name: "展开事件：学习计划", exact: true }).click();
    await learning.getByRole("button", { name: "收起事件：学习计划", exact: true }).click();
    assert.equal(await learning.locator(".weekly-item-row:visible").count(), 0);
    await learning.getByLabel("学习计划本周安排 5 小时 30 分钟", { exact: true }).waitFor();
    await learning.getByRole("button", { name: "展开事件：学习计划", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await learning.locator(".weekly-item-row:visible").count(), 2);
    await items.scrollIntoViewIfNeeded();
    await shot("weekly-items-expanded.png");
    await learning.getByRole("button", { name: "收起事件：学习计划", exact: true }).click();
    await shot("weekly-items-collapsed.png");
    await items.getByRole("button", { name: "查看事项：梳理需求", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("第一天复盘", { exact: true }).waitFor();
    await dialog.getByText("第二天复盘", { exact: true }).waitFor();
    assert.equal(await dialog.locator(".weekly-item-arrangements li").count(), 2);
    await dialog.locator(".ant-modal-close").click();
    await showCompleted();
    assert.equal(await items.locator(".weekly-item-row").count(), 2);
    assert.deepEqual(await items.locator(".weekly-items-group-title").allTextContents(), ["产品迭代", "独立行动"]);
    await items.getByLabel("产品迭代本周安排 8 小时", { exact: true }).waitFor();
    await items.getByRole("button", { name: "展开事件：独立行动", exact: true }).click();
    await items.getByText("临时完成的事项", { exact: true }).waitFor();
    assert.equal(await items.getByText("上周已完成的事项", { exact: true }).count(), 0);
    await items.getByRole("button", { name: "查看事项：临时完成的事项", exact: true }).click();
    await dialog.getByText("未排入本周日程", { exact: true }).waitFor();
    await dialog.locator(".ant-modal-close").click();
    await items.getByRole("textbox", { name: "搜索本周事项" }).fill("不存在的事项");
    await items.getByText("没有匹配的事项", { exact: true }).waitFor();
    await items.getByRole("textbox", { name: "搜索本周事项" }).fill("");
    await showHandled();
    await items.getByRole("textbox", { name: "搜索本周事项" }).fill("项目行动 7");
    await items.getByRole("button", { name: "查看事项：项目行动 7", exact: true }).waitFor();
    await items.getByLabel("学习计划本周安排 5 小时 30 分钟", { exact: true }).waitFor();
    await items.getByRole("textbox", { name: "搜索本周事项" }).fill("资料整理");
    await items.getByRole("button", { name: "查看事项：并行调研" }).click();
    await dialog.getByText("调研结果", { exact: true }).waitFor();
    await dialog.getByText("AI 并行", { exact: true }).waitFor();
    await dialog.locator(".ant-modal-close").click();
    await items.getByRole("textbox", { name: "搜索本周事项" }).fill("");
    await page.locator(".md-wysiwyg").fill("这周推进顺利");
    await page.waitForFunction(() => window.weeklyFixture.summaries["2026-10-05"].content === "这周推进顺利");
    await shot("weekly-summary-desktop.png");

    await page.getByRole("button", { name: "上一周", exact: true }).click();
    await page.getByRole("heading", { name: "9月28日 - 10月4日", exact: true }).waitFor();
    await items.getByText("本周暂无已安排行动", { exact: true }).waitFor();
    await page.locator(".md-wysiwyg").fill("上周的新思考");
    await page.waitForFunction(() => window.weeklyFixture.summaries["2026-09-28"].content === "上周的新思考");
    await page.getByRole("button", { name: /^本\s*周$/ }).click();
    await page.waitForFunction(() => document.querySelector(".md-wysiwyg")?.textContent === "这周推进顺利");
    assert.equal(await page.locator(".weekly-summary-record").count(), 2);
    assert.equal(await items.locator(".weekly-item-row:visible").count(), 0);

    await page.getByRole("button", { name: "收起周记录", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("选择周记录", { exact: true }).waitFor();
    await items.getByText("本周处理 11", { exact: true }).waitFor();
    await shot("weekly-summary-mobile.png");
    assert.equal(await page.locator(".weekly-summary-page").evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await items.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await items.getByRole("button", { name: "展开事件：学习计划", exact: true }).click();
    assert.equal(await learning.locator(".weekly-item-row:visible").count(), 2);
    await items.getByRole("button", { name: "收起事件：学习计划", exact: true }).click();
    assert.equal(await learning.locator(".weekly-item-row:visible").count(), 0);
    await items.scrollIntoViewIfNeeded();
    await shot("weekly-groups-mobile.png");
    await items.getByRole("button", { name: "展开事件：产品迭代", exact: true }).click();
    await items.getByRole("button", { name: "查看事项：梳理需求" }).click();
    await dialog.getByText("第一天复盘", { exact: true }).waitFor();
    await shot("weekly-item-mobile.png");
    assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await dialog.locator(".ant-modal-close").click();

    await page.setViewportSize({ width: 1280, height: 850 });
    await page.getByRole("button", { name: "展开周记录", exact: true }).click();
    await page.getByText("最近周记录", { exact: true }).waitFor();
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.locator("#feature-aiParallel").click();
    await page.getByRole("link", { name: "周总结", exact: true }).click();
    await items.getByText("本周处理 10", { exact: true }).waitFor();
    await items.getByRole("textbox", { name: "搜索本周事项" }).fill("并行调研");
    await items.getByText("没有匹配的事项", { exact: true }).waitFor();
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
