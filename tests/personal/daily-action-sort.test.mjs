import assert from "node:assert/strict";
import { test } from "node:test";
import { sortDailyActions } from "../../src/lib/dailyActionSort.ts";

test("legacy priority and frog flags do not reorder actions", () => {
  const actions = [
    { id: 1, priority: 4, is_frog: 0 },
    { id: 2, priority: 1, is_frog: 1 },
    { id: 3, priority: 2, is_frog: 0 },
  ];
  assert.deepEqual(sortDailyActions(actions).map(({ id }) => id), [1, 2, 3]);
  assert.deepEqual(actions.map(({ id }) => id), [1, 2, 3]);
});

test("start dates retain chronological ordering with stable ties", () => {
  const actions = [
    { id: 1, start_date: null, priority: 1 },
    { id: 2, start_date: "2026-09-29", priority: 1 },
    { id: 3, start_date: "2026-09-28", priority: 4 },
    { id: 4, start_date: "2026-09-28", priority: 1 },
  ];
  assert.deepEqual(sortDailyActions(actions).map(({ id }) => id), [3, 4, 2, 1]);
});
