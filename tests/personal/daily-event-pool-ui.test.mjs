import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1420";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("daily event pool saves per day, drags copies safely, tracks progress and preserves source records", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date("2026-10-19T12:00:00") });
  const errors = [];
  const keyWarnings = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/same key|unique.*key/.test(message.text())) keyWarnings.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    localStorage.setItem("lifeplan-optional-features-v1", JSON.stringify({ aiParallel: false, dailyStatistics: true, reviewExpectation: false }));
    const initial = {
      actions: [
        { id: 1, event_id: 10, event_title: "直播清晰度", title: "需求文档", status: 0 },
        { id: 2, event_id: 10, event_title: "直播清晰度", title: "确认异常规则", status: 0 },
        { id: 3, event_id: 10, event_title: "直播清晰度", title: "已完成调研", status: 1 },
        { id: 4, event_id: 20, event_title: "个人成长", title: "阅读", status: 0 },
        { id: 5, title: "独立行动", status: 0 },
      ],
      events: [
        { id: 10, title: "直播清晰度", status: 1, category_name: "工作", category_color: "#1677ff" },
        { id: 20, title: "个人成长", status: 1, category_name: "成长", category_color: "#16846c" },
        { id: 30, title: "已推迟事件", status: 3 },
      ],
      pools: {},
      tasks: [],
      slots: [
        { id: 101, start_time: "09:00", end_time: "10:00" },
        { id: 102, start_time: "10:00", end_time: "11:00" },
        { id: 103, start_time: "11:00", end_time: "12:00", action_id: 5, actual_notes: "原有复盘", focused: 1 },
        { id: 104, start_time: "13:00", end_time: "14:00" },
      ],
    };
    const state = JSON.parse(sessionStorage.getItem("pool-fixture") || JSON.stringify(initial));
    state.actions = state.actions.map((action) => ({ estimated_hours: 0.5, ...action }));
    window.poolFixture = { ...state, tasks: state.tasks || [], failSave: false, assignments: [], failLoad: false, failComplete: false };
    const fixture = window.poolFixture;
    const save = () => sessionStorage.setItem("pool-fixture", JSON.stringify({
      actions: fixture.actions, events: fixture.events, pools: fixture.pools, slots: fixture.slots, tasks: fixture.tasks,
    }));
    const pool = (date) => ({
      space_id: "pool-test", list_date: date, event_ids: fixture.pools[date] || [],
      entries: (fixture.pools[date] || []).map((id) => ({
        event: fixture.events.find((event) => event.id === id),
        actions: fixture.actions.filter((action) => action.event_id === id),
      })),
    });
    const readSlot = (slot, date) => ({ ...slot, list_date: date, action: fixture.actions.find((action) => action.id === slot.action_id) });
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        if (cmd === "get_daily_event_pool") {
          if (fixture.failLoad) throw Error("读取池子失败");
          return structuredClone(pool(args.listDate));
        }
        if (cmd === "save_daily_event_pool") {
          if (fixture.failSave) throw Error("保存事件池失败");
          fixture.pools[args.payload.list_date] = args.payload.event_ids;
          save();
          return structuredClone(pool(args.payload.list_date));
        }
        if (cmd === "get_daily_schedule") return {
          list_date: args.listDate,
          slots: args.listDate === "2026-10-19" ? structuredClone(fixture.slots.map((slot) => readSlot(slot, args.listDate))) : [],
        };
        if (cmd === "get_daily_used_dates") return ["2026-10-19"];
        if (cmd === "get_events") return structuredClone(fixture.events);
        if (cmd === "get_actions") return structuredClone(fixture.actions);
        if (cmd === "get_recurring_actions") return [];
        const readTask = (task) => {
          const action = fixture.actions.find((item) => item.id === task.linked_action_id);
          return { ...task, title: action.title, event_title: action.event_title, notes: action.description || "", read_only: false,
            status: action.status === 1 ? "completed" : task.status };
        };
        if (cmd === "get_ai_tasks") return structuredClone(fixture.tasks.filter((task) => task.list_date === args.listDate).map(readTask));
        if (cmd === "create_ai_tasks") {
          if (fixture.failSave) throw Error("挂载保存失败");
          const pending = [];
          for (const payload of args.payloads) {
            if (fixture.tasks.some((task) => task.slot_id === payload.slot_id && task.linked_action_id === payload.linked_action_id)
              || pending.some((task) => task.linked_action_id === payload.linked_action_id)) throw Error("请勿重复挂载");
            pending.push({ ...payload, id: Math.max(0, ...fixture.tasks.map((task) => task.id)) + pending.length + 1, created_at: 1, updated_at: 1 });
          }
          fixture.tasks.push(...pending); save();
          return structuredClone(pending.map(readTask));
        }
        if (cmd === "assign_daily_pool_action") {
          const slot = fixture.slots.find((slot) => slot.id === args.slotId);
          if (slot.action_id || slot.actual_notes) throw Error("请选择空时间段");
          fixture.assignments.push(args);
          slot.action_id = args.actionId;
          save();
          return structuredClone(readSlot(slot, args.listDate));
        }
        if (cmd === "update_daily_slot_review") {
          const slot = fixture.slots.find((slot) => slot.id === args.payload.id);
          Object.assign(slot, args.payload);
          save();
          return structuredClone(readSlot(slot, "2026-10-19"));
        }
        if (cmd === "complete_action" || cmd === "restore_action") {
          if (fixture.failComplete) throw Error("行动状态保存失败");
          const action = fixture.actions.find((action) => action.id === args.id);
          action.status = cmd === "complete_action" ? 1 : 0;
          save();
          return structuredClone(action);
        }
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const trigger = page.locator(".daily-pool-trigger");
  const pool = page.getByRole("region", { name: "今日事件池", exact: true });
  const dialog = page.getByRole("dialog");
  const plans = page.locator(".daily-plan-cell");
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true, animations: "disabled" });
  };
  const chooseDate = async (date) => {
    await page.locator(".daily-date-panel input").fill(date);
    await page.locator(".daily-date-panel input").press("Enter");
  };
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await trigger.getByText("0 事件 · 0/0", { exact: true }).waitFor();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.equal(await pool.count(), 0);
    await page.getByRole("region", { name: "数据统计", exact: true }).waitFor();
    const originalSchedule = await page.evaluate(() => JSON.stringify(window.poolFixture.slots));
    for (let index = 0; index < 10; index += 1) {
      await trigger.click();
      assert.equal(await page.locator("#daily-event-pool").count(), 1);
      await pool.getByText("尚未添加事件", { exact: true }).waitFor();
      await trigger.click();
      assert.equal(await page.locator("#daily-event-pool").count(), 0);
      assert.equal(await page.locator(".daily-statistics").count(), 1);
    }
    assert.equal(await page.evaluate(() => JSON.stringify(window.poolFixture.slots)), originalSchedule);
    assert.equal(await page.locator(".daily-schedule-head").evaluate((el) => {
      const columns = [...el.children].map((child) => child.getBoundingClientRect().width);
      return columns[1] > columns[2];
    }), true);
    await trigger.click();
    await pool.getByText("尚未添加事件", { exact: true }).waitFor();
    await pool.getByRole("button", { name: "添加事件", exact: true }).click();
    const childActions = dialog.getByRole("list", { name: "直播清晰度的二级行动", exact: true });
    await childActions.getByText("需求文档", { exact: true }).waitFor();
    await childActions.getByText("确认异常规则", { exact: true }).waitFor();
    await childActions.getByText("已完成调研", { exact: true }).waitFor();
    assert.deepEqual(await childActions.locator(".ant-tag").allTextContents(), ["待办", "待办", "已完成"]);
    await shot("daily-pool-picker-hierarchy.png");
    await dialog.getByRole("button", { name: "收起二级行动：直播清晰度", exact: true }).click();
    await childActions.waitFor({ state: "hidden" });
    await dialog.getByRole("button", { name: "展开二级行动：直播清晰度", exact: true }).click();
    await childActions.getByText("需求文档", { exact: true }).waitFor();
    await dialog.getByRole("textbox", { name: "搜索事件", exact: true }).fill("异常规则");
    await dialog.getByRole("checkbox", { name: /直播清晰度/ }).waitFor();
    assert.equal(await dialog.getByRole("checkbox", { name: /个人成长/ }).count(), 0);
    await dialog.getByRole("checkbox", { name: /直播清晰度/ }).check();
    await dialog.getByRole("textbox", { name: "搜索事件", exact: true }).fill("");
    assert.equal(await dialog.getByRole("checkbox", { name: /直播清晰度/ }).isChecked(), true);
    await dialog.getByRole("checkbox", { name: /个人成长/ }).check();
    assert.equal(await dialog.getByText("已推迟事件", { exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "添加到今日池", exact: true }).click();
    await pool.getByText("行动完成 1/4", { exact: true }).waitFor();
    await dialog.waitFor({ state: "hidden" });
    const savedMembership = await page.evaluate(() => JSON.stringify(window.poolFixture.pools));
    for (let index = 0; index < 10; index += 1) {
      await trigger.click();
      assert.equal(await page.locator("#daily-event-pool").count(), 0);
      await trigger.click();
      assert.equal(await page.locator("#daily-event-pool").count(), 1);
      await pool.getByText("行动完成 1/4", { exact: true }).waitFor();
      assert.equal(await page.locator(".daily-statistics").count(), 1);
    }
    assert.equal(await page.evaluate(() => JSON.stringify(window.poolFixture.pools)), savedMembership);
    await shot("daily-pool-desktop.png");
    const dragAction = page.getByLabel("拖动行动：直播清晰度 - 需求文档", { exact: true });
    await dragAction.dragTo(plans.nth(0));
    await plans.nth(0).getByText("直播清晰度 - 需求文档", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="拖动行动：直播清晰度 - 需求文档"]')?.getAttribute("draggable") === "true");
    await dragAction.dragTo(plans.nth(1));
    await plans.nth(1).getByText("直播清晰度 - 需求文档", { exact: true }).waitFor();
    assert.equal(await dragAction.count(), 1);
    await pool.getByText("2 个时段", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.waitForFunction(() => document.querySelector('[aria-label="拖动行动：直播清晰度 - 确认异常规则"]')?.getAttribute("draggable") === "true");
    await page.getByLabel("拖动行动：直播清晰度 - 确认异常规则", { exact: true }).dragTo(plans.nth(2));
    assert.equal(await page.evaluate(() => window.poolFixture.assignments.length), 2);
    assert.match(await page.locator(".daily-review-cell").nth(2).innerText(), /原有复盘/);
    assert.equal(await plans.nth(2).innerText(), "独立行动");

    await page.evaluate(() => { window.poolFixture.failComplete = true; });
    await pool.getByRole("checkbox", { name: "完成行动：直播清晰度 - 需求文档", exact: true }).click();
    await pool.getByText("行动状态保存失败", { exact: true }).waitFor();
    assert.equal(await pool.getByRole("checkbox", { name: "完成行动：直播清晰度 - 需求文档", exact: true }).isChecked(), false);
    assert.equal(await page.evaluate(() => window.poolFixture.actions[0].status), 0);
    await page.evaluate(() => { window.poolFixture.failComplete = false; });
    await pool.getByRole("checkbox", { name: "完成行动：直播清晰度 - 需求文档", exact: true }).check();
    await pool.getByText("行动完成 2/4", { exact: true }).waitFor();
    assert.equal(await dragAction.getAttribute("draggable"), "false");
    assert.equal(await page.evaluate(() => window.poolFixture.events[0].status), 1);
    assert.equal(await page.evaluate(() => window.poolFixture.slots[0].actual_notes), undefined);
    assert.equal(await plans.nth(1).getAttribute("class").then((value) => value.includes("completed")), true);
    await pool.getByRole("checkbox", { name: "恢复行动：直播清晰度 - 需求文档", exact: true }).uncheck();
    await pool.getByText("行动完成 1/4", { exact: true }).waitFor();
    assert.equal(await dragAction.getAttribute("draggable"), "true");
    await page.locator(".daily-review-cell").nth(0).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".ant-modal")].every((modal) => getComputedStyle(modal).transform === "none"));
    await dialog.getByLabel("实际工作情况", { exact: true }).fill("需求文档已完成");
    await dialog.getByRole("checkbox", { name: "已完成行动", exact: true }).check();
    await dialog.getByRole("button", { name: "保存复盘", exact: true }).click();
    await pool.getByText("行动完成 2/4", { exact: true }).waitFor();
    assert.equal(await dragAction.getAttribute("draggable"), "false");
    assert.equal(await plans.nth(1).getAttribute("class").then((value) => value.includes("completed")), true);
    await page.getByRole("button", { name: "移出今日池：直播清晰度", exact: true }).click();
    await pool.getByText("行动完成 0/1", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.poolFixture.actions.length), 5);
    await plans.nth(0).getByText("直播清晰度 - 需求文档", { exact: true }).waitFor();
    await page.reload();
    await trigger.getByText("1 事件 · 0/1", { exact: true }).waitFor();
    assert.equal(await pool.count(), 0);
    await trigger.click();
    await pool.getByRole("button", { name: "安排到时间段：个人成长 - 阅读", exact: true }).click();
    await dialog.getByRole("combobox", { name: "选择空时间段", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("13:00–14:00", { exact: true }).click();
    await dialog.getByRole("button", { name: "确认安排", exact: true }).click();
    await plans.nth(3).getByText("个人成长 - 阅读", { exact: true }).waitFor();
    await chooseDate("2026年10月20日");
    await trigger.getByText("0 事件 · 0/0", { exact: true }).waitFor();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await trigger.click();
    await pool.getByText("尚未添加事件", { exact: true }).waitFor();
    await chooseDate("2026年10月19日");
    await trigger.getByText("1 事件 · 0/1", { exact: true }).waitFor();
    await trigger.click();
    await pool.getByText("个人成长", { exact: true }).waitFor();
    await page.evaluate(() => { window.poolFixture.failSave = true; });
    await pool.getByRole("button", { name: "添加事件", exact: true }).click();
    await dialog.getByRole("checkbox", { name: /直播清晰度/ }).check();
    await dialog.getByRole("button", { name: "添加到今日池", exact: true }).click();
    await pool.getByText("保存事件池失败", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.poolFixture.pools["2026-10-19"]), [20]);
    await dialog.locator(".ant-modal-close").click();
    await page.evaluate(() => { window.poolFixture.failSave = false; });
    await pool.getByRole("button", { name: /^重\s*试$/ }).click();
    await pool.getByRole("button", { name: "添加事件", exact: true }).click();
    await dialog.getByRole("checkbox", { name: /直播清晰度/ }).check();
    await dialog.getByRole("button", { name: "添加到今日池", exact: true }).click();
    await pool.getByText("行动完成 2/4", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await pool.scrollIntoViewIfNeeded();
    await shot("daily-pool-mobile.png");
    assert.equal(await pool.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await trigger.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(keyWarnings, []);
  } catch (error) {
    await shot("daily-pool-failure.png");
    throw error;
  } finally { await browser.close(); }
});
