import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { suggestedEndTime } from "../../src/lib/dailyScheduleTime.ts";

test("new slots default to one hour later and never wrap into the next day", () => {
  for (const [start, end] of [["00:00", "01:00"], ["09:30", "10:30"], ["22:30", "23:30"], ["23:00", "24:00"], ["23:30", "24:00"]]) {
    assert.equal(suggestedEndTime(start), end);
  }
});

test("desktop configurations allow in-page dragging and use native Mac window chrome", () => {
  const base = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url)));
  const mac = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.macos.conf.json", import.meta.url)));
  assert.equal(base.app.windows[0].dragDropEnabled, false);
  assert.equal(base.app.windows[0].shadow, true);
  assert.equal(mac.app.windows[0].dragDropEnabled, false);
  assert.equal(mac.app.windows[0].decorations, true);
  assert.equal(mac.app.windows[0].titleBarStyle, "Overlay");
  for (const key of ["width", "height", "minWidth", "minHeight", "resizable"]) {
    assert.equal(mac.app.windows[0][key], base.app.windows[0][key]);
  }
});
