import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1422";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("daily statistics totals, live edits, dates, category errors and responsive layout", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date("2026-09-28T12:00:00") });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    // Existing preferences from before the statistics option must still work.
    localStorage.setItem("lifeplan-optional-features-v1", JSON.stringify({ workLog: true, templates: true, rewards: true, pomodoro: true, insights: true }));
    const actions = [
      { id: 1, event_id: 1, title: "推进项目", status: 0, estimated_hours: 12 },
      { id: 2, event_id: 2, title: "阅读与学习", status: 1, estimated_hours: 0.5 },
      { id: 3, title: "整理日常事务", status: 0, estimated_hours: 0.5 },
      { id: 4, event_id: 2, title: "学习实践", status: 0, estimated_hours: 0.5 },
    ];
    const events = [
      { id: 1, category_id: 10, category_name: "工作", category_color: "#1677ff" },
      { id: 2, category_id: 20, category_name: "成长", category_color: "#389e0d" },
    ];
    const makeSlot = (id, start, end, action) => ({
      id, list_date: "2026-09-28", start_time: start, end_time: end,
      action_id: action?.id, action, sort_order: id,
    });
    const slots = [
      makeSlot(1, "09:00", "10:30", actions[0]),
      makeSlot(2, "10:30", "11:00", actions[0]),
      makeSlot(3, "11:00", "12:00", actions[1]),
      makeSlot(4, "13:00", "14:00", actions[2]),
      makeSlot(5, "14:00", "14:30"),
    ];
    window.statsFixture = { slots, actions, events, failEvents: false };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        if (cmd === "get_events") {
          if (window.statsFixture.failEvents) throw Error("Category load failed");
          return structuredClone(events);
        }
        if (cmd === "get_actions") return structuredClone(actions);
        if (cmd === "get_ai_tasks") return [];
        if (cmd === "get_daily_schedule") {
          if (args.listDate === "2026-09-27") {
            return new Promise((resolve) => { window.resolveOldSchedule = () => resolve({ list_date: args.listDate, slots: [] }); });
          }
          return { list_date: args.listDate, slots: structuredClone(
            args.listDate === "2026-09-28" ? slots :
              args.listDate === "2026-09-26" ? [{ ...slots[2], list_date: args.listDate }] : [],
          ) };
        }
        if (cmd === "assign_daily_slot_action") {
          const slot = slots.find((item) => item.id === args.slotId);
          slot.action_id = args.actionId;
          slot.action = actions.find((item) => item.id === args.actionId);
          return structuredClone(slot);
        }
        if (cmd === "update_daily_slot") {
          Object.assign(slots.find((item) => item.id === args.payload.id), args.payload);
          return structuredClone(slots.find((item) => item.id === args.payload.id));
        }
        if (cmd === "get_daily_used_dates") return ["2026-09-28", "2026-09-26"];
        if (cmd === "get_recurring_actions") return [];
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const region = page.getByRole("region", { name: "数据统计" });
  const total = (label) => region.getByLabel(`已安排总时长 ${label}`, { exact: true }).waitFor();
  const chooseDate = async (date) => {
    await page.locator(".daily-date-panel input").fill(date);
    await page.locator(".daily-date-panel input").press("Enter");
  };
  const reopen = async () => {
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("link", { name: "今日事", exact: true }).click();
  };
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
  };
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await total("4 小时");
    const rows = region.locator("tbody tr");
    assert.deepEqual(await rows.allTextContents(), ["工作2 小时50%", "成长1 小时25%", "未分类1 小时25%"]);
    assert.deepEqual(await region.locator(".daily-statistics-bar > span").evaluateAll((els) => els.map((el) => el.style.width)), ["50%", "25%", "25%"]);
    await shot("daily-statistics-desktop.png");

    await page.locator(".daily-plan-cell.empty").click();
    await page.getByRole("dialog").getByRole("button", { name: /学习实践/ }).click();
    await total("4 小时 30 分钟");
    await page.locator(".daily-time-cell").last().click();
    await page.getByRole("dialog").getByRole("button", { name: "14:30", exact: true }).click();
    await page.getByRole("option", { name: "15:00", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^保\s*存$/ }).click();
    await total("5 小时");

    await chooseDate("2026年09月27日");
    await page.waitForFunction(() => typeof window.resolveOldSchedule === "function");
    await chooseDate("2026年09月26日");
    await total("1 小时");
    await page.evaluate(() => window.resolveOldSchedule());
    await page.waitForFunction(() => document.querySelector(".daily-statistics time")?.dateTime === "2026-09-26");
    assert.deepEqual(await rows.allTextContents(), ["成长1 小时100%"]);
    await chooseDate("2026年09月25日");
    await total("0 分钟");
    await region.getByText("当日暂无已安排行动", { exact: true }).waitFor();
    assert.equal(await region.locator("tbody tr").count(), 0);

    await page.evaluate(() => { window.statsFixture.failEvents = true; });
    await reopen();
    await region.getByText("分类统计加载失败", { exact: true }).waitFor();
    assert.equal(await region.locator("table").count(), 0);
    await page.getByRole("button", { name: "整理日常事务", exact: true }).waitFor();
    await page.evaluate(() => { window.statsFixture.failEvents = false; });
    await region.getByRole("button", { name: /^重\s*试$/ }).click();
    await total("5 小时");

    await page.evaluate(() => {
      window.statsFixture.events[1].category_name = "长期成长与知识管理PersonalGrowthAndKnowledgeManagement";
      window.statsFixture.events[0].category_id = 20;
      window.statsFixture.events[0].category_name = window.statsFixture.events[1].category_name;
      window.statsFixture.events[0].category_color = "#389e0d";
    });
    await reopen();
    await total("5 小时");
    assert.equal(await rows.count(), 2);
    assert.match((await rows.allTextContents())[0], /4 小时80%/);
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await region.scrollIntoViewIfNeeded();
      await shot(`daily-statistics-${width}.png`);
      assert.equal(await region.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      assert.equal(await region.locator("table").evaluate((el) => el.scrollWidth <= el.clientWidth), true);
      assert.equal(await rows.first().locator("th").evaluate((el) => {
        const label = el.querySelector(".daily-statistics-category > span").getBoundingClientRect();
        const time = el.nextElementSibling.getBoundingClientRect();
        return label.right <= time.left && label.width > 0;
      }), true);
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    await shot("daily-statistics-failure.png");
    throw error;
  } finally {
    await browser.close();
  }
});
