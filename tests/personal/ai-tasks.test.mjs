import assert from "node:assert/strict";
import { test } from "node:test";
import { aiTasksBySlot, aiTaskMinutes, dailyAiSummary } from "../../src/lib/aiTasks.ts";
import { summarizeDailySchedule } from "../../src/lib/dailyStatistics.ts";

test("AI durations count once per task and never inflate human time", () => {
  const slots = [
    { id: 1, action: { id: 10 }, start_time: "09:00", end_time: "10:00" },
    { id: 2, action: { id: 10 }, start_time: "10:00", end_time: "11:00" },
    { id: 3, start_time: "11:00", end_time: "12:00" },
  ];
  const tasks = [
    { id: 1, slot_id: 1, action_id: 10, start_time: "09:00", end_time: "11:30", status: "running" },
    { id: 2, slot_id: 2, action_id: 10, start_time: null, end_time: null, status: "ready" },
    { id: 3, slot_id: 3, action_id: 11, start_time: "09:00", end_time: "10:00", status: "running" },
    { id: 4, slot_id: null, action_id: 10, start_time: "09:00", end_time: "10:00", status: "running" },
  ];
  assert.deepEqual(dailyAiSummary(tasks, slots), { count: 2, minutes: 150, untimed: 1 });
  assert.equal(summarizeDailySchedule(slots, []).totalMinutes, 120);
  assert.deepEqual(dailyAiSummary([], slots), { count: 0, minutes: 0, untimed: 0 });
});

test("afternoon attachments stay on the selected occurrence even when times change or are unset", () => {
  const slots = [
    { id: 1, action: { id: 10 }, list_date: "2026-09-29", start_time: "11:00", end_time: "12:00" },
    { id: 2, action: { id: 10 }, list_date: "2026-09-29", start_time: "13:30", end_time: "14:30" },
  ];
  const task = { id: 1, slot_id: 2, action_id: 10, list_date: "2026-09-29", start_time: "13:30", end_time: "14:30" };
  assert.deepEqual([...aiTasksBySlot([task], slots)], [[2, [task]]]);
  assert.deepEqual([...aiTasksBySlot([task], [...slots].reverse())], [[2, [task]]]);
  for (const time of ["11:00", null]) {
    const edited = { ...task, start_time: time, end_time: time ? "12:00" : null };
    assert.deepEqual([...aiTasksBySlot([edited], slots)], [[2, [edited]]]);
  }
  assert.equal(aiTasksBySlot([task], [slots[0]]).size, 0);
  assert.equal(aiTasksBySlot([task], [slots[0], { ...slots[1], action: { id: 20 } }]).size, 0);
  assert.equal(aiTasksBySlot([{ ...task, list_date: "2026-09-28" }], slots).size, 0);
  assert.equal(aiTasksBySlot([{ ...task, slot_id: null }], slots).size, 0);
});

test("moving one repeated occurrence only moves its own attachments", () => {
  const morning = { id: 1, slot_id: 1, action_id: 10 };
  const afternoon = { id: 2, slot_id: 2, action_id: 10 };
  const slots = [{ id: 1, action: { id: 20 } }, { id: 2, action: { id: 10 } }, { id: 3, action: { id: 10 } }];
  const moved = { ...morning, slot_id: 3 };
  assert.deepEqual([...aiTasksBySlot([moved, afternoon], slots)], [[3, [moved]], [2, [afternoon]]]);
});

test("optional times, invalid ranges and midnight end produce finite durations", () => {
  assert.equal(aiTaskMinutes({ start_time: null, end_time: null }), 0);
  assert.equal(aiTaskMinutes({ start_time: "23:30", end_time: "24:00" }), 30);
  assert.equal(aiTaskMinutes({ start_time: "23:30", end_time: "00:30" }), 0);
  assert.equal(aiTaskMinutes({ start_time: "bad", end_time: "24:00" }), 0);
});
