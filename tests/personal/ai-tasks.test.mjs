import assert from "node:assert/strict";
import { test } from "node:test";
import { aiTaskAnchorSlots, aiTaskMinutes, dailyAiSummary } from "../../src/lib/aiTasks.ts";
import { summarizeDailySchedule } from "../../src/lib/dailyStatistics.ts";

test("AI durations count once per task and never inflate human time", () => {
  const slots = [
    { id: 1, action: { id: 10 }, start_time: "09:00", end_time: "10:00" },
    { id: 2, action: { id: 10 }, start_time: "10:00", end_time: "11:00" },
    { id: 3, start_time: "11:00", end_time: "12:00" },
  ];
  const tasks = [
    { id: 1, action_id: 10, start_time: "09:00", end_time: "11:30", status: "running" },
    { id: 2, action_id: 10, start_time: null, end_time: null, status: "ready" },
    { id: 3, action_id: 11, start_time: "09:00", end_time: "10:00", status: "running" },
  ];
  assert.deepEqual(dailyAiSummary(tasks, slots), { count: 2, minutes: 150, untimed: 1, running: 1, ready: 1 });
  assert.equal(summarizeDailySchedule(slots, []).totalMinutes, 120);
  assert.deepEqual(dailyAiSummary([], slots), { count: 0, minutes: 0, untimed: 0, running: 0, ready: 0 });
});

test("only the first occurrence expands and the anchor follows reordering", () => {
  const slots = [{ id: 1, action: { id: 10 } }, { id: 2, action: { id: 10 } }, { id: 3, action: { id: 20 } }, { id: 4 }];
  assert.deepEqual([...aiTaskAnchorSlots(slots)], [[10, 1], [20, 3]]);
  assert.deepEqual([...aiTaskAnchorSlots([slots[2], slots[1], slots[0]])], [[20, 3], [10, 2]]);
});

test("optional times, invalid ranges and midnight end produce finite durations", () => {
  assert.equal(aiTaskMinutes({ start_time: null, end_time: null }), 0);
  assert.equal(aiTaskMinutes({ start_time: "23:30", end_time: "24:00" }), 30);
  assert.equal(aiTaskMinutes({ start_time: "23:30", end_time: "00:30" }), 0);
  assert.equal(aiTaskMinutes({ start_time: "bad", end_time: "24:00" }), 0);
});
