import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1422";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("personal features UI with isolated Tauri fixtures", { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    const timestamp = new Date("2026-09-28").getTime();
    const empty = { created_at: timestamp, updated_at: timestamp, is_quick_completed: 0 };
    let data = JSON.parse(sessionStorage.getItem("feature-test-data") || "null");
    if (!data) {
      data = {
        categories: [{ id: 1, name: "工作", color: "#1778FF", sort_order: 0, ...empty }, { id: 2, name: "成长", color: "#13A8A8", sort_order: 1, ...empty }],
        events: [0, 1, 3, 4, 5].flatMap((status) => [1, 2, null].map((category_id, i) => ({
          ...empty, id: status * 10 + i + 1, title: `事件${status}-${i + 1}`, status, category_id, target: "原有目标",
        }))),
        actions: [
          { ...empty, id: 1, event_id: 11, title: "第一项子任务", status: 0, estimated_hours: 0.5, sort_order: 1 },
          { ...empty, id: 2, event_id: 12, title: "第二项子任务", status: 0, estimated_hours: 1, sort_order: 1 },
        ],
        note: { space_id: "test-space", content: "", updated_at: 0 },
      };
    }
    const persist = () => sessionStorage.setItem("feature-test-data", JSON.stringify(data));
    window.fixture = data;
    window.calls = [];
    window.failSave = false;
    window.failLoad = false;
    window.saveDelay = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        window.calls.push({ cmd, args });
        let result = null;
        if (cmd === "get_events") return data.events.map((event) => {
          const category = data.categories.find((item) => item.id === event.category_id);
          const actions = data.actions.filter((action) => action.event_id === event.id);
          return { ...event, category_name: category?.name, category_color: category?.color, action_count: actions.length, completed_action_count: actions.filter((item) => item.status === 1).length, pending_action_count: actions.filter((item) => item.status === 0).length };
        });
        if (cmd === "get_actions") return structuredClone(data.actions);
        if (cmd === "get_event_categories") return structuredClone(data.categories);
        if (cmd === "create_event_category") {
          if (data.categories.some((item) => item.name === args.payload.name.trim())) throw Error("已经存在同名分类");
          result = { ...empty, ...args.payload, id: Math.max(0, ...data.categories.map((item) => item.id)) + 1 };
          data.categories.push(result);
        }
        if (cmd === "update_event_category") {
          result = data.categories.find((item) => item.id === args.payload.id);
          Object.assign(result, args.payload);
        }
        if (cmd === "delete_event_category") {
          data.categories = data.categories.filter((item) => item.id !== args.id);
          data.events.forEach((item) => { if (item.category_id === args.id) item.category_id = null; });
        }
        if (cmd === "create_event") {
          result = { ...empty, ...args.payload, status: 0, id: 100 };
          data.events.push(result);
        }
        if (cmd === "update_event") {
          result = data.events.find((item) => item.id === args.payload.id);
          Object.assign(result, args.payload);
        }
        if (cmd === "complete_action" || cmd === "restore_action") {
          result = data.actions.find((item) => item.id === args.id);
          result.status = cmd === "complete_action" ? 1 : 0;
        }
        if (cmd === "get_insights_note") {
          if (window.failLoad) throw Error("读取失败");
          return structuredClone(data.note);
        }
        if (cmd === "save_insights_note") {
          await new Promise((resolve) => setTimeout(resolve, window.saveDelay));
          if (window.failSave) throw Error("保存失败");
          data.note = { content: args.content, space_id: args.spaceId, updated_at: Date.now() };
          result = data.note;
        }
        if (cmd === "plugin:event|listen") return 1;
        persist();
        return result;
      },
    };
  });
  const screenshot = async (name) => {
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
    }
  };
  const switchView = (name) => page.locator(".ant-segmented-item").filter({ has: page.locator(`[aria-label="${name}视图"]`) }).click();
  const closeDialog = () => page.getByRole("dialog").locator(".ant-modal-close").click();
  const chooseCategory = async (scope, name) => {
    await scope.locator(".event-category-select").click();
    await page.locator(".ant-select-dropdown:visible").getByText(name, { exact: true }).click();
  };
  try {
    await page.goto(`${baseUrl}/#/inbox`);
    await page.getByRole("tab", { name: /待处理 3/ }).waitFor();
    assert.equal(await page.getByRole("tab", { name: /进行中 3/ }).getAttribute("aria-selected"), "true");
    const tabs = ["待处理", "进行中", "推迟", "已放弃", "已完成"];
    const statusKeys = [0, 1, 3, 4, 5];
    for (const [index, tab] of tabs.entries()) {
      const status = statusKeys[index];
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      await switchView("看板");
      assert.equal(await page.locator(".event-board-column").count(), 3);
      assert.equal(await page.locator(".record-card").count(), 3);
      assert.match(await page.locator(".record-board").innerText(), new RegExp(`事件${status}-1`));
    }
    await page.reload();
    await page.locator(".event-board-column").first().waitFor();
    assert.equal(await page.getByRole("tab", { name: /进行中 3/ }).getAttribute("aria-selected"), "true");
    for (const tab of tabs) {
      await page.getByRole("tab", { name: new RegExp(tab) }).click();
      assert.equal(await page.locator(".event-board-column").count(), 3);
    }
    await page.getByRole("tab", { name: /进行中/ }).click();
    await switchView("列表");
    let row = page.locator(".record-card").filter({ hasText: "事件1-1" });
    await row.getByRole("button", { name: "行动 0/1" }).click();
    await row.locator("[data-event-action-id='1']").getByRole("button", { name: "完成", exact: true }).click();
    await row.getByRole("button", { name: "行动 1/1" }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.events.find((item) => item.id === 11).status), 1);
    await row.locator("[data-event-action-id='1']").getByRole("button", { name: "恢复", exact: true }).click();
    await row.getByRole("button", { name: "行动 0/1" }).waitFor();
    await switchView("看板");
    await screenshot("inbox-board-desktop.png");
    await page.getByRole("tab", { name: /进行中/ }).click();
    row = page.locator(".record-card").filter({ hasText: "事件1-2" });
    await row.getByRole("button", { name: "行动 0/1" }).click();
    await row.locator("[data-event-action-id='2']").getByRole("button", { name: "完成", exact: true }).click();
    await row.getByRole("button", { name: "行动 1/1" }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.events.find((item) => item.id === 12).status), 1);

    await page.getByRole("button", { name: "管理分类" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "编辑工作", exact: true }).click();
    await dialog.getByLabel("分类名称", { exact: true }).fill("工作事务");
    await dialog.getByRole("button", { name: "保存分类", exact: true }).click();
    await dialog.getByRole("button", { name: "编辑工作事务", exact: true }).waitFor();
    await closeDialog();
    await page.locator(".event-board-column-head").getByText("工作事务", { exact: true }).waitFor();

    await page.getByRole("tab", { name: /已完成/ }).click();
    row = page.locator(".record-card").filter({ hasText: "事件5-3" });
    await row.getByRole("button", { name: "编辑事件", exact: true }).click();
    dialog = page.getByRole("dialog");
    await chooseCategory(dialog, "工作事务");
    await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
    await page.waitForFunction(() => window.fixture.events.find((item) => item.id === 53).category_id === 1);
    assert.equal(await page.evaluate(() => window.fixture.events.find((item) => item.id === 53).status), 5);

    await page.getByRole("tab", { name: /待处理/ }).click();
    await page.locator(".quick-add .event-category-select").click();
    await page.getByLabel("新分类名称", { exact: true }).fill("生活");
    await page.getByRole("button", { name: "新增并选择分类" }).click();
    await page.waitForFunction(() => window.fixture.categories.some((item) => item.name === "生活"));
    await page.locator(".page-title").click();
    await page.locator(".quick-add > input").fill("有分类的新事件");
    await page.getByRole("button", { name: "新增", exact: true }).click();
    await page.locator(".record-card").filter({ hasText: "有分类的新事件" }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.events.find((item) => item.id === 100).category_id), 3);

    await page.getByRole("button", { name: "管理分类" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "删除工作事务", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^删\s*除$/ }).click();
    await page.waitForFunction(() => !window.fixture.categories.some((item) => item.id === 1));
    await closeDialog();
    assert.equal(await page.locator(".record-card").count(), 4);
    assert.equal(await page.locator(".event-board-column-head").getByText("工作事务", { exact: true }).count(), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot("inbox-board-mobile.png");
    assert.deepEqual(errors, []);
    console.log("Verified all five tabs, view preferences, categories, completed-event classification, child completion/undo and new-event categories.");
  } catch (error) {
    await screenshot("failure.png");
    throw error;
  } finally {
    await browser.close();
  }
});

test("insights persistence, recovery and responsive editor", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    window.note = JSON.parse(sessionStorage.getItem("note-test") || '{"space_id":"notes-test","content":"","updated_at":0}');
    window.calls = [];
    window.failSave = false;
    window.saveDelay = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        window.calls.push({ cmd, args });
        if (cmd === "get_events" || cmd === "get_actions" || cmd === "get_event_categories") return [];
        if (cmd === "get_insights_note") {
          if (sessionStorage.getItem("fail-note-load")) throw Error("读取失败");
          return structuredClone(window.note);
        }
        if (cmd === "save_insights_note") {
          await new Promise((resolve) => setTimeout(resolve, window.saveDelay));
          if (window.failSave) throw Error("保存失败");
          window.note = { content: args.content, space_id: args.spaceId, updated_at: Date.now() };
          sessionStorage.setItem("note-test", JSON.stringify(window.note));
          return structuredClone(window.note);
        }
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const shot = async (name) => {
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
    }
  };
  try {
    await page.goto(`${baseUrl}/#/insights`);
    const editor = page.locator(".md-wysiwyg");
    await editor.fill("自动保存的心得");
    await page.waitForFunction(() => window.note.content.includes("自动保存的心得"));
    await editor.press("ControlOrMeta+a");
    await page.getByRole("button", { name: "粗体", exact: true }).click();
    await page.waitForFunction(() => window.note.content.includes("**"));
    await shot("insights-desktop.png");
    await editor.fill("快速切换后仍保留");
    await page.getByRole("link", { name: "事件篮", exact: true }).click();
    await page.getByRole("link", { name: "心得", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".md-wysiwyg")?.textContent === "快速切换后仍保留");
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".md-wysiwyg")?.textContent === "快速切换后仍保留");
    await page.evaluate(() => { window.failSave = true; });
    await editor.fill("保存失败时的草稿");
    await page.getByRole("button", { name: /^重\s*试$/ }).waitFor();
    assert.match(await page.evaluate(() => localStorage.getItem("lifeplan-insights-draft:notes-test")), /保存失败时的草稿/);
    await page.reload();
    await page.waitForFunction(() => window.note.content.includes("保存失败时的草稿"));
    await page.waitForFunction(() => document.querySelector(".md-wysiwyg")?.textContent === "保存失败时的草稿");
    await editor.fill("");
    await page.waitForFunction(() => window.note.content === "");
    await page.reload();
    await editor.waitFor();
    assert.equal(await editor.textContent(), "");
    await page.evaluate(() => { window.saveDelay = 700; });
    await editor.fill("旧请求");
    await page.waitForFunction(() => window.calls.some((call) => call.cmd === "save_insights_note" && call.args.content.includes("旧请求")));
    await editor.fill("最新内容");
    await page.waitForFunction(() => window.note.content.includes("最新内容"));
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".md-wysiwyg")?.textContent === "最新内容");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("insights-mobile.png");
    assert.equal(await page.evaluate(() => {
      const toolbar = document.querySelector(".markdown-editor-toolbar");
      return toolbar.scrollWidth > toolbar.clientWidth + 1;
    }), false);
    await page.evaluate(() => sessionStorage.setItem("fail-note-load", "1"));
    await page.reload();
    await page.getByRole("button", { name: /^重\s*试$/ }).waitFor();
    assert.equal(await editor.count(), 0);
    assert.equal(await page.evaluate(() => window.calls.filter((call) => call.cmd === "save_insights_note").length), 0);
    assert.deepEqual(errors, []);
    console.log("Notes verified: formatting, autosave, navigation, reload, clear, ordered writes, failed-save draft recovery, load-failure protection, mobile toolbar.");
  } catch (error) {
    await shot("insights-failure.png");
    throw error;
  } finally {
    await browser.close();
  }
});

test("daily calendar marks dates used by Today Tasks", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date("2026-09-28T12:00:00") });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (cmd) => {
        if (cmd === "get_startup_notice") return null;
        if (cmd === "get_daily_schedule") return { list_date: "2026-09-28", slots: [] };
        if (cmd === "get_actions") return [];
        if (cmd === "get_daily_used_dates") return ["2026-09-26", "2026-09-28"];
        if (cmd === "plugin:event|listen") return 1;
        return [];
      },
    };
  });
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await page.locator(".daily-date-panel .ant-picker").click();
    const panel = page.locator(".ant-picker-dropdown:visible");
    await panel.waitFor();
    assert.equal(await panel.locator(".daily-date-used-dot").count(), 2);
    assert.equal(await panel.locator("[aria-label='这天使用过今日事']").count(), 2);
    const positions = await panel.locator(".daily-date-cell").evaluateAll((cells) => cells.map((cell) => {
      const digit = cell.querySelector(".ant-picker-cell-inner").getBoundingClientRect();
      const dot = cell.querySelector(".daily-date-used-dot").getBoundingClientRect();
      return dot.x >= digit.right - 4 && dot.bottom <= digit.top + 5;
    }));
    assert.ok(positions.every(Boolean), "Markers must sit above the date's upper-right corner");
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await panel.locator(".ant-picker-panel").screenshot({ path: path.join(screenshots, "daily-calendar-corner.png") });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
