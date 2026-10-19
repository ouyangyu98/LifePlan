import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1420";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("daily activity groups distinct actions, counts actual completions, refreshes and respects feature switches", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date("2026-10-19T12:00:00") });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    localStorage.setItem("lifeplan-optional-features-v1", JSON.stringify({ aiParallel: true, dailyStatistics: true, reviewExpectation: false }));
    const events = [
      { id: 10, title: "产品迭代", status: 1, category_id: 1, category_name: "工作", category_color: "#1677ff" },
      { id: 20, title: "学习计划", status: 5, category_id: 2, category_name: "成长", category_color: "#16846c" },
    ];
    const actions = [
      { id: 1, event_id: 10, event_title: "产品迭代", title: "需求文档", status: 0 },
      { id: 2, event_id: 20, event_title: "学习计划", title: "完成阅读", status: 1, completed_at: new Date("2026-10-18T18:00:00").getTime() },
      { id: 3, title: "未排期的临时完成事项", status: 1, completed_at: new Date("2026-10-19T00:00:00").getTime() },
      { id: 4, event_id: 10, event_title: "产品迭代", title: "AI 调研", status: 0 },
    ];
    const slots = [
      { id: 101, start_time: "09:00", end_time: "10:00", action_id: 1, actual_notes: "明确需求边界", focused: 1 },
      { id: 102, start_time: "10:00", end_time: "10:30", action_id: 1 },
      { id: 103, start_time: "10:30", end_time: "11:00", action_id: 2 },
    ];
    const tasks = [
      { id: 201, slot_id: 101, action_id: 1, linked_action_id: 4, list_date: "2026-10-19", title: "AI 调研", status: "queued", result: "调研结果", start_time: "09:00", end_time: "10:00" },
    ];
    window.activityFixture = { failItems: false, itemCalls: [], actions, slots };
    const readSlot = (slot, date) => ({ ...slot, list_date: date, action: structuredClone(actions.find((action) => action.id === slot.action_id)) });
    const items = (date) => {
      if (date !== "2026-10-19") return [];
      return actions.map((action) => {
        const event = events.find((item) => item.id === action.event_id);
        const arrangements = slots.filter((slot) => slot.action_id === action.id).map((slot) => ({
          list_date: date, start_time: slot.start_time, end_time: slot.end_time, actual_notes: slot.actual_notes ?? null, parallel: false,
        }));
        if (action.id === 4) arrangements.push({
          list_date: date, start_time: "09:00", end_time: "10:00", actual_notes: "调研结果", parallel: true,
        });
        return {
          ...action, description: null, event_id: event?.id ?? null, event_title: event?.title ?? null,
          category_name: event?.category_name ?? null, category_color: event?.category_color ?? null,
          event_completed: event?.status === 5, completed_at: action.completed_at ?? null,
          completed_in_week: action.status === 1 && action.completed_at >= new Date("2026-10-19T00:00:00").getTime()
            && action.completed_at < new Date("2026-10-20T00:00:00").getTime(),
          planned_minutes: action.id === 1 ? 90 : action.id === 2 ? 30 : 0, arrangements,
        };
      });
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        if (cmd === "get_events") return structuredClone(events);
        if (cmd === "get_actions") return structuredClone(actions);
        if (cmd === "get_daily_schedule") return {
          list_date: args.listDate, slots: args.listDate === "2026-10-19" ? slots.map((slot) => readSlot(slot, args.listDate)) : [],
        };
        if (cmd === "get_daily_activity_items") {
          window.activityFixture.itemCalls.push(args.listDate);
          if (window.activityFixture.failItems) throw Error("当日事项读取失败，请重试");
          if (args.listDate === "2026-10-18") return new Promise((resolve) => { window.resolveOldActivity = () => resolve(items("2026-10-19")); });
          return structuredClone(items(args.listDate));
        }
        if (cmd === "get_daily_event_pool") return { space_id: "activity-test", list_date: args.listDate, event_ids: [], entries: [] };
        if (cmd === "get_ai_tasks") return args.listDate === "2026-10-19" ? structuredClone(tasks) : [];
        if (cmd === "get_daily_used_dates" || cmd === "get_recurring_actions") return [];
        if (cmd === "update_daily_slot_review") {
          const slot = slots.find((item) => item.id === args.payload.id);
          Object.assign(slot, args.payload); return readSlot(slot, "2026-10-19");
        }
        if (cmd === "complete_action" || cmd === "restore_action") {
          const action = actions.find((item) => item.id === args.id);
          action.status = cmd === "complete_action" ? 1 : 0;
          action.completed_at = cmd === "complete_action" ? new Date("2026-10-19T12:00:00").getTime() : null;
          return structuredClone(action);
        }
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const region = page.getByRole("region", { name: "当日事项", exact: true });
  const chooseDate = async (date) => {
    await page.locator(".daily-date-panel input").fill(date);
    await page.locator(".daily-date-panel input").press("Enter");
  };
  const settings = async () => {
    await page.locator(".sidebar").getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("heading", { name: "可选功能", exact: true }).waitFor();
  };
  const daily = () => page.locator(".sidebar").getByRole("link", { name: "今日事", exact: true }).click();
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true, animations: "disabled" });
  };
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await region.getByText("当日推进 3", { exact: true }).waitFor();
    await region.getByText("当日完成 1", { exact: true }).waitFor();
    assert.equal(await region.locator(".weekly-item-row:visible").count(), 0);
    assert.deepEqual(await region.locator(".weekly-items-group-title").allTextContents(), ["产品迭代", "学习计划"]);
    await region.getByLabel("产品迭代当日安排 1 小时 30 分钟", { exact: true }).waitFor();
    await region.getByRole("button", { name: "展开事件：产品迭代", exact: true }).click();
    assert.equal(await region.getByRole("button", { name: "查看事项：需求文档", exact: true }).count(), 1);
    await region.getByRole("button", { name: "查看事项：需求文档", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("当日安排与复盘", { exact: true }).waitFor();
    assert.equal(await dialog.locator(".weekly-item-arrangements li").count(), 2);
    await dialog.getByText("明确需求边界", { exact: true }).waitFor();
    await dialog.locator(".ant-modal-close").click();
    await region.getByText("当日完成 1", { exact: true }).click();
    await region.getByRole("button", { name: "展开事件：独立行动", exact: true }).click();
    await region.locator(".weekly-item-meta").filter({ hasText: "未排入当日日程" }).waitFor();
    assert.equal(await region.getByRole("button", { name: "查看事项：完成阅读", exact: true }).count(), 0);
    await shot("daily-activity-completed.png");
    await region.getByRole("textbox", { name: "搜索当日事项" }).fill("不存在");
    await region.getByText("没有匹配的事项", { exact: true }).waitFor();
    await region.getByRole("textbox", { name: "搜索当日事项" }).fill("");
    await region.getByText("当日推进 3", { exact: true }).click();
    await region.getByRole("button", { name: "展开事件：学习计划", exact: true }).click();
    await region.getByText("事件已完成", { exact: true }).waitFor();

    await page.locator(".daily-review-cell").first().click();
    await dialog.getByRole("checkbox", { name: "已完成行动", exact: true }).check();
    await dialog.getByRole("button", { name: "保存复盘", exact: true }).click();
    await region.getByText("当日完成 2", { exact: true }).waitFor();
    await page.locator(".daily-review-cell").first().click();
    await dialog.getByRole("button", { name: "恢复行动", exact: true }).click();
    await dialog.locator(".ant-modal-close").click();
    await region.getByText("当日完成 1", { exact: true }).waitFor();

    await chooseDate("2026年10月18日");
    await page.waitForFunction(() => typeof window.resolveOldActivity === "function");
    await chooseDate("2026年10月17日");
    await region.getByText("当日推进 0", { exact: true }).waitFor();
    await page.evaluate(() => window.resolveOldActivity());
    assert.equal(await region.getByText("当日推进 0", { exact: true }).count(), 1);
    await region.getByText("当日暂无已安排行动", { exact: true }).waitFor();
    await settings();
    await page.evaluate(() => { window.activityFixture.failItems = true; });
    await daily();
    await page.getByText("当日事项读取失败，请重试", { exact: true }).waitFor();
    await page.evaluate(() => { window.activityFixture.failItems = false; });
    await page.getByRole("button", { name: /^重\s*试$/ }).click();
    await region.getByText("当日推进 3", { exact: true }).waitFor();
    await settings();
    await page.locator("#feature-aiParallel").click();
    await daily();
    await region.getByText("当日推进 2", { exact: true }).waitFor();
    await region.getByRole("textbox", { name: "搜索当日事项" }).fill("AI 调研");
    await region.getByText("没有匹配的事项", { exact: true }).waitFor();
    await region.getByRole("textbox", { name: "搜索当日事项" }).fill("");
    await page.setViewportSize({ width: 390, height: 844 });
    await region.scrollIntoViewIfNeeded();
    await shot("daily-activity-mobile.png");
    assert.equal(await region.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await settings();
    await page.locator("#feature-dailyStatistics").click();
    await page.evaluate(() => { window.activityFixture.itemCalls = []; });
    await daily();
    await page.locator(".daily-plan-cell").first().waitFor();
    assert.equal(await region.count(), 0);
    assert.equal(await page.evaluate(() => window.activityFixture.itemCalls.length), 0);
    assert.deepEqual(errors, []);
  } catch (error) { await shot("daily-activity-failure.png"); throw error; }
  finally { await browser.close(); }
});
