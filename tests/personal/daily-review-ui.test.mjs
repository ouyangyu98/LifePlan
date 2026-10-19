import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const baseUrl = process.env.UI_TEST_URL || "http://127.0.0.1:1420";
const screenshots = process.env.UI_SCREENSHOT_DIR;

test("optional expectation hides everywhere, preserves history and does not affect flow statistics", { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("lifeplan-onboarding-v1-completed", "1");
    if (!localStorage.getItem("lifeplan-optional-features-v1")) {
      localStorage.setItem("lifeplan-optional-features-v1", JSON.stringify({ dailyStatistics: true, aiParallel: false }));
    }
    localStorage.setItem("lifeplan-ai-api-key", "ui-test-only");
    const action = { id: 1, title: "测试行动", status: 0, estimated_hours: 1 };
    const initial = [
      { id: 1, start_time: "09:00", end_time: "10:00", action_id: 1, action, actual_notes: "原有复盘", met_expectation: 0, focused: 1 },
      { id: 2, start_time: "10:00", end_time: "11:00", action_id: 1, action },
    ];
    const slots = JSON.parse(sessionStorage.getItem("review-fixture") || JSON.stringify(initial));
    window.reviewFixture = { slots, payloads: [] };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (cmd, args = {}) => {
        if (cmd === "get_daily_schedule") {
          for (const slot of slots) slot.list_date = args.listDate;
          return { list_date: args.listDate, slots: structuredClone(slots) };
        }
        if (cmd === "get_actions") return [action];
        if (["get_events", "get_ai_tasks", "get_recurring_actions", "get_daily_used_dates"].includes(cmd)) return [];
        if (cmd === "update_daily_slot_review") {
          window.reviewFixture.payloads.push(args.payload);
          const slot = slots.find((item) => item.id === args.payload.id);
          Object.assign(slot, args.payload);
          sessionStorage.setItem("review-fixture", JSON.stringify(slots));
          return structuredClone(slot);
        }
        if (cmd === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  const daily = () => page.locator(".sidebar").getByRole("link", { name: "今日事", exact: true }).click();
  const settings = async () => {
    await page.locator(".sidebar").getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("heading", { name: "可选功能", exact: true }).waitFor();
  };
  const cells = page.locator(".daily-review-cell");
  const dialog = page.getByRole("dialog");
  const metric = page.locator(".daily-review-metric").first();
  const shot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true, animations: "disabled" });
  };
  try {
    await page.goto(`${baseUrl}/#/daily-list`);
    await cells.first().getByText("未达预期", { exact: true }).waitFor();
    await metric.getByText("100%", { exact: true }).waitFor();
    await metric.getByText("心流时段占比", { exact: true }).waitFor();
    await cells.first().click();
    await dialog.getByText("是否心流", { exact: true }).waitFor();
    assert.equal(await dialog.getByText("是否专注", { exact: true }).count(), 0);
    await dialog.locator(".ant-modal-close").click();

    await settings();
    assert.equal(await page.locator("#feature-reviewExpectation").getAttribute("aria-checked"), "true");
    await page.locator("#feature-reviewExpectation").click();
    await page.reload();
    await page.getByRole("heading", { name: "可选功能", exact: true }).waitFor();
    assert.equal(await page.locator("#feature-reviewExpectation").getAttribute("aria-checked"), "false");
    await daily();
    await cells.first().getByText("原有复盘", { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("main").innerText(), /达到预期|未达预期|是否专注|高效时段/);
    await cells.first().click();
    assert.equal(await dialog.getByText("是否达到预期", { exact: true }).count(), 0);
    await dialog.getByLabel("实际工作情况", { exact: true }).fill("关闭开关后修改复盘");
    assert.equal(await dialog.locator(".form-grid").count(), 0);
    await shot("review-flow-desktop.png");
    await dialog.getByRole("button", { name: "保存复盘", exact: true }).click();
    await cells.first().getByText("关闭开关后修改复盘", { exact: true }).waitFor();
    const saved = await page.evaluate(() => ({ payload: window.reviewFixture.payloads.at(-1), rating: window.reviewFixture.slots[0].met_expectation }));
    assert.equal(Object.hasOwn(saved.payload, "met_expectation"), false);
    assert.equal(saved.rating, 0);

    await cells.nth(1).click();
    await dialog.getByLabel("实际工作情况", { exact: true }).fill("未填预期的新复盘");
    await dialog.locator(".ant-select").click();
    await page.locator(".ant-select-dropdown:visible").getByText("未进入心流", { exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").waitFor({ state: "hidden" });
    await dialog.getByRole("button", { name: "保存复盘", exact: true }).click();
    await cells.nth(1).getByText("未进入心流", { exact: true }).waitFor();
    await metric.getByText("50%", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Object.hasOwn(window.reviewFixture.slots[1], "met_expectation")), false);
    await page.getByRole("button", { name: "工作日志", exact: true }).click();
    await dialog.getByText(/已填写 2\/2 个时段复盘/).waitFor();
    assert.doesNotMatch(await dialog.innerText(), /达到预期|未达预期/);
    await dialog.locator(".ant-modal-close").click();

    await settings();
    await page.locator("#feature-reviewExpectation").click();
    await daily();
    await cells.first().getByText("未达预期", { exact: true }).waitFor();
    await cells.nth(1).getByText("未填预期的新复盘", { exact: true }).waitFor();
    assert.doesNotMatch((await cells.nth(1).locator(".ant-tag").allTextContents()).join(" "), /预期/);
    await cells.nth(1).click();
    await dialog.getByText("是否达到预期", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "保存复盘", exact: true }).click();
    await dialog.getByText("请选择是否达到预期", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('button[aria-label="保存复盘"]')?.getAttribute("aria-busy") === "false");
    await dialog.locator(".ant-select").first().click();
    await page.locator(".ant-select-dropdown:visible").getByText("达到预期", { exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").waitFor({ state: "hidden" });
    await dialog.getByRole("button", { name: "保存复盘", exact: true }).click();
    await cells.nth(1).getByText("达到预期", { exact: true }).waitFor();
    await metric.getByText("50%", { exact: true }).waitFor();

    await settings();
    await page.locator("#feature-reviewExpectation").click();
    await daily();
    await cells.nth(1).getByText("未进入心流", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await cells.nth(1).click();
    await dialog.getByText("是否心流", { exact: true }).waitFor();
    await shot("review-flow-mobile.png");
    assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    assert.deepEqual(errors, []);
  } catch (error) {
    await shot("review-flow-failure.png");
    throw error;
  } finally {
    await browser.close();
  }
});
