import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1422";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("optional features persist, hide every entry and preserve records", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    const action = { id: 1, title: "保留的行动", status: 0, estimated_hours: 1 };
    window.emptySchedule = false;
    window.activeTimer = false;
    window.commands = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        window.commands.push(cmd);
        if (cmd === "get_actions") return [action];
        if (cmd === "get_events") return [];
        if (cmd === "get_daily_schedule") return {
          list_date: args.listDate,
          slots: window.emptySchedule ? [] : [{
            id: 1, list_date: args.listDate, start_time: "09:00", end_time: "10:00",
            action_id: 1, action, sort_order: 0,
          }],
        };
        if (cmd === "get_daily_used_dates" || cmd === "get_pomodoro_records" || cmd === "get_recurring_actions") return [];
        if (cmd === "get_pomodoro_status") return { total_points: 42, active: window.activeTimer ? { id: 1 } : undefined };
        if (cmd === "get_insights_note") return { space_id: "test", content: "保留的心得", updated_at: 1 };
        if (cmd === "get_rewards_overview") return {
          total_points: 42, rewards: [{ id: 1, name: "保留的奖励", points_required: 5, status: 0, category: "其他", icon: "Gift" }], exchanges: [],
        };
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const link = (name) => page.locator(".sidebar").getByRole("link", { name, exact: true });
  const goSettings = () => link("设置").click();
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true });
  };
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await page.getByRole("button", { name: "工作日志", exact: true }).waitFor();
    await page.getByRole("button", { name: "保存模板", exact: true }).waitFor();
    for (const name of ["番茄钟", "奖励池", "心得"]) assert.equal(await link(name).count(), 1);
    await page.getByRole("button", { name: "保留的行动", exact: true }).click();
    await page.getByRole("button", { name: "开始番茄钟", exact: true }).waitFor();
    await page.getByRole("dialog").locator(".ant-modal-close").click();

    await goSettings();
    assert.equal(await page.getByRole("switch").count(), 6);
    await page.waitForFunction(() => document.querySelectorAll(".sidebar .ant-menu-item-selected").length === 1);
    assert.equal(await page.locator(".sidebar .ant-menu-item-selected").innerText(), "设置");
    await shot("settings-desktop.png");
    await page.evaluate(() => { window.activeTimer = true; });
    await page.getByRole("switch", { name: "番茄钟" }).click();
    await page.getByText("番茄钟正在计时，请先完成或结束本次专注", { exact: true }).waitFor();
    assert.equal(await page.getByRole("switch", { name: "番茄钟" }).getAttribute("aria-checked"), "true");
    await page.evaluate(() => { window.activeTimer = false; });
    for (const name of ["工作日志", "日程模板", "奖励池", "番茄钟", "心得", "数据统计"]) {
      await page.getByRole("switch", { name, exact: true }).click();
      await page.waitForFunction((label) => document.querySelector(`[role="switch"][aria-label="${label}"]`)?.getAttribute("aria-checked") === "false", name);
    }
    await page.reload();
    await page.getByRole("heading", { name: "可选功能" }).waitFor();
    assert.equal(await page.locator('[role="switch"][aria-checked="false"]').count(), 6);
    for (const name of ["番茄钟", "奖励池", "心得"]) assert.equal(await link(name).count(), 0);
    await link("今日事").click();
    await page.getByRole("button", { name: "保留的行动", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /工作日志|保存模板|保存空模板/ }).count(), 0);
    assert.equal(await page.getByRole("region", { name: "数据统计" }).count(), 0);
    assert.equal(await page.evaluate(() => window.commands.includes("get_events")), false);
    await page.getByRole("button", { name: "保留的行动", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("button", { name: "开始番茄钟", exact: true }).count(), 0);
    await page.getByRole("dialog").locator(".ant-modal-close").click();
    for (const route of ["insights", "pomodoro", "rewards"]) {
      await page.evaluate((route) => { window.location.hash = `#/${route}`; }, route);
      await page.waitForURL("**/#/daily-list");
    }
    assert.equal(await page.evaluate(() => window.commands.some((cmd) => ["get_insights_note", "get_rewards_overview", "get_pomodoro_status"].includes(cmd))), false);

    await goSettings();
    await page.evaluate(() => { window.emptySchedule = true; });
    await link("今日事").click();
    await page.getByRole("heading", { name: "今天还没有安排行动" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "保存空模板", exact: true }).count(), 0);
    await goSettings();
    await page.getByRole("switch", { name: "日程模板" }).click();
    await link("今日事").click();
    await page.getByRole("button", { name: "保存空模板", exact: true }).waitFor();

    await goSettings();
    for (const name of ["工作日志", "奖励池", "番茄钟", "心得", "数据统计"]) await page.getByRole("switch", { name, exact: true }).click();
    await page.evaluate(() => { window.emptySchedule = false; });
    await link("今日事").click();
    await page.getByRole("button", { name: "工作日志", exact: true }).waitFor();
    await page.getByLabel("已安排总时长 1 小时", { exact: true }).waitFor();
    await link("心得").click();
    await page.waitForFunction(() => document.querySelector(".md-wysiwyg")?.textContent === "保留的心得");
    await link("奖励池").click();
    await page.getByText("保留的奖励", { exact: true }).waitFor();

    await goSettings();
    await page.getByRole("switch", { name: "奖励池" }).click();
    await link("番茄钟").click();
    await page.getByRole("button", { name: "开始专注", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "查看积分汇总" }).count(), 0);
    assert.equal(await page.getByText(/可获得 1 积分/).count(), 0);

    await goSettings();
    await page.evaluate(() => {
      window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "lifeplan-optional-features-v1") throw Error("Storage unavailable");
        return window.originalSetItem.call(this, key, value);
      };
    });
    await page.getByRole("switch", { name: "心得" }).click();
    await page.getByText("设置未保存，请稍后重试", { exact: true }).waitFor();
    assert.equal(await page.getByRole("switch", { name: "心得" }).getAttribute("aria-checked"), "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("settings-mobile.png");
    assert.equal(await page.locator(".feature-settings").evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    assert.deepEqual(errors, []);
  } catch (error) {
    await shot("settings-failure.png");
    throw error;
  } finally {
    await browser.close();
  }
});
