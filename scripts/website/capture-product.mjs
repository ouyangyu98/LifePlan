import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const output = fileURLToPath(new URL("../../website/public/images/", import.meta.url));
await mkdir(output, { recursive: true });
await copyFile(fileURLToPath(new URL("../../src-tauri/icons/128x128.png", import.meta.url)), path.join(output, "logo.png"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1.5 });
page.setDefaultTimeout(8000);
await page.clock.install({ time: new Date("2026-10-19T14:00:00") });
await page.addInitScript(() => {
  localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
  localStorage.setItem("lifeplan-optional-features-v1", JSON.stringify({
    workLog: false, templates: false, rewards: false, pomodoro: false, insights: true,
    weeklySummary: true, dailyStatistics: true, aiParallel: true, reviewExpectation: false,
  }));
  localStorage.setItem("lifeplan-inbox-views-v1", JSON.stringify({ events: "board" }));
  const categories = [
    { id: 1, name: "工作", color: "#1778FF", sort_order: 0 },
    { id: 2, name: "成长", color: "#13A8A8", sort_order: 1 },
    { id: 3, name: "生活", color: "#D48806", sort_order: 2 },
  ];
  const events = [
    { id: 1, title: "让产品方案更进一步", status: 1, category_id: 1 },
    { id: 2, title: "每周留一点时间给阅读", status: 1, category_id: 2 },
    { id: 3, title: "照顾好日常生活", status: 1, category_id: 3 },
    { id: 4, title: "探索一个新想法", status: 0, category_id: 1 },
  ];
  const actions = [
    { id: 1, event_id: 1, title: "梳理用户反馈", description: "从真实问题出发，找到这次最值得解决的一件事。", status: 1, completed_at: new Date("2026-10-19T10:00:00").getTime(), estimated_hours: 1 },
    { id: 2, event_id: 1, title: "完善产品方案", description: "补齐核心流程，明确本次的范围和取舍。", status: 0, estimated_hours: 1.5 },
    { id: 3, event_id: 1, title: "整理竞品案例与差异", description: "整理三个产品的关键流程，保留可参考的细节。", status: 0, estimated_hours: 0 },
    { id: 4, event_id: 1, title: "准备评审材料", status: 0, estimated_hours: 1 },
    { id: 5, event_id: 2, title: "阅读与记录", description: "读一章书，记下一条真正有启发的想法。", status: 0, estimated_hours: 0.5 },
    { id: 6, event_id: 3, title: "散步，给自己一点留白", status: 0, estimated_hours: 0.5 },
    { id: 7, event_id: 1, title: "检查方案边界", description: "整理异常场景，结果由我逐项确认。", status: 0, estimated_hours: 0 },
    { id: 8, event_id: 2, title: "整理本周阅读笔记", status: 1, completed_at: new Date("2026-10-19T11:30:00").getTime(), estimated_hours: 0.5 },
    { id: 9, event_id: 4, title: "先列出需要验证的问题", status: 0, estimated_hours: 0 },
  ].map((action, index) => ({ ...action, event_title: events.find(event => event.id === action.event_id).title, sort_order: index, created_at: 1, updated_at: 1 }));
  const slots = [
    { id: 1, start_time: "09:00", end_time: "10:00", action_id: 1, actual_notes: "整理出 3 个主要问题，明确这次先解决什么。", met_expectation: 1, focused: 1 },
    { id: 2, start_time: "10:00", end_time: "11:00", action_id: 4, actual_notes: "评审提纲已整理，两个决策点留待讨论。", focused: 0 },
    { id: 3, start_time: "11:00", end_time: "11:30", action_id: 5 },
    { id: 4, start_time: "13:30", end_time: "15:00", action_id: 2 },
    { id: 5, start_time: "15:00", end_time: "15:30", action_id: 6 },
    { id: 6, start_time: "15:30", end_time: "16:00" },
  ].map(slot => ({ ...slot, list_date: "2026-10-19", action: actions.find(action => action.id === slot.action_id) }));
  const task = { id: 1, action_id: 2, linked_action_id: 3, slot_id: 4, list_date: "2026-10-19",
    title: "整理竞品案例与差异", event_title: events[0].title, status: "running",
    start_time: "13:30", end_time: "14:30", notes: actions[2].description,
    result: "", read_only: false, created_at: 1, updated_at: 1 };
  const tasks = [task, { ...task, id: 2, linked_action_id: 7, title: "检查方案边界", status: "ready",
    start_time: null, end_time: null, result: "已列出需要确认的异常场景。", notes: actions.find(action => action.id === 7).description }];
  const readEvent = (event) => {
    const children = actions.filter(action => action.event_id === event.id);
    const category = categories.find(category => category.id === event.category_id);
    return { ...event, category_name: category.name, category_color: category.color, action_count: children.length,
      completed_action_count: children.filter(action => action.status === 1).length,
      pending_action_count: children.filter(action => action.status === 0).length };
  };
  const makeItems = () => actions.filter(action => action.id !== 9).map(action => {
    const event = readEvent(events.find(event => event.id === action.event_id));
    const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const arranged = slots.filter(slot => slot.action_id === action.id);
    const parallel = tasks.filter(task => task.linked_action_id === action.id);
    return { ...action, description: action.description ?? null, completed_at: action.completed_at ?? null,
      category_name: event.category_name, category_color: event.category_color, event_completed: false,
      completed_in_week: action.status === 1, planned_minutes: arranged.reduce((sum, slot) => sum + minutes(slot.end_time) - minutes(slot.start_time), 0),
      arrangements: [
        ...arranged.map(slot => ({ list_date: slot.list_date, start_time: slot.start_time, end_time: slot.end_time, actual_notes: slot.actual_notes ?? null, parallel: false })),
        ...parallel.map(task => ({ list_date: task.list_date, start_time: "13:30", end_time: "15:00", actual_notes: task.result || null, parallel: true })),
      ] };
  });
  const weekly = {
    space_id: "website-demo", week_start: "2026-10-19", content: "## 本周思考\n\n先从反馈里明确真正的问题，再为下一步留出时间。\n\n- 产品方案先明确取舍，再补齐细节。\n- AI 整理资料，我负责核对和判断。",
    updated_at: 1, total_minutes: 270,
    categories: [{ id: 1, name: "工作", color: "#1778FF", minutes: 210, percentage: 77.8 },
      { id: 2, name: "成长", color: "#13A8A8", minutes: 30, percentage: 11.1 },
      { id: 3, name: "生活", color: "#D48806", minutes: 30, percentage: 11.1 }],
    items: makeItems(),
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 1, unregisterCallback() {},
    invoke: async (cmd, args = {}) => {
      if (cmd === "get_actions") return structuredClone(actions);
      if (cmd === "get_events") return events.map(readEvent);
      if (cmd === "get_event_categories") return categories;
      if (cmd === "get_daily_schedule") return { list_date: args.listDate, slots };
      if (cmd === "get_ai_tasks") return tasks;
      if (cmd === "get_daily_event_pool") return {
        space_id: "website-demo", list_date: args.listDate, event_ids: [1, 2],
        entries: [1, 2].map(id => ({ event: readEvent(events.find(event => event.id === id)), actions: actions.filter(action => action.event_id === id) })),
      };
      if (cmd === "get_daily_activity_items") return makeItems();
      if (cmd === "get_weekly_summary") return { ...weekly, week_start: args.weekStart };
      if (cmd === "list_weekly_records") return [
        { ...weekly }, { week_start: "2026-10-12", content: "保持行动的颗粒度，给阅读留一点时间。", total_minutes: 840, updated_at: 1 },
        { week_start: "2026-10-05", content: "先完成，再迭代。", total_minutes: 720, updated_at: 1 },
      ];
      if (cmd === "get_daily_used_dates") return ["2026-10-12", "2026-10-16", "2026-10-19"];
      if (cmd === "get_recurring_actions") return [];
      if (cmd === "get_insights_note") return { space_id: "website-demo", updated_at: 1,
        content: "# 给今天留一点记录\n\n## 关于行动\n\n不必等所有条件都准备好。先把事情拆成一个看得见的下一步，再给它一个时间段。\n\n> 把注意力放在正在推进的事情上。\n\n## 与 AI 一起工作\n\n我负责判断和取舍，AI 帮我整理资料。结果需要回看，想法也值得留下。\n\n- 今天解决了什么？\n- 哪个判断需要再验证？\n- 明天最值得推进的一步是什么？" };
      if (cmd === "plugin:event|listen") return 1;
      return null;
    },
  };
});
const base = process.env.UI_TEST_URL || "http://127.0.0.1:1420";
const settle = async () => {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.locator("button:focus").evaluateAll(buttons => buttons.forEach(button => button.blur()));
  if (await page.getByRole("tooltip").count()) await page.getByRole("tooltip").waitFor({ state: "hidden" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${base}/#/daily-list`);
  await page.locator(".daily-ai-task").first().waitFor();
  await page.locator(".daily-statistics-table").waitFor();
  await page.getByRole("region", { name: "当日事项", exact: true }).waitFor();
  await page.locator(".daily-pool-trigger").click();
  await page.getByText("行动完成 2/7", { exact: true }).waitFor();
  await settle();
  await page.screenshot({ path: path.join(output, "today.png") });
  await page.locator(".daily-schedule-card").screenshot({ path: path.join(output, "timeline.png") });
  await page.locator(".daily-schedule-row").filter({ has: page.locator(".daily-ai-task") }).screenshot({ path: path.join(output, "parallel.png") });
  await page.getByRole("button", { name: "收起今日事件池", exact: true }).click();
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.getByRole("region", { name: "数据统计", exact: true }).screenshot({ path: path.join(output, "statistics.png") });
  await page.goto(`${base}/#/inbox`);
  await page.locator(".event-card").first().waitFor();
  for (const button of await page.locator(".event-action-summary").all()) await button.click();
  await page.locator(".main-content").evaluate(el => { el.scrollTop = 0; });
  await settle();
  await page.screenshot({ path: path.join(output, "inbox.png") });
  await page.goto(`${base}/#/insights`);
  await page.locator(".md-wysiwyg").waitFor();
  await settle();
  await page.screenshot({ path: path.join(output, "insights.png") });
  await page.goto(`${base}/#/weekly-summary`);
  await page.setViewportSize({ width: 1360, height: 1200 });
  await page.getByLabel("本周已安排 4 小时 30 分钟", { exact: true }).waitFor();
  await page.getByRole("region", { name: "本周事项", exact: true }).waitFor();
  await page.locator(".main-content").evaluate(el => { el.scrollTop = 0; });
  await settle();
  await page.screenshot({ path: path.join(output, "weekly.png") });
  assert.deepEqual(errors, []);
  console.log(`Captured product screenshots with fictional data: ${output}`);
} finally {
  await browser.close();
}
