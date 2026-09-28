import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1422";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("daily drag moves and swaps reviews atomically; new time slots default to one hour", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date("2026-09-28T12:00:00") });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    const actions = [
      { id: 1, event_id: 1, title: "项目待办", status: 0, estimated_hours: 1 },
      { id: 2, event_id: 2, title: "学习事项", status: 1, estimated_hours: 1.5 },
    ];
    const slots = JSON.parse(sessionStorage.getItem("drag-test-slots") || "null") || [
      { id: 1, list_date: "2026-09-28", start_time: "09:00", end_time: "10:00", action_id: 1, action: actions[0], actual_notes: "项目复盘", met_expectation: 1, focused: 0 },
      { id: 2, list_date: "2026-09-28", start_time: "10:00", end_time: "11:30", action_id: 2, action: actions[1], actual_notes: "学习复盘", met_expectation: 0, focused: 1 },
      { id: 3, list_date: "2026-09-28", start_time: "13:00", end_time: "14:00" },
    ];
    const save = () => sessionStorage.setItem("drag-test-slots", JSON.stringify(slots));
    window.dragFixture = { slots, failMove: false, holdMove: false, calls: [], created: [] };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        if (cmd === "get_daily_schedule") return { list_date: args.listDate, slots: structuredClone(slots) };
        if (cmd === "get_actions") return structuredClone(actions);
        if (cmd === "get_events") return [
          { id: 1, category_id: 10, category_name: "工作", category_color: "#1677ff" },
          { id: 2, category_id: 20, category_name: "成长", category_color: "#389e0d" },
        ];
        if (cmd === "get_daily_used_dates" || cmd === "get_recurring_actions") return [];
        if (cmd === "move_daily_slot_action") {
          window.dragFixture.calls.push(structuredClone(args));
          if (window.dragFixture.failMove) throw Error("模拟保存失败");
          if (window.dragFixture.holdMove) await new Promise((resolve) => { window.releaseMove = resolve; });
          const source = slots.find((slot) => slot.id === args.sourceSlotId);
          const target = slots.find((slot) => slot.id === args.targetSlotId);
          for (const key of ["action_id", "action", "actual_notes", "met_expectation", "focused"]) {
            [source[key], target[key]] = [target[key], source[key]];
          }
          save();
          return structuredClone([source, target]);
        }
        if (cmd === "create_daily_slot") {
          window.dragFixture.created.push(structuredClone(args.payload));
          const slot = { ...args.payload, id: Math.max(...slots.map((slot) => slot.id)) + 1 };
          slots.push(slot);
          save();
          return structuredClone(slot);
        }
        if (cmd === "update_daily_slot") {
          const slot = slots.find((slot) => slot.id === args.payload.id);
          Object.assign(slot, args.payload);
          save();
          return structuredClone(slot);
        }
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const plans = page.locator(".daily-plan-cell");
  const rows = page.locator(".daily-schedule-row");
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
  };
  const waitTitle = (index, title) => page.waitForFunction(({ index, title }) =>
    document.querySelectorAll(".daily-plan-cell")[index]?.textContent.includes(title), { index, title });
  const selectTime = async (index, time) => {
    await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(index).click();
    await page.getByRole("option", { name: time, exact: true }).click();
    await page.getByRole("listbox", { name: "时间选项", exact: true }).waitFor({ state: "hidden" });
  };
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await page.getByLabel("已安排总时长 2 小时 30 分钟", { exact: true }).waitFor();
    await plans.nth(0).dragTo(plans.nth(2));
    await waitTitle(2, "项目待办");
    assert.equal(await plans.nth(0).getAttribute("draggable"), "false");
    assert.match(await rows.nth(2).innerText(), /项目复盘/);
    assert.doesNotMatch(await rows.nth(0).innerText(), /项目复盘/);
    assert.deepEqual(await page.locator(".daily-time-cell").allTextContents(), ["09:00-10:00", "10:00-11:30", "13:00-14:00"]);
    assert.equal(await page.getByRole("dialog").count(), 0);

    await plans.nth(2).dragTo(plans.nth(1));
    await waitTitle(1, "项目待办");
    await waitTitle(2, "学习事项");
    assert.match(await rows.nth(1).innerText(), /项目复盘/);
    assert.match(await rows.nth(2).innerText(), /学习复盘/);
    assert.deepEqual(await page.locator(".daily-statistics-table tbody tr").allTextContents(), ["工作1 小时 30 分钟60%", "成长1 小时40%"]);
    await page.reload();
    await waitTitle(1, "项目待办");
    assert.match(await rows.nth(2).innerText(), /学习复盘/);

    const before = await rows.allTextContents();
    await page.evaluate(() => { window.dragFixture.failMove = true; });
    await plans.nth(1).dragTo(plans.nth(0));
    await page.getByText("模拟保存失败", { exact: true }).waitFor();
    assert.deepEqual(await rows.allTextContents(), before);
    assert.equal(await page.locator(".daily-schedule-card").getAttribute("aria-busy"), "false");
    await page.evaluate(() => { window.dragFixture.failMove = false; window.dragFixture.holdMove = true; });
    await plans.nth(1).dragTo(plans.nth(0));
    await page.waitForFunction(() => typeof window.releaseMove === "function");
    assert.equal(await page.locator(".daily-schedule-card").getAttribute("aria-busy"), "true");
    assert.deepEqual(await rows.allTextContents(), before);
    assert.equal(await plans.nth(2).isDisabled(), true);
    await page.evaluate(() => { window.dragFixture.holdMove = false; window.releaseMove(); });
    await waitTitle(0, "项目待办");
    const calls = await page.evaluate(() => window.dragFixture.calls.length);
    const sourceBox = await plans.nth(0).boundingBox();
    const x = sourceBox.x + 50;
    const y = sourceBox.y + sourceBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y, { steps: 5 });
    await page.mouse.move(x + 5, y, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.dragFixture.calls.length), calls);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await shot("daily-drag-desktop.png");

    await page.locator(".daily-template-action").getByRole("button", { name: "新增时间段", exact: true }).click();
    await selectTime(0, "15:00");
    assert.equal(await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(1).textContent(), "16:00");
    await selectTime(1, "17:30");
    assert.equal(await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(1).textContent(), "17:30");
    await selectTime(0, "16:30");
    assert.equal(await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(1).textContent(), "17:30");
    await page.getByRole("button", { name: "保存时间段", exact: true }).click();
    await page.getByText("16:30-17:30", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.dragFixture.created[0]), { list_date: "2026-09-28", start_time: "16:30", end_time: "17:30" });

    await page.locator(".daily-template-action").getByRole("button", { name: "新增时间段", exact: true }).click();
    assert.equal(await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(0).textContent(), "请选择时间");
    await selectTime(0, "23:00");
    assert.equal(await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(1).textContent(), "24:00");
    await selectTime(0, "23:30");
    assert.equal(await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(1).textContent(), "24:00");
    await shot("daily-new-slot-midnight.png");
    await page.getByRole("button", { name: "保存时间段", exact: true }).click();
    await page.getByText("23:30-24:00", { exact: true }).waitFor();
    await page.getByText("23:30-24:00", { exact: true }).click();
    assert.equal(await page.getByRole("dialog").locator(".daily-time-picker-trigger").nth(1).textContent(), "24:00");
    await page.getByRole("dialog").getByRole("button", { name: /^保\s*存$/ }).click();
    await page.getByText("23:30-24:00", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.dragFixture.slots.at(-1).end_time), "24:00");
    assert.deepEqual(errors, []);
  } catch (error) {
    await shot("daily-interactions-failure.png");
    throw error;
  } finally {
    await browser.close();
  }
});
