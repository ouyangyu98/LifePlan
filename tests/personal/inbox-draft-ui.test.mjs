import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1420";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("drafts support action preparation and direct start without losing details or duplicating actions", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    const initial = {
      events: [
        { id: 1, title: "新产品方向", target: "先明确目标人群", history_note: "保留原始想法", status: 0, category_id: 1, category_name: "工作", category_color: "#1677ff" },
        { id: 2, title: "尚未拆分的想法", status: 0 },
        { id: 3, title: "正在交付的项目", status: 1 },
      ],
      actions: [
        { id: 11, event_id: 1, event_title: "新产品方向", title: "整理问题", description: "保留已有说明", estimated_hours: 0.5, status: 0, sort_order: 1, created_at: 1 },
      ],
    };
    const data = JSON.parse(sessionStorage.getItem("draft-fixture") || JSON.stringify(initial));
    window.draftFixture = { ...data, calls: [], failStart: false, holdStart: false };
    const fixture = window.draftFixture;
    const persist = () => sessionStorage.setItem("draft-fixture", JSON.stringify({ events: fixture.events, actions: fixture.actions }));
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        fixture.calls.push({ cmd, args: structuredClone(args) });
        if (cmd === "get_events") return fixture.events.map((event) => {
          const children = fixture.actions.filter((action) => action.event_id === event.id);
          return { ...event, action_count: children.length, pending_action_count: children.length, completed_action_count: 0 };
        });
        if (cmd === "get_actions") return structuredClone(fixture.actions);
        if (cmd === "get_event_categories") return [{ id: 1, name: "工作", color: "#1677ff" }];
        if (cmd === "create_action") {
          const parent = fixture.events.find((event) => event.id === args.payload.event_id);
          if (![0, 1].includes(parent.status)) throw Error("不可添加行动");
          const action = {
            ...args.payload, id: Math.max(0, ...fixture.actions.map((item) => item.id)) + 1,
            event_title: parent.title, status: 0, sort_order: fixture.actions.length + 1, created_at: Date.now(),
          };
          fixture.actions.push(action); persist(); return structuredClone(action);
        }
        if (cmd === "update_action") {
          const action = fixture.actions.find((item) => item.id === args.payload.id);
          Object.assign(action, args.payload); persist(); return structuredClone(action);
        }
        if (cmd === "delete_action") {
          fixture.actions = fixture.actions.filter((action) => action.id !== args.id); persist(); return;
        }
        if (cmd === "reorder_event_actions") {
          for (const [index, id] of args.payload.action_ids.entries()) fixture.actions.find((action) => action.id === id).sort_order = index + 1;
          persist(); return;
        }
        if (cmd === "start_event") {
          if (fixture.failStart) throw Error("开始推进保存失败");
          if (fixture.holdStart) await new Promise((resolve) => { window.releaseDraftStart = resolve; });
          const event = fixture.events.find((item) => item.id === args.eventId);
          if (event.status !== 0) throw Error("该事件已开始推进");
          event.status = 1; persist(); return;
        }
        if (cmd === "get_daily_event_pool") return { list_date: args.listDate, space_id: "draft-test", event_ids: [], entries: [] };
        if (cmd === "get_daily_schedule") return { list_date: args.listDate, slots: [] };
        if (["get_ai_tasks", "get_recurring_actions", "get_daily_used_dates"].includes(cmd)) return [];
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const card = (title) => page.locator(".event-card").filter({ has: page.locator(".event-card-title", { hasText: title }) });
  const dialog = page.getByRole("dialog");
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true, animations: "disabled" });
  };
  const tab = (name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
  try {
    await page.goto(`${baseUrl}/#/inbox`);
    await card("正在交付的项目").waitFor();
    assert.equal(await tab("进行中").getAttribute("aria-selected"), "true");
    await tab("待梳理").click();
    await card("新产品方向").getByRole("button", { name: /行动 0\/1/ }).click();
    const actions = card("新产品方向").locator(".event-actions-panel");
    await actions.locator(".event-action-title").filter({ hasText: "整理问题" }).waitFor();
    assert.equal(await actions.getByRole("button", { name: /^完\s*成$/ }).count(), 0);
    await actions.getByRole("button", { name: "添加行动", exact: true }).click();
    await dialog.getByLabel("行动标题", { exact: true }).fill("访谈潜在用户");
    await dialog.getByRole("textbox", { name: "描述", exact: true }).fill("先列访谈提纲");
    await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
    await dialog.waitFor({ state: "hidden" });
    await actions.locator(".event-action-title").filter({ hasText: "访谈潜在用户" }).waitFor();
    assert.equal(await page.evaluate(() => window.draftFixture.events[0].status), 0);
    assert.equal(await tab("待梳理").getAttribute("aria-selected"), "true");
    await actions.locator(".event-action-item").filter({ hasText: "访谈潜在用户" }).getByRole("button", { name: /^编\s*辑$/ }).click();
    await dialog.getByLabel("行动标题", { exact: true }).fill("整理访谈提纲");
    await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
    await dialog.waitFor({ state: "hidden" });
    await actions.locator(".event-action-title").filter({ hasText: "整理访谈提纲" }).waitFor();
    await shot("inbox-draft-actions.png");
    const before = await page.evaluate(() => JSON.stringify(window.draftFixture.actions));
    await page.evaluate(() => { window.draftFixture.failStart = true; });
    await card("新产品方向").getByRole("button", { name: "开始推进", exact: true }).click();
    await page.getByText("开始推进保存失败", { exact: true }).waitFor();
    assert.equal(await tab("待梳理").getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(window.draftFixture.actions)), before);
    await page.evaluate(() => { window.draftFixture.failStart = false; window.draftFixture.holdStart = true; });
    const startsBefore = await page.evaluate(() => window.draftFixture.calls.filter((call) => call.cmd === "start_event").length);
    await card("新产品方向").getByRole("button", { name: "开始推进", exact: true }).evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => typeof window.releaseDraftStart === "function");
    assert.equal(await page.evaluate(() => window.draftFixture.calls.filter((call) => call.cmd === "start_event").length), startsBefore + 1);
    await page.evaluate(() => { window.draftFixture.holdStart = false; window.releaseDraftStart(); });
    await tab("进行中").waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some((el) => el.textContent.startsWith("进行中") && el.getAttribute("aria-selected") === "true"));
    await card("新产品方向").locator(".event-action-title").filter({ hasText: "整理访谈提纲" }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(window.draftFixture.actions)), before);
    assert.equal(await page.evaluate(() => window.draftFixture.events[0].target), "先明确目标人群");
    assert.equal(await page.evaluate(() => window.draftFixture.calls.some((call) => call.cmd === "process_event")), false);
    await shot("inbox-started-directly.png");
    await page.reload();
    await card("新产品方向").waitFor();
    await tab("待梳理").click();
    await card("尚未拆分的想法").getByRole("button", { name: "开始推进", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some((el) => el.textContent.startsWith("进行中") && el.getAttribute("aria-selected") === "true"));
    await card("尚未拆分的想法").getByRole("button", { name: "添加行动", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => window.draftFixture.actions.length), 2);
    assert.deepEqual(errors, []);
  } catch (error) { await shot("inbox-draft-failure.png"); throw error; }
  finally { await browser.close(); }
});
