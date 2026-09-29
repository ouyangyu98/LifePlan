import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1422";
const screenshots = process.env.UI_SCREENSHOT_DIR;

async function fixture(page) {
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date("2026-09-29T12:00:00") });
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    const actions = JSON.parse(sessionStorage.getItem("ai-fixture-actions") || "null") || [
      { id: 1, event_id: 1, event_title: "项目", title: "准备项目需求", status: 0, estimated_hours: 1 },
      { id: 2, event_id: 2, event_title: "学习", title: "整理学习笔记", status: 1, estimated_hours: 1 },
      { id: 3, event_id: 1, event_title: "项目", title: "整理竞品材料", description: "整理三个竞品的主要流程", status: 0, estimated_hours: 0 },
      { id: 4, event_id: 2, event_title: "学习", title: "生成一份包含边界情况与例外路径的完整需求分析文档", status: 0, estimated_hours: 1 },
      { id: 5, event_id: 3, event_title: "推迟事项", title: "推迟的行动", status: 0, estimated_hours: 0 },
      { id: 6, title: "无事件的行动", status: 0, estimated_hours: 0 },
    ];
    const slots = (JSON.parse(sessionStorage.getItem("ai-fixture-slots") || "null") || [
      { id: 1, list_date: "2026-09-29", start_time: "09:00", end_time: "10:00", action_id: 1, action: actions[0], actual_notes: "需求复盘", met_expectation: 1, focused: 1 },
      { id: 2, list_date: "2026-09-29", start_time: "10:00", end_time: "10:30", action_id: 1, action: actions[0] },
      { id: 3, list_date: "2026-09-29", start_time: "10:30", end_time: "11:30", action_id: 2, action: actions[1] },
      { id: 4, list_date: "2026-09-29", start_time: "11:30", end_time: "12:00" },
    ]).map(slot => ({ ...slot, action: actions.find(action => action.id === slot.action_id) }));
    window.aiFixture = {
      actions, slots, tasks: JSON.parse(sessionStorage.getItem("ai-fixture-tasks") || "[]"),
      failSave: false, failLoad: false, failPool: false, failDelete: false, holdSave: false, calls: [],
    };
    const save = () => {
      sessionStorage.setItem("ai-fixture-tasks", JSON.stringify(window.aiFixture.tasks));
      sessionStorage.setItem("ai-fixture-actions", JSON.stringify(actions));
      sessionStorage.setItem("ai-fixture-slots", JSON.stringify(slots));
    };
    const withSource = task => {
      const source = actions.find(action => action.id === task.linked_action_id);
      return { ...task, title: source.title, notes: source.description || "", event_title: source.event_title, read_only: false,
        status: source.status === 1 ? "completed" : task.status === "completed" ? "queued" : task.status };
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        const data = window.aiFixture;
        data.calls.push({ cmd, args: structuredClone(args) });
        if (cmd === "get_startup_notice") return null;
        if (cmd === "get_actions") {
          if (data.failPool) throw Error("模拟事件篮读取失败");
          return structuredClone(actions);
        }
        if (cmd === "get_events") return [
          { id: 1, title: "项目", status: 1, category_id: 1, category_name: "工作", category_color: "#1677ff" },
          { id: 2, title: "学习", status: 1, category_id: 2, category_name: "成长", category_color: "#389e0d" },
          { id: 3, title: "推迟事项", status: 3 },
        ].map(event => ({ ...event, action_count: actions.filter(action => action.event_id === event.id).length,
          completed_action_count: actions.filter(action => action.event_id === event.id && action.status === 1).length }));
        if (cmd === "get_event_categories") return [];
        if (cmd === "get_recurring_actions") return [{ id: 20, title: "每日 AI 整理", estimated_hours: 2, frequency_unit: "daily", frequency_count: 1, sort_order: 0 }];
        if (cmd === "create_action" || cmd === "create_action_from_recurring") {
          const action = {
            ...(cmd === "create_action" ? args.payload : { title: "每日 AI 整理", estimated_hours: 2 }),
            id: Math.max(...actions.map(action => action.id)) + 1, status: 0, event_id: null,
          };
          actions.push(action); save(); return structuredClone(action);
        }
        if (cmd === "assign_daily_slot_action") {
          if (data.failSave) throw Error("模拟保存失败");
          const slot = slots.find(slot => slot.id === args.slotId);
          if (slot.action_id !== args.actionId) {
            data.tasks = data.tasks.filter(task => task.slot_id !== slot.id);
            for (const key of ["actual_notes", "met_expectation", "focused"]) delete slot[key];
          }
          slot.action_id = args.actionId;
          slot.action = actions.find(action => action.id === args.actionId);
          save();
          return structuredClone(slot);
        }
        if (cmd === "replace_ai_task_action") {
          if (data.failSave) throw Error("模拟保存失败");
          const previous = data.tasks.find(task => task.id === args.id);
          if (previous.updated_at !== args.expectedUpdatedAt) throw Error("任务已被更新，请关闭后重新打开");
          if (data.tasks.some(task => task.id !== previous.id && task.slot_id === previous.slot_id && task.linked_action_id === args.linkedActionId)) throw Error("该行动已挂载到这个时间段");
          const next = { ...previous, id: Math.max(...data.tasks.map(task => task.id)) + 1,
            linked_action_id: args.linkedActionId, status: "queued", result: "", updated_at: previous.updated_at + 1 };
          data.tasks = [...data.tasks.filter(task => task.id !== args.id), next];
          save(); return structuredClone(withSource(next));
        }
        if (cmd === "complete_action" || cmd === "restore_action") {
          const action = actions.find(action => action.id === args.id);
          action.status = cmd === "complete_action" ? 1 : 0;
          save(); return structuredClone(action);
        }
        if (cmd === "get_daily_schedule") return { list_date: args.listDate, slots: structuredClone(slots).map(slot => ({ ...slot, list_date: args.listDate })) };
        if (cmd === "get_ai_tasks") {
          if (data.failLoad) throw Error("模拟读取失败");
          if (args.listDate === "2026-09-28") return new Promise(resolve => {
            window.resolvePriorAi = () => resolve(structuredClone(data.tasks));
          });
          return structuredClone(data.tasks.filter(task => task.list_date === args.listDate).map(withSource));
        }
        if (cmd === "create_ai_task" || cmd === "update_ai_task") {
          if (data.failSave) throw Error("模拟保存失败");
          if (data.holdSave) await new Promise(resolve => { window.releaseAiSave = resolve; });
          const previous = data.tasks.find(task => task.id === args.payload.id);
          if (!previous && data.tasks.some(task => task.slot_id === args.payload.slot_id && task.linked_action_id === args.payload.linked_action_id)) throw Error("该行动已挂载到这个时间段");
          if (previous && previous.updated_at !== args.payload.expected_updated_at) throw Error("任务已被更新，请关闭后重新打开");
          const next = {
            ...previous, ...args.payload,
            id: previous?.id ?? Math.max(0, ...data.tasks.map(task => task.id)) + 1,
            created_at: previous?.created_at ?? 1, updated_at: (previous?.updated_at ?? 0) + 1,
          };
          const source = actions.find(action => action.id === next.linked_action_id);
          source.status = next.status === "completed" ? 1 : 0;
          data.tasks = previous ? data.tasks.map(task => task.id === next.id ? next : task) : [...data.tasks, next];
          save(); return structuredClone(withSource(next));
        }
        if (cmd === "delete_ai_task") {
          if (data.failDelete) throw Error("模拟删除失败");
          data.tasks = data.tasks.filter(task => task.id !== args.id); save(); return null;
        }
        if (cmd === "move_daily_slot_action") {
          const source = slots.find(slot => slot.id === args.sourceSlotId);
          const target = slots.find(slot => slot.id === args.targetSlotId);
          for (const task of data.tasks) {
            if (task.slot_id === source.id && task.action_id === source.action_id) {
              task.slot_id = target.id; task.updated_at += 1;
            } else if (task.slot_id === target.id && task.action_id === target.action_id) {
              task.slot_id = source.id; task.updated_at += 1;
            }
          }
          for (const key of ["action_id", "action", "actual_notes", "met_expectation", "focused"]) [source[key], target[key]] = [target[key], source[key]];
          save();
          return structuredClone([source, target]);
        }
        if (cmd === "get_daily_used_dates") return [];
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
}
const shot = async (page, name) => {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
};
const drawer = page => page.locator(".daily-ai-editor");
const openRecords = async page => {
  const detail = page.getByRole("dialog", { name: /^行动详情/ });
  await detail.getByRole("button", { name: "更换行动", exact: true }).waitFor();
  assert.equal(await page.locator(".ant-drawer").count(), 0);
  await detail.getByRole("button", { name: "任务记录", exact: true }).click();
};
const picker = page => page.getByRole("dialog", { name: /^安排行动/ });
const chooseStatus = async (page, name) => {
  await drawer(page).getByRole("combobox", { name: "任务状态", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
};
const saveTask = async page => {
  await drawer(page).getByRole("button", { name: "保存任务", exact: true }).click();
  await drawer(page).waitFor({ state: "hidden" });
};
const openAdd = async (page, index = 0) => {
  const plan = page.locator(".daily-plan-main").nth(index);
  await plan.hover();
  await plan.getByRole("button", { name: /添加 AI 任务/ }).click();
  await picker(page).locator(".ant-radio-button-wrapper").filter({ hasText: "事件行动" }).waitFor();
  assert.equal(await drawer(page).count(), 0);
};
const chooseAction = async (page, name) => {
  await picker(page).getByRole("button", { name: "平铺视图", exact: true }).click();
  await picker(page).locator(".daily-action-picker-item").filter({ hasText: name }).click();
  await picker(page).waitFor({ state: "hidden" });
};

test("one AI action is selectable across slots, with per-slot duplicates and independent removal", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await fixture(page);
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await openAdd(page, 0);
    await chooseAction(page, "整理竞品材料");
    await openAdd(page, 1);
    await chooseAction(page, "整理竞品材料");
    const rows = page.locator(".daily-schedule-row");
    await rows.nth(1).locator(".daily-ai-task").waitFor();
    assert.equal(await page.locator(".daily-ai-task").count(), 2);
    assert.deepEqual(await page.evaluate(() => window.aiFixture.tasks.map(task => [task.slot_id, task.linked_action_id])), [[1, 3], [2, 3]]);
    await openAdd(page, 0);
    assert.equal(await picker(page).locator(".daily-action-picker-item").filter({ hasText: "整理竞品材料" }).count(), 0);
    await picker(page).locator(".ant-modal-close").click();
    await picker(page).waitFor({ state: "hidden" });
    await rows.nth(1).locator(".daily-ai-task").click();
    await page.getByRole("dialog", { name: /^行动详情/ }).getByRole("button", { name: "更换行动", exact: true }).click();
    await chooseAction(page, "生成一份包含边界情况与例外路径的完整需求分析文档");
    await rows.nth(1).locator(".daily-ai-task").click();
    await page.getByRole("dialog", { name: /^行动详情/ }).getByRole("button", { name: "更换行动", exact: true }).click();
    await chooseAction(page, "整理竞品材料");
    const idsBefore = await page.evaluate(() => window.aiFixture.tasks.map(task => [task.id, task.slot_id]));
    await rows.nth(0).locator(".daily-plan-cell").dragTo(rows.nth(1).locator(".daily-plan-cell"));
    await page.waitForFunction(() => window.aiFixture.calls.some(call => call.cmd === "move_daily_slot_action"));
    assert.deepEqual(await page.evaluate(() => window.aiFixture.tasks.map(task => [task.id, task.slot_id])),
      idsBefore.map(([id, slot]) => [id, slot === 1 ? 2 : 1]));
    await page.reload();
    await rows.nth(0).locator(".daily-ai-task").waitFor();
    await rows.nth(1).locator(".daily-ai-task").waitFor();
    await shot(page, "ai-same-action-multiple-slots.png");
    await rows.nth(0).locator(".daily-ai-task").click();
    const details = page.getByRole("dialog", { name: /^行动详情/ });
    await details.getByRole("button", { name: "移出今日事", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^移\s*出$/ }).click();
    await details.waitFor({ state: "hidden" });
    assert.equal(await rows.nth(0).locator(".daily-ai-task").count(), 0);
    assert.equal(await rows.nth(1).locator(".daily-ai-task").count(), 1);
    assert.equal(await page.evaluate(() => window.aiFixture.actions.find(action => action.id === 3).status), 0);
  } catch (error) { await shot(page, "ai-multiple-slots-failure.png"); throw error; }
  finally { await browser.close(); }
});

test("AI parallel preference hides all entries and metrics without requests or data loss", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await fixture(page);
  const navigate = name => page.locator(".sidebar").getByRole("link", { name, exact: true }).click();
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await openAdd(page, 0);
    await chooseAction(page, "整理竞品材料");
    await openAdd(page, 1);
    await chooseAction(page, "整理竞品材料");
    await page.evaluate(() => {
      const tasks = window.aiFixture.tasks;
      Object.assign(tasks[1], { start_time: null, end_time: null, result: "保留这份任务记录" });
      sessionStorage.setItem("ai-fixture-tasks", JSON.stringify(tasks));
    });
    await page.reload();
    await page.locator(".daily-ai-statistics").getByText("未设时间 1 项", { exact: true }).waitFor();
    const records = await page.evaluate(() => structuredClone(window.aiFixture.tasks));
    await navigate("设置");
    assert.equal(await page.getByRole("switch", { name: "AI 并行", exact: true }).getAttribute("aria-checked"), "true");
    await page.getByRole("switch", { name: "AI 并行", exact: true }).click();
    await page.evaluate(() => { window.aiFixture.calls = []; window.aiFixture.failLoad = true; });
    await navigate("今日事");
    await page.getByLabel("已安排总时长 2 小时 30 分钟", { exact: true }).waitFor();
    for (const selector of [".daily-ai-add", ".daily-ai-task", ".daily-ai-statistics", ".daily-ai-editor", ".has-ai-tasks"]) {
      assert.equal(await page.locator(selector).count(), 0, selector);
    }
    assert.equal(await page.getByText("AI 任务加载失败", { exact: true }).count(), 0);
    assert.match(await page.locator(".daily-review-statistics").textContent(), /高效时段占比.*复盘覆盖率/);
    assert.equal(await page.evaluate(() => window.aiFixture.calls.some(call => call.cmd === "get_ai_tasks")), false);
    await page.getByLabel("高效时段占比口径", { exact: true }).hover();
    await page.getByRole("tooltip").waitFor();
    assert.doesNotMatch(await page.getByRole("tooltip").textContent(), /AI/);
    await page.locator(".page-title").hover();
    await shot(page, "ai-parallel-disabled.png");
    await page.reload();
    await page.getByLabel("已安排总时长 2 小时 30 分钟", { exact: true }).waitFor();
    assert.equal(await page.locator(".daily-ai-add, .daily-ai-task, .daily-ai-statistics").count(), 0);
    assert.equal(await page.evaluate(() => window.aiFixture.calls.some(call => call.cmd === "get_ai_tasks")), false);
    assert.deepEqual(await page.evaluate(() => window.aiFixture.tasks), records);
    await navigate("设置");
    assert.equal(await page.getByRole("switch", { name: "AI 并行", exact: true }).getAttribute("aria-checked"), "false");
    await page.getByRole("switch", { name: "AI 并行", exact: true }).click();
    await navigate("今日事");
    await page.locator(".daily-ai-statistics").getByText("未设时间 1 项", { exact: true }).waitFor();
    assert.equal(await page.locator(".daily-ai-task").count(), 2);
    assert.deepEqual(await page.evaluate(() => window.aiFixture.tasks), records);
    await navigate("设置");
    await page.getByRole("switch", { name: "数据统计", exact: true }).click();
    await navigate("今日事");
    await page.locator(".daily-ai-task").first().waitFor();
    assert.equal(await page.locator(".daily-statistics").count(), 0);
    assert.equal(await page.locator(".daily-ai-task").count(), 2);
    await navigate("设置");
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "lifeplan-optional-features-v1") throw Error("Storage unavailable");
        return original.call(this, key, value);
      };
    });
    await page.getByRole("switch", { name: "AI 并行", exact: true }).click();
    await page.getByText("设置未保存，请稍后重试", { exact: true }).waitFor();
    assert.equal(await page.getByRole("switch", { name: "AI 并行", exact: true }).getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(() => window.aiFixture.calls.some(call => /^(create|update|delete|replace)_ai_task/.test(call.cmd))), false);
    assert.deepEqual(errors, []);
  } catch (error) { await shot(page, "ai-preference-failure.png"); throw error; }
  finally { await browser.close(); }
});

test("AI tasks keep idle rows compact, persist, follow actions and do not complete parents", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await fixture(page);
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await page.getByLabel("已安排总时长 2 小时 30 分钟", { exact: true }).waitFor();
    assert.deepEqual(await page.locator(".daily-schedule-row").evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height)), [40, 40, 40, 40]);
    assert.equal(await page.locator(".daily-ai-tasks").count(), 0);
    assert.equal(await page.locator(".daily-ai-statistics").count(), 0);
    await page.locator(".page-title").hover();
    assert.equal(await page.locator(".daily-ai-add").first().evaluate(el => getComputedStyle(el).opacity), "0");
    await shot(page, "ai-empty-desktop.png");
    await openAdd(page);
    await picker(page).getByRole("button", { name: "平铺视图", exact: true }).waitFor();
    assert.deepEqual(await picker(page).locator(".daily-action-preview-title-text").allTextContents(), ["整理竞品材料", "生成一份包含边界情况与例外路径的完整需求分析文档"]);
    await picker(page).getByRole("button", { name: "按事件视图", exact: true }).click();
    assert.equal(await picker(page).locator(".daily-event-action-parent").count(), 2);
    await shot(page, "ai-pool-picker-desktop.png");
    await chooseAction(page, "整理竞品材料");
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].start_time), "09:00");
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].end_time), "10:00");
    await page.locator(".daily-ai-task").getByText("整理竞品材料", { exact: true }).waitFor();
    assert.equal(await page.locator(".daily-ai-tasks").count(), 1);
    const heights = await page.locator(".daily-schedule-row").evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    assert.ok(heights[0] > 40);
    assert.deepEqual(heights.slice(1), [40, 40, 40]);
    await page.reload();
    await page.locator(".daily-ai-task").getByText("整理竞品材料", { exact: true }).waitFor();
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await drawer(page).getByText("整理三个竞品的主要流程", { exact: true }).waitFor();
    await chooseStatus(page, "待我确认");
    await drawer(page).getByRole("textbox", { name: "结果与记录", exact: true }).fill("<script>window.aiResultExecuted=true</script>\n已完成资料整理");
    await drawer(page).getByRole("button", { name: "确认结果", exact: true }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.match(await page.locator(".daily-ai-task").textContent(), /已完成/);
    assert.equal(await page.evaluate(() => window.aiFixture.actions[0].status), 0);
    assert.equal(await page.evaluate(() => window.aiFixture.actions.find(action => action.id === 3).status), 1);
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "create_action").length), 0);
    assert.equal(await page.locator(".daily-plan-cell").first().getAttribute("class").then(value => value.includes("pending")), true);
    assert.equal(await page.evaluate(() => window.aiResultExecuted), undefined);

    await openAdd(page, 1);
    await chooseAction(page, "生成一份包含边界情况与例外路径的完整需求分析文档");
    await page.locator(".daily-ai-task").filter({ hasText: "生成一份包含边界情况与例外路径的完整需求分析文档" }).click();
    await openRecords(page);
    await chooseStatus(page, "执行中");
    await drawer(page).getByRole("combobox", { name: "计划结束时间", exact: true }).click();
    await page.getByRole("option", { name: "11:30", exact: true }).click();
    await saveTask(page);
    assert.equal(await page.locator(".daily-ai-tasks").count(), 2);
    assert.equal(await page.locator(".daily-ai-task").count(), 2);
    assert.match(await page.locator(".daily-ai-statistics").textContent(), /2 小时 30 分钟/);
    await page.getByLabel("已安排总时长 2 小时 30 分钟", { exact: true }).waitFor();
    await shot(page, "ai-nested-desktop.png");
    await page.locator(".daily-plan-cell").nth(0).dragTo(page.locator(".daily-plan-cell").nth(2));
    await page.waitForFunction(() => document.querySelectorAll(".daily-plan-cell")[0]?.textContent.includes("整理学习笔记"));
    await page.locator(".daily-schedule-row").nth(2).locator(".daily-ai-task").waitFor();
    assert.equal(await page.locator(".daily-ai-tasks").count(), 2);
    assert.equal(await page.locator(".daily-ai-task").count(), 2);
    assert.equal(await page.locator(".daily-schedule-row").nth(1).locator(".daily-ai-task").count(), 1);
    assert.match(await page.locator(".daily-schedule-row").nth(2).textContent(), /需求复盘/);
    await page.locator(".daily-ai-task").first().click();
    await openRecords(page);
    await shot(page, "ai-detail-desktop.png");
    await drawer(page).getByRole("button", { name: /^取\s*消$/ }).click();
    await drawer(page).waitFor({ state: "hidden" });

    for (const width of [1050, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await shot(page, `ai-nested-${width}.png`);
      assert.equal(await page.locator(".daily-ai-task").first().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    }
    await page.setViewportSize({ width: 1050, height: 850 });
    await page.locator(".daily-ai-task").first().click();
    await openRecords(page);
    await drawer(page).getByRole("button", { name: "解除挂载", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: "解除挂载", exact: true }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".daily-ai-task").count(), 1);
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await drawer(page).getByRole("button", { name: "解除挂载", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: "解除挂载", exact: true }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".daily-ai-statistics").count(), 0);
    assert.equal(await page.evaluate(() => window.aiFixture.actions.find(action => action.id === 3).status), 1);
    assert.equal(await page.evaluate(() => window.aiFixture.actions.find(action => action.id === 4).title), "生成一份包含边界情况与例外路径的完整需求分析文档");
    assert.deepEqual(await page.locator(".daily-schedule-row").evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height)), [40, 40, 40, 40]);
    assert.deepEqual(errors, []);
  } catch (error) { await shot(page, "ai-nested-failure.png"); throw error; }
  finally { await browser.close(); }
});

test("AI editor keeps drafts on failure, validates times, isolates dates and serializes saves", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await fixture(page);
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await openAdd(page);
    await chooseAction(page, "整理竞品材料");
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await drawer(page).getByRole("textbox", { name: "结果与记录", exact: true }).fill("保留草稿");
    await drawer(page).getByRole("combobox", { name: "计划结束时间", exact: true }).click();
    await page.getByRole("option", { name: "08:30", exact: true }).click();
    await drawer(page).getByRole("button", { name: "保存任务", exact: true }).click();
    await drawer(page).getByText("需晚于开始时间，不能跨天", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "update_ai_task").length), 0);
    await drawer(page).getByRole("combobox", { name: "计划结束时间", exact: true }).click();
    await page.getByRole("option", { name: "24:00", exact: true }).click();
    await page.evaluate(() => { window.aiFixture.failSave = true; });
    await drawer(page).getByRole("button", { name: "保存任务", exact: true }).click();
    await drawer(page).getByText("模拟保存失败", { exact: true }).waitFor();
    assert.equal(await drawer(page).getByRole("textbox", { name: "结果与记录", exact: true }).inputValue(), "保留草稿");
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].result), "");
    await drawer(page).getByRole("button", { name: /^取\s*消$/ }).click();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await page.evaluate(() => { window.aiFixture.failSave = false; window.aiFixture.holdSave = true; });
    await drawer(page).getByRole("button", { name: "保存任务", exact: true }).click();
    await page.waitForFunction(() => typeof window.releaseAiSave === "function");
    assert.equal(await drawer(page).getByRole("button", { name: /^取\s*消$/ }).isDisabled(), true);
    await page.evaluate(() => { window.aiFixture.holdSave = false; window.releaseAiSave(); });
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.aiFixture.tasks.length), 1);
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].end_time), "24:00");
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await drawer(page).getByRole("textbox", { name: "结果与记录", exact: true }).fill("尚未保存的结果");
    await drawer(page).getByRole("button", { name: /^取\s*消$/ }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].result), "保留草稿");

    const chooseDate = async date => {
      await page.locator(".daily-date-panel input").fill(date);
      await page.locator(".daily-date-panel input").press("Enter");
    };
    await chooseDate("2026年09月28日");
    await page.waitForFunction(() => typeof window.resolvePriorAi === "function");
    await chooseDate("2026年09月27日");
    await page.waitForFunction(() => window.aiFixture.calls.some(call => call.cmd === "get_ai_tasks" && call.args.listDate === "2026-09-27"));
    await page.evaluate(() => window.resolvePriorAi());
    assert.equal(await page.locator(".daily-ai-task").count(), 0);
    await page.evaluate(() => { window.aiFixture.failLoad = true; });
    await chooseDate("2026年09月29日");
    await page.getByText("AI 任务加载失败", { exact: true }).waitFor();
    assert.equal(await page.locator(".daily-ai-add").first().isDisabled(), true);
    assert.equal(await page.locator(".daily-plan-cell").count(), 4);
    await page.evaluate(() => { window.aiFixture.failLoad = false; });
    await page.getByRole("button", { name: /^重\s*试$/ }).click();
    await page.locator(".daily-ai-task").getByText("整理竞品材料", { exact: true }).waitFor();
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "ai-detail-mobile.png");
    assert.equal(await drawer(page).locator(".ant-modal-body").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.deepEqual(errors, []);
  } catch (error) { await shot(page, "ai-editor-failure.png"); throw error; }
  finally { await browser.close(); }
});

test("AI attachments share pool actions and recover from pool loading failures", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await fixture(page);
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await page.locator(".daily-plan-main").first().waitFor();
    await page.evaluate(() => { window.aiFixture.failPool = true; });
    await openAdd(page);
    await picker(page).getByText("事件篮加载失败", { exact: true }).waitFor();
    assert.equal(await picker(page).locator(".daily-action-picker-item").count(), 0);
    await page.evaluate(() => { window.aiFixture.failPool = false; });
    await picker(page).getByRole("button", { name: /^重\s*试$/ }).click();
    await chooseAction(page, "整理竞品材料");
    await page.locator(".daily-ai-task").waitFor();
    await openAdd(page);
    await picker(page).getByRole("button", { name: "平铺视图", exact: true }).waitFor();
    assert.deepEqual(await picker(page).locator(".daily-action-preview-title-text").allTextContents(), ["生成一份包含边界情况与例外路径的完整需求分析文档"]);
    await picker(page).getByRole("button", { name: /^取\s*消$/ }).click();
    await picker(page).waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "事件篮", exact: true }).click();
    const project = page.locator(".record-card").filter({ hasText: "项目" });
    await project.getByRole("button", { name: "行动 0/2", exact: true }).click();
    await project.locator("[data-event-action-id='3']").getByRole("button", { name: "完成", exact: true }).click();
    await project.getByRole("button", { name: "行动 1/2", exact: true }).waitFor();
    await page.getByRole("link", { name: "今日事", exact: true }).click();
    await page.locator(".daily-ai-task").getByText("已完成", { exact: true }).waitFor();
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await chooseStatus(page, "等待中");
    await saveTask(page);
    await page.getByRole("link", { name: "事件篮", exact: true }).click();
    await project.getByRole("button", { name: "行动 0/2", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.actions[0].status), 0);

    await page.evaluate(() => {
      const source = window.aiFixture.actions.find(action => action.id === 3);
      source.title = "事件篮统一改名";
      source.description = "事件篮中的最新说明";
    });
    await page.getByRole("link", { name: "今日事", exact: true }).click();
    await page.locator(".daily-ai-task").getByText("事件篮统一改名", { exact: true }).waitFor();
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await drawer(page).getByText("事件篮中的最新说明", { exact: true }).waitFor();
    await page.evaluate(() => { window.aiFixture.failDelete = true; });
    await drawer(page).getByRole("button", { name: "解除挂载", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: "解除挂载", exact: true }).click();
    await drawer(page).getByText("模拟删除失败", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.tasks.length), 1);
    await page.evaluate(() => { window.aiFixture.failDelete = false; });
    await drawer(page).getByRole("button", { name: "解除挂载", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: "解除挂载", exact: true }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".daily-ai-task").count(), 0);
    await openAdd(page);
    await chooseAction(page, "事件篮统一改名");
    assert.equal(await page.evaluate(() => window.aiFixture.tasks.length), 1);
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "create_action" || call.cmd === "delete_action").length), 0);
  } catch (error) { await shot(page, "ai-pool-failure.png"); throw error; }
  finally { await browser.close(); }
});

test("AI entry reuses the action picker with all three sources and retry protection", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 }, reducedMotion: "reduce" });
  await fixture(page);
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await page.locator(".daily-plan-cell").nth(3).click();
    const originalTabs = await picker(page).locator(".ant-radio-button-wrapper").allTextContents();
    await picker(page).getByRole("button", { name: "按事件视图", exact: true }).click();
    await picker(page).getByRole("button", { name: /^取\s*消$/ }).click();
    await picker(page).waitFor({ state: "hidden" });
    const originalSlots = await page.evaluate(() => JSON.stringify(window.aiFixture.slots));
    await openAdd(page);
    assert.deepEqual(await picker(page).locator(".ant-radio-button-wrapper").allTextContents(), originalTabs);
    await picker(page).locator(".daily-event-action-parent").first().waitFor();
    assert.equal(await picker(page).locator(".daily-event-action-parent").count(), 2);
    await picker(page).getByPlaceholder("搜索行动标题关键词").fill("不存在的行动");
    await picker(page).getByText("没有符合条件的行动", { exact: true }).waitFor();
    await picker(page).getByPlaceholder("搜索行动标题关键词").fill("");
    await shot(page, "shared-ai-picker-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "shared-ai-picker-mobile.png");
    assert.equal(await picker(page).evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.setViewportSize({ width: 1050, height: 850 });
    await picker(page).locator(".daily-event-action-parent").filter({ hasText: "项目" }).click();
    await page.evaluate(() => { window.aiFixture.failSave = true; });
    await picker(page).locator(".daily-action-picker-item").filter({ hasText: "整理竞品材料" }).click();
    await picker(page).getByText("模拟保存失败", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.tasks.length), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(window.aiFixture.slots)), originalSlots);
    await page.evaluate(() => { window.aiFixture.failSave = false; window.aiFixture.holdSave = true; });
    await picker(page).locator(".daily-action-picker-item").filter({ hasText: "整理竞品材料" }).evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => typeof window.releaseAiSave === "function");
    assert.equal(await picker(page).getByRole("button", { name: /^取\s*消$/ }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "create_ai_task").length), 2);
    await page.evaluate(() => { window.aiFixture.holdSave = false; window.releaseAiSave(); });
    await picker(page).waitFor({ state: "hidden" });

    await openAdd(page);
    await picker(page).locator(".ant-radio-button-wrapper").filter({ hasText: "重复行动" }).click();
    await page.evaluate(() => { window.aiFixture.failSave = true; });
    await picker(page).locator(".daily-action-picker-item").filter({ hasText: "每日 AI 整理" }).click();
    await picker(page).getByText("模拟保存失败", { exact: true }).waitFor();
    await page.evaluate(() => { window.aiFixture.failSave = false; });
    await picker(page).locator(".daily-action-picker-item").filter({ hasText: "每日 AI 整理" }).click();
    await picker(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "create_action_from_recurring").length), 1);
    await page.locator(".daily-ai-task").filter({ hasText: "每日 AI 整理" }).waitFor();

    await openAdd(page);
    await picker(page).locator(".ant-radio-button-wrapper").filter({ hasText: "临时行动" }).click();
    await picker(page).getByRole("textbox", { name: /行动标题$/ }).fill("临时 AI 检查");
    await page.evaluate(() => { window.aiFixture.failSave = true; });
    await picker(page).getByRole("button", { name: "创建并安排", exact: true }).click();
    await picker(page).getByText("模拟保存失败", { exact: true }).waitFor();
    await page.evaluate(() => { window.aiFixture.failSave = false; });
    await picker(page).getByRole("button", { name: "创建并安排", exact: true }).click();
    await picker(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "create_action").length), 1);
    await page.locator(".daily-ai-task").filter({ hasText: "临时 AI 检查" }).waitFor();
    assert.equal(await page.locator(".daily-ai-task").count(), 3);
    assert.equal(await page.evaluate(() => JSON.stringify(window.aiFixture.slots)), originalSlots);
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "assign_daily_slot_action").length), 0);
    await page.getByLabel("已安排总时长 2 小时 30 分钟", { exact: true }).waitFor();

    await page.locator(".daily-plan-cell").nth(3).click();
    await chooseAction(page, "整理竞品材料");
    assert.equal(await page.evaluate(() => window.aiFixture.slots[3].action_id), 3);
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "assign_daily_slot_action").length), 1);
    assert.equal(await page.locator(".daily-ai-task").count(), 3);
  } catch (error) { await shot(page, "shared-ai-picker-failure.png"); throw error; }
  finally { await browser.close(); }
});

test("afternoon AI tasks attach to the clicked occurrence across edits reloads and dragging", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await fixture(page);
  const rows = page.locator(".daily-schedule-row");
  const expectTaskAt = async index => {
    await rows.nth(index).locator(".daily-ai-task").getByText("整理竞品材料", { exact: true }).waitFor();
    assert.equal(await page.locator(".daily-ai-task").count(), 1);
    for (const other of [0, 1, 2, 3].filter(value => value !== index)) {
      assert.equal(await rows.nth(other).locator(".daily-ai-task").count(), 0);
    }
    assert.equal(await page.locator(".daily-ai-count").count(), 0);
  };
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await page.evaluate(() => {
      const slots = window.aiFixture.slots;
      Object.assign(slots[0], { start_time: "11:00", end_time: "12:00" });
      Object.assign(slots[1], { start_time: "13:30", end_time: "14:30" });
      Object.assign(slots[2], { start_time: "14:30", end_time: "15:30" });
      Object.assign(slots[3], { start_time: "15:30", end_time: "16:30" });
      sessionStorage.setItem("ai-fixture-slots", JSON.stringify(slots));
    });
    await page.reload();
    await openAdd(page, 1);
    await chooseAction(page, "整理竞品材料");
    await expectTaskAt(1);
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].slot_id), 2);
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].start_time), "13:30");
    assert.equal(await rows.nth(0).evaluate(el => el.getBoundingClientRect().height), 40);
    await shot(page, "afternoon-ai-correct-row.png");
    await page.reload();
    await expectTaskAt(1);
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    await drawer(page).getByRole("combobox", { name: "计划开始时间", exact: true }).click();
    await page.getByRole("option", { name: "11:00", exact: true }).click();
    await saveTask(page);
    await expectTaskAt(1);
    await page.locator(".daily-ai-task").click();
    await openRecords(page);
    for (const index of [0, 1]) {
      const field = drawer(page).locator(".daily-ai-time-fields .ant-select").nth(index);
      await field.hover();
      await field.getByRole("button", { name: "Clear", exact: true }).click();
    }
    await saveTask(page);
    await expectTaskAt(1);
    await page.reload();
    await expectTaskAt(1);
    assert.equal(await page.locator(".daily-ai-task-time").count(), 0);
    await page.locator(".daily-plan-cell").nth(1).dragTo(page.locator(".daily-plan-cell").nth(0));
    await expectTaskAt(0);
    await page.reload();
    await expectTaskAt(0);
    await page.locator(".daily-plan-cell").nth(0).dragTo(page.locator(".daily-plan-cell").nth(3));
    await expectTaskAt(3);
    await page.reload();
    await expectTaskAt(3);
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].slot_id), 4);
    assert.equal(await rows.nth(1).locator(".daily-plan-cell").textContent().then(text => text.includes("准备项目需求")), true);
    await shot(page, "afternoon-ai-moved-row.png");
  } catch (error) { await shot(page, "afternoon-ai-failure.png"); throw error; }
  finally { await browser.close(); }
});

test("AI edit shares action details; replacement and removing one occurrence preserve pool actions", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 } });
  await fixture(page);
  const details = () => page.getByRole("dialog", { name: /^行动详情/ });
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await openAdd(page, 1);
    await chooseAction(page, "整理竞品材料");
    await page.locator(".daily-ai-task").click();
    await details().getByText("整理竞品材料", { exact: true }).waitFor();
    assert.equal(await page.locator(".ant-drawer").count(), 0);
    await shot(page, "ai-shared-action-detail.png");
    await details().getByRole("button", { name: "更换行动", exact: true }).click();
    await picker(page).getByRole("button", { name: "平铺视图", exact: true }).click();
    await page.evaluate(() => { window.aiFixture.failSave = true; });
    await picker(page).locator(".daily-action-picker-item").filter({ hasText: "生成一份包含边界情况与例外路径的完整需求分析文档" }).click();
    await picker(page).getByText("模拟保存失败", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].linked_action_id), 3);
    await page.evaluate(() => { window.aiFixture.failSave = false; });
    await chooseAction(page, "生成一份包含边界情况与例外路径的完整需求分析文档");
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].slot_id), 2);
    assert.equal(await page.locator(".daily-schedule-row").first().locator(".daily-ai-task").count(), 0);
    const statsText = await page.locator(".daily-statistics").textContent();
    assert.doesNotMatch(statsText, /执行中|待我确认/);
    assert.match(statsText, /高效时段占比/);
    await page.locator(".daily-plan-cell").nth(1).click();
    await details().getByRole("button", { name: "移出今日事", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^取\s*消$/ }).click();
    assert.equal(await page.evaluate(() => window.aiFixture.slots[1].action_id), 1);
    await page.evaluate(() => { window.aiFixture.failSave = true; });
    await details().getByRole("button", { name: "移出今日事", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^移\s*出$/ }).click();
    await details().getByText("模拟保存失败", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.slots[1].action_id), 1);
    await page.evaluate(() => { window.aiFixture.failSave = false; });
    await details().getByRole("button", { name: "移出今日事", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^移\s*出$/ }).click();
    await details().waitFor({ state: "hidden" });
    await page.locator(".daily-plan-cell.empty").nth(0).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.slots[0].action_id), 1);
    assert.equal(await page.evaluate(() => window.aiFixture.actions.length), 6);
    assert.equal(await page.locator(".daily-ai-task").count(), 0);
    await page.reload();
    await page.locator(".daily-plan-cell").nth(1).getByText("+ 点击安排行动", { exact: true }).waitFor();
    await page.locator(".daily-plan-cell").first().click();
    await details().getByRole("button", { name: "移出今日事", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^移\s*出$/ }).click();
    await details().waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.aiFixture.slots[0].actual_notes), undefined);
    await page.getByLabel("已安排总时长 1 小时", { exact: true }).waitFor();
    await shot(page, "removed-action-statistics.png");
  } catch (error) { await shot(page, "shared-edit-removal-failure.png"); throw error; }
  finally { await browser.close(); }
});
