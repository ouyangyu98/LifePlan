import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1422";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("delay preserves progress, restores the correct tab, and excludes both picker modes", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date("2026-09-29T12:00:00") });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    const data = JSON.parse(sessionStorage.getItem("delay-fixture") || "null") || {
      events: [
        { id: 1, title: "推进中的项目", status: 1, delay_resume_status: 0, category_id: 1, category_name: "工作", category_color: "#1677ff" },
        { id: 2, title: "还没处理的事项", status: 0, delay_resume_status: 0 },
        { id: 3, title: "其他项目", status: 1, delay_resume_status: 0 },
      ],
      actions: [
        { id: 11, event_id: 1, event_title: "推进中的项目", title: "继续写方案", description: "保留原有说明", status: 0, estimated_hours: 0, sort_order: 0 },
        { id: 12, event_id: 1, event_title: "推进中的项目", title: "已完成的调研", status: 1, estimated_hours: 0, sort_order: 1 },
        { id: 13, event_id: 3, event_title: "其他项目", title: "主行动", status: 0, estimated_hours: 0, sort_order: 0 },
        { id: 14, event_id: 3, event_title: "其他项目", title: "其他可安排的行动", status: 0, estimated_hours: 0, sort_order: 1 },
      ],
      slots: [
        { id: 101, list_date: "2026-09-29", start_time: "10:00", end_time: "11:00", action_id: 13 },
        { id: 102, list_date: "2026-09-29", start_time: "13:00", end_time: "14:00" },
      ],
    };
    window.delayFixture = data;
    window.delayCalls = [];
    const persist = () => sessionStorage.setItem("delay-fixture", JSON.stringify(data));
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        window.delayCalls.push({ cmd, args: structuredClone(args) });
        if (cmd === "get_events") return data.events.map(event => {
          const children = data.actions.filter(action => action.event_id === event.id);
          return { ...event, action_count: children.length, pending_action_count: children.filter(action => action.status === 0).length,
            completed_action_count: children.filter(action => action.status === 1).length };
        });
        if (cmd === "get_actions") return structuredClone(data.actions);
        if (cmd === "get_event_categories") return [{ id: 1, name: "工作", color: "#1677ff" }];
        if (cmd === "process_event") {
          const event = data.events.find(event => event.id === args.payload.event_id);
          if (args.payload.decision !== "delay") throw Error("Restoration must not split actions");
          if (event.status !== 3) event.delay_resume_status = event.status;
          Object.assign(event, { status: 3, delay_until: args.payload.delay_until, delay_note: args.payload.delay_note });
          persist();
        }
        if (cmd === "restore_event") {
          const event = data.events.find(event => event.id === args.eventId);
          Object.assign(event, { status: event.delay_resume_status, delay_resume_status: 0, delay_until: null, delay_note: null });
          persist();
        }
        if (cmd === "get_daily_schedule") return { list_date: args.listDate,
          slots: data.slots.map(slot => ({ ...slot, action: data.actions.find(action => action.id === slot.action_id) })) };
        if (["get_ai_tasks", "get_recurring_actions", "get_daily_used_dates"].includes(cmd)) return [];
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const card = title => page.locator(".event-card").filter({ has: page.locator(".event-card-title", { hasText: title }) });
  const selectTab = name => page.getByRole("tab", { name: new RegExp(name) }).click();
  const openDelay = async (title, adjusting = false) => {
    await card(title).getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: adjusting ? "调整推迟" : "推迟", exact: true }).click();
    await page.getByRole("dialog").getByLabel("推迟原因（可选）").waitFor();
  };
  const confirmDelay = async () => {
    await page.getByRole("dialog").getByRole("button", { name: /^确\s*认$/ }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("tab", { name: /推迟/ }).getAttribute("aria-selected"), "true");
  };
  const screenshot = async name => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.waitForFunction(() => [...document.querySelectorAll(".ant-modal")].every(modal => getComputedStyle(modal).transform === "none"));
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
  };
  try {
    await page.goto(`${baseUrl}/#/inbox`);
    await card("推进中的项目").waitFor();
    const originalActions = await page.evaluate(() => structuredClone(window.delayFixture.actions));
    await openDelay("推进中的项目");
    assert.equal(await page.getByRole("dialog").getByPlaceholder("不设置日期").inputValue(), "");
    await page.getByRole("dialog").getByLabel("推迟原因（可选）").fill("等待资料补齐");
    await screenshot("delay-dialog-desktop.png");
    await confirmDelay();
    assert.match(await card("推进中的项目").innerText(), /行动 1\/2/);
    await card("推进中的项目").getByRole("button", { name: "恢复进行", exact: true }).waitFor();
    assert.equal(await card("推进中的项目").getByRole("button", { name: "去处理", exact: true }).count(), 0);

    await openDelay("推进中的项目", true);
    assert.equal(await page.getByRole("dialog").getByLabel("推迟原因（可选）").inputValue(), "等待资料补齐");
    await page.getByRole("dialog").getByPlaceholder("不设置日期").fill("2099-10-01");
    await page.getByRole("dialog").getByPlaceholder("不设置日期").press("Tab");
    await confirmDelay();
    await card("推进中的项目").getByText("推迟至 2099-10-01", { exact: true }).waitFor();
    await page.reload();
    await selectTab("推迟");
    await card("推进中的项目").getByRole("button", { name: "恢复进行", exact: true }).click();
    await card("推进中的项目").waitFor();
    assert.equal(await page.getByRole("tab", { name: /进行中/ }).getAttribute("aria-selected"), "true");
    assert.deepEqual(await page.evaluate(() => window.delayFixture.actions), originalActions);
    assert.equal(await page.evaluate(() => window.delayCalls.filter(call => call.cmd === "process_event").length), 0);

    await openDelay("推进中的项目");
    assert.equal(await page.getByRole("dialog").getByPlaceholder("不设置日期").inputValue(), "");
    await confirmDelay();
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot("delay-card-mobile.png");
    const restoreBox = await card("推进中的项目").getByRole("button", { name: "恢复进行", exact: true }).boundingBox();
    assert.ok(restoreBox && restoreBox.x >= 0 && restoreBox.x + restoreBox.width <= 390);
    await page.setViewportSize({ width: 1280, height: 850 });

    await selectTab("待处理");
    await openDelay("还没处理的事项");
    await confirmDelay();
    await card("还没处理的事项").getByRole("button", { name: "恢复待处理", exact: true }).click();
    await card("还没处理的事项").waitFor();
    assert.equal(await page.getByRole("tab", { name: /待处理/ }).getAttribute("aria-selected"), "true");

    await page.goto(`${baseUrl}/#/daily-list`);
    await page.locator(".daily-plan-cell").nth(1).click();
    const picker = page.getByRole("dialog", { name: /^安排行动/ });
    await picker.getByRole("button", { name: "平铺视图", exact: true }).waitFor();
    await picker.getByRole("button", { name: "平铺视图", exact: true }).click();
    assert.deepEqual(await picker.locator(".daily-action-preview-title-text").allTextContents(), ["主行动", "其他可安排的行动"]);
    await screenshot("delay-normal-picker.png");
    await picker.locator(".ant-modal-close").click();
    await picker.waitFor({ state: "hidden" });
    await page.locator(".daily-plan-main").first().hover();
    await page.getByRole("button", { name: /添加 AI 任务/ }).first().click();
    await picker.getByRole("button", { name: "平铺视图", exact: true }).waitFor();
    assert.deepEqual(await picker.locator(".daily-action-preview-title-text").allTextContents(), ["其他可安排的行动"]);
    await screenshot("delay-ai-picker.png");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
