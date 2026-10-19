import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1420";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("expanded daily pool stays pinned while late slots scroll and accept dragged actions", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const [width, height] of [[1280, 900], [1050, 650], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
        localStorage.setItem("lifeplan-optional-features-v1", JSON.stringify({ aiParallel: false, dailyStatistics: false }));
        const event = { id: 1, title: "晚间项目", status: 1 };
        const action = { id: 11, title: "整理晚间方案", event_id: 1, event_title: event.title, status: 0 };
        const otherActions = Array.from({ length: 20 }, (_, index) => ({
          ...action, id: index + 20, title: `其他候选行动 ${index + 1}`,
        }));
        const time = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${minutes % 60 ? "30" : "00"}`;
        const slots = Array.from({ length: 48 }, (_, index) => ({
          id: index + 101, start_time: time(index * 30), end_time: time((index + 1) * 30),
        }));
        window.stickyPoolFixture = { slots, assignments: [], action };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: () => 1, unregisterCallback() {},
          invoke: async (cmd, args = {}) => {
            if (cmd === "get_daily_event_pool") return {
              space_id: "sticky-test", list_date: args.listDate, event_ids: [event.id],
              entries: [{ event, actions: [action, ...otherActions] }],
            };
            if (cmd === "get_daily_schedule") return {
              list_date: args.listDate, slots: structuredClone(slots.map((slot) => ({ ...slot, list_date: args.listDate }))),
            };
            if (cmd === "assign_daily_pool_action") {
              const slot = slots.find((item) => item.id === args.slotId);
              if (slot.action_id) throw Error("请选择空时间段");
              window.stickyPoolFixture.assignments.push(args);
              slot.action_id = action.id;
              slot.action = action;
              return structuredClone({ ...slot, list_date: args.listDate });
            }
            if (cmd === "get_daily_used_dates" || cmd === "get_ai_tasks" || cmd === "get_recurring_actions") return [];
            if (cmd === "plugin:event|listen") return 1;
            return null;
          },
        };
      });
      const shot = async (name) => {
        if (!screenshots) return;
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `${width}-${height}-${name}.png`), animations: "disabled" });
      };
      try {
        await page.goto(`${baseUrl}/#/daily-list`);
        const trigger = page.locator(".daily-pool-trigger");
        await trigger.getByText("1 事件 · 0/21", { exact: true }).waitFor();
        assert.equal(await page.locator("#daily-event-pool").count(), 0);
        await trigger.click();
        const pool = page.getByRole("region", { name: "今日事件池", exact: true });
        await pool.getByText("行动完成 0/21", { exact: true }).waitFor();
        const topBefore = await pool.evaluate((el) => el.getBoundingClientRect().top);
        assert.equal(await pool.locator(".daily-pool-events").evaluate((el) => el.scrollHeight > el.clientHeight), true);
        const row = page.locator(".daily-schedule-row").last();
        await row.scrollIntoViewIfNeeded();
        const bounds = await pool.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const container = document.querySelector(".main-content");
          const scroll = container.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height, viewportTop: scroll.top,
            contentTop: scroll.top + parseFloat(getComputedStyle(container).paddingTop), viewportHeight: innerHeight };
        });
        assert.ok(bounds.top < topBefore, "Pool should reach the top as the page scrolls");
        assert.ok(bounds.top >= bounds.viewportTop - 1 && bounds.top <= bounds.contentTop + 1,
          "Pool stays within the top padding region, including its containing block's end boundary");
        assert.ok(bounds.height <= height * 0.55, "Pool leaves usable vertical space for the schedule");
        const position = await row.boundingBox();
        assert.ok(position.y >= bounds.bottom - 1, "Late slot is not covered by the pool");
        const drag = page.getByLabel("拖动行动：晚间项目 - 整理晚间方案", { exact: true });
        await drag.waitFor();
        await shot("late-slot-before-drop");
        await drag.dragTo(row.locator(".daily-plan-cell"));
        await row.getByText("晚间项目 - 整理晚间方案", { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.stickyPoolFixture.assignments.map((item) => item.slotId)), [148]);
        assert.equal(await drag.count(), 1, "Dragged action remains available in the pool");
        await shot("late-slot-after-drop");
        await pool.getByRole("button", { name: "收起今日事件池", exact: true }).click();
        assert.equal(await page.locator("#daily-event-pool").count(), 0);
        assert.equal(await page.locator(".daily-schedule-row").count(), 48);
        assert.equal(await page.evaluate(() => window.stickyPoolFixture.slots[47].action_id), 11);
        assert.deepEqual(errors, []);
      } catch (error) {
        await shot("failure");
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
