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
    const actions = [
      { id: 1, event_id: 1, title: "准备项目需求", status: 0, estimated_hours: 1 },
      { id: 2, event_id: 2, title: "整理学习笔记", status: 1, estimated_hours: 1 },
    ];
    const slots = [
      { id: 1, list_date: "2026-09-29", start_time: "09:00", end_time: "10:00", action_id: 1, action: actions[0], actual_notes: "需求复盘", met_expectation: 1, focused: 1 },
      { id: 2, list_date: "2026-09-29", start_time: "10:00", end_time: "10:30", action_id: 1, action: actions[0] },
      { id: 3, list_date: "2026-09-29", start_time: "10:30", end_time: "11:30", action_id: 2, action: actions[1] },
      { id: 4, list_date: "2026-09-29", start_time: "11:30", end_time: "12:00" },
    ];
    window.aiFixture = {
      actions, slots, tasks: JSON.parse(sessionStorage.getItem("ai-fixture-tasks") || "[]"),
      failSave: false, failLoad: false, failDelete: false, holdSave: false, calls: [],
    };
    const save = () => sessionStorage.setItem("ai-fixture-tasks", JSON.stringify(window.aiFixture.tasks));
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        const data = window.aiFixture;
        data.calls.push({ cmd, args: structuredClone(args) });
        if (cmd === "get_startup_notice") return null;
        if (cmd === "get_actions") return structuredClone(actions);
        if (cmd === "get_events") return [
          { id: 1, category_id: 1, category_name: "工作", category_color: "#1677ff" },
          { id: 2, category_id: 2, category_name: "成长", category_color: "#389e0d" },
        ];
        if (cmd === "get_daily_schedule") return { list_date: args.listDate, slots: structuredClone(slots).map(slot => ({ ...slot, list_date: args.listDate })) };
        if (cmd === "get_ai_tasks") {
          if (data.failLoad) throw Error("模拟读取失败");
          if (args.listDate === "2026-09-28") return new Promise(resolve => {
            window.resolvePriorAi = () => resolve(structuredClone(data.tasks));
          });
          return structuredClone(data.tasks.filter(task => task.list_date === args.listDate));
        }
        if (cmd === "create_ai_task" || cmd === "update_ai_task") {
          if (data.failSave) throw Error("模拟保存失败");
          if (data.holdSave) await new Promise(resolve => { window.releaseAiSave = resolve; });
          const previous = data.tasks.find(task => task.id === args.payload.id);
          if (previous && previous.updated_at !== args.payload.expected_updated_at) throw Error("任务已被更新，请关闭后重新打开");
          const next = {
            ...previous, ...args.payload,
            id: previous?.id ?? Math.max(0, ...data.tasks.map(task => task.id)) + 1,
            created_at: previous?.created_at ?? 1, updated_at: (previous?.updated_at ?? 0) + 1,
          };
          data.tasks = previous ? data.tasks.map(task => task.id === next.id ? next : task) : [...data.tasks, next];
          save(); return structuredClone(next);
        }
        if (cmd === "delete_ai_task") {
          if (data.failDelete) throw Error("模拟删除失败");
          data.tasks = data.tasks.filter(task => task.id !== args.id); save(); return null;
        }
        if (cmd === "move_daily_slot_action") {
          const source = slots.find(slot => slot.id === args.sourceSlotId);
          const target = slots.find(slot => slot.id === args.targetSlotId);
          for (const key of ["action_id", "action", "actual_notes", "met_expectation", "focused"]) [source[key], target[key]] = [target[key], source[key]];
          return structuredClone([source, target]);
        }
        if (cmd === "get_daily_used_dates" || cmd === "get_recurring_actions") return [];
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
  await drawer(page).getByRole("textbox", { name: /任务名称$/ }).waitFor();
};

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
    await drawer(page).getByRole("textbox", { name: /任务名称$/ }).fill("整理竞品材料");
    await drawer(page).getByRole("textbox", { name: "任务说明", exact: true }).fill("整理三个竞品的主要流程");
    await saveTask(page);
    await page.locator(".daily-ai-task").getByText("整理竞品材料", { exact: true }).waitFor();
    assert.equal(await page.locator(".daily-ai-tasks").count(), 1);
    const heights = await page.locator(".daily-schedule-row").evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    assert.ok(heights[0] > 40);
    assert.deepEqual(heights.slice(1), [40, 40, 40]);
    await page.reload();
    await page.locator(".daily-ai-task").getByText("整理竞品材料", { exact: true }).waitFor();
    await page.locator(".daily-ai-task").click();
    assert.equal(await drawer(page).getByRole("textbox", { name: "任务说明", exact: true }).inputValue(), "整理三个竞品的主要流程");
    await chooseStatus(page, "待我确认");
    await drawer(page).getByRole("textbox", { name: "结果与记录", exact: true }).fill("<script>window.aiResultExecuted=true</script>\n已完成资料整理");
    await drawer(page).getByRole("button", { name: "确认结果", exact: true }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.match(await page.locator(".daily-ai-task").textContent(), /已完成/);
    assert.equal(await page.evaluate(() => window.aiFixture.actions[0].status), 0);
    assert.equal(await page.locator(".daily-plan-cell").first().getAttribute("class").then(value => value.includes("pending")), true);
    assert.equal(await page.evaluate(() => window.aiResultExecuted), undefined);

    await openAdd(page, 1);
    await drawer(page).getByRole("textbox", { name: /任务名称$/ }).fill("生成一份包含边界情况与例外路径的完整需求分析文档");
    await chooseStatus(page, "执行中");
    await drawer(page).getByRole("combobox", { name: "计划结束时间", exact: true }).click();
    await page.getByRole("option", { name: "11:30", exact: true }).click();
    await saveTask(page);
    assert.equal(await page.locator(".daily-ai-tasks").count(), 1);
    assert.equal(await page.locator(".daily-ai-task").count(), 2);
    assert.match(await page.locator(".daily-ai-statistics").textContent(), /2 小时 30 分钟/);
    await page.getByLabel("已安排总时长 2 小时 30 分钟", { exact: true }).waitFor();
    await shot(page, "ai-nested-desktop.png");
    await page.locator(".daily-plan-cell").nth(0).dragTo(page.locator(".daily-plan-cell").nth(2));
    await page.waitForFunction(() => document.querySelectorAll(".daily-plan-cell")[0]?.textContent.includes("整理学习笔记"));
    assert.equal(await page.locator(".daily-ai-tasks").count(), 1);
    assert.equal(await page.locator(".daily-ai-task").count(), 2);
    assert.equal(await page.locator(".daily-schedule-row").nth(1).locator(".daily-ai-task").count(), 2);
    assert.match(await page.locator(".daily-schedule-row").nth(2).textContent(), /需求复盘/);
    await page.locator(".daily-ai-task").first().click();
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
    await drawer(page).getByRole("button", { name: "删除 AI 任务", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^删\s*除$/ }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".daily-ai-task").count(), 1);
    await page.locator(".daily-ai-task").click();
    await drawer(page).getByRole("button", { name: "删除 AI 任务", exact: true }).click();
    await page.locator(".ant-popconfirm").getByRole("button", { name: /^删\s*除$/ }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".daily-ai-statistics").count(), 0);
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
    await drawer(page).getByRole("textbox", { name: /任务名称$/ }).fill("保留草稿");
    await drawer(page).getByRole("combobox", { name: "计划结束时间", exact: true }).click();
    await page.getByRole("option", { name: "08:30", exact: true }).click();
    await drawer(page).getByRole("button", { name: "保存任务", exact: true }).click();
    await drawer(page).getByText("需晚于开始时间，不能跨天", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.aiFixture.calls.filter(call => call.cmd === "create_ai_task").length), 0);
    await drawer(page).getByRole("combobox", { name: "计划结束时间", exact: true }).click();
    await page.getByRole("option", { name: "24:00", exact: true }).click();
    await page.evaluate(() => { window.aiFixture.failSave = true; });
    await drawer(page).getByRole("button", { name: "保存任务", exact: true }).click();
    await drawer(page).getByText("模拟保存失败", { exact: true }).waitFor();
    assert.equal(await drawer(page).getByRole("textbox", { name: /任务名称$/ }).inputValue(), "保留草稿");
    assert.equal(await page.locator(".daily-ai-task").count(), 0);
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
    await drawer(page).getByRole("textbox", { name: "结果与记录", exact: true }).fill("尚未保存的结果");
    await drawer(page).getByRole("button", { name: /^取\s*消$/ }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await drawer(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.aiFixture.tasks[0].result), "");

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
    await page.locator(".daily-ai-task").getByText("保留草稿", { exact: true }).waitFor();
    await page.locator(".daily-ai-task").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "ai-detail-mobile.png");
    assert.equal(await drawer(page).locator(".ant-drawer-body").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.deepEqual(errors, []);
  } catch (error) { await shot(page, "ai-editor-failure.png"); throw error; }
  finally { await browser.close(); }
});
