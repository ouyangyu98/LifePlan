import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, summarizeDailyReview, summarizeDailySchedule } from "../../src/lib/dailyStatistics.ts";

const slot = (start, end, action) => ({ start_time: start, end_time: end, action });
const events = [
  { id: 1, category_id: 10, category_name: "工作", category_color: "#1677ff" },
  { id: 2, category_id: 20, category_name: "成长", category_color: "#389e0d" },
  { id: 3, category_id: 10, category_name: "工作", category_color: "#1677ff" },
];

test("efficiency uses reviewed duration, with coverage separating unreviewed time", () => {
  const action = { id: 1 };
  const review = summarizeDailyReview([
    { ...slot("09:00", "10:00", action), actual_notes: "done", focused: 1, met_expectation: 1 },
    { ...slot("10:00", "10:30", action), actual_notes: "interrupted", focused: 0, met_expectation: 1 },
    { ...slot("10:30", "11:00", action), actual_notes: "partial", focused: 1, met_expectation: 0 },
    slot("11:00", "13:00", action),
    { ...slot("13:00", "14:00"), actual_notes: "stale", focused: 1, met_expectation: 1 },
  ]);
  assert.deepEqual(review, { plannedMinutes: 240, reviewedMinutes: 120, efficientMinutes: 60, efficientPercentage: 50, reviewCoverage: 50 });
  assert.equal(summarizeDailyReview([]).efficientPercentage, null);
  assert.equal(summarizeDailyReview([slot("09:00", "10:00", action)]).reviewCoverage, 0);
  assert.equal(summarizeDailyReview([{ ...slot("09:00", "10:00", action), focused: 1, met_expectation: 1, actual_notes: " " }]).reviewedMinutes, 0);
});

test("uses occupied slot duration, not estimates or action completion; repeats count each slot once", () => {
  const action = { id: 1, event_id: 1, estimated_hours: 99, status: 1 };
  const slots = [
    slot("09:00", "10:00", action),
    slot("10:00", "10:30", action),
    slot("10:30", "11:00", { id: 2, event_id: 3, status: 2 }),
    slot("11:00", "12:00", { id: 3, event_id: 2 }),
    slot("12:00", "13:00", { id: 4 }),
    slot("13:00", "16:00"),
  ];
  const before = structuredClone(slots);
  const stats = summarizeDailySchedule(slots, events);
  assert.equal(stats.totalMinutes, 240);
  assert.deepEqual(stats.categories.map(({ id, minutes, percentage }) => ({ id, minutes, percentage })), [
    { id: 10, minutes: 120, percentage: 50 },
    { id: 20, minutes: 60, percentage: 25 },
    { id: null, minutes: 60, percentage: 25 },
  ]);
  assert.deepEqual(slots, before);
});

test("empty, deleted actions and malformed ranges do not inflate totals", () => {
  assert.deepEqual(summarizeDailySchedule([], []), { totalMinutes: 0, categories: [] });
  const action = { id: 1 };
  const invalid = [
    slot("09:00", "09:00", action), slot("10:00", "09:00", action),
    slot("23:00", "01:00", action), slot("25:00", "26:00", action),
    slot("09:99", "11:00", action), slot("bad", "11:00", action),
    { ...slot("09:00", "11:00"), action_id: 99 },
  ];
  assert.equal(summarizeDailySchedule(invalid, []).totalMinutes, 0);
  assert.equal(summarizeDailySchedule([slot("23:30", "24:00", action)], []).totalMinutes, 30);
});

test("standalone, missing event and uncategorized event actions share the unclassified group", () => {
  const stats = summarizeDailySchedule([
    slot("09:00", "09:30", { id: 1 }),
    slot("09:30", "10:00", { id: 2, event_id: 99 }),
    slot("10:00", "10:30", { id: 3, event_id: 1 }),
  ], [{ id: 1 }]);
  assert.deepEqual(stats.categories, [{ id: null, name: "未分类", color: "#8c98a5", minutes: 90, percentage: 100 }]);
});

test("uses current category names and membership, groups by id rather than name", () => {
  const slots = [slot("09:00", "10:00", { id: 1, event_id: 1 }), slot("10:00", "11:00", { id: 2, event_id: 2 })];
  const renamed = events.map((event) => ({ ...event, category_name: "同名分类" }));
  assert.equal(summarizeDailySchedule(slots, renamed).categories.length, 2);
  const changed = [{ ...events[0], category_id: 20, category_name: "成长", category_color: "#389e0d" }, events[1]];
  assert.deepEqual(summarizeDailySchedule(slots, changed).categories, [
    { id: 20, name: "成长", color: "#389e0d", minutes: 120, percentage: 100 },
  ]);
});

test("rounded percentages total 100 percent with stable ties", () => {
  const stats = summarizeDailySchedule([
    slot("09:00", "09:01", { event_id: 1 }),
    slot("09:01", "09:02", { event_id: 2 }),
    slot("09:02", "09:03", {}),
  ], events);
  assert.deepEqual(stats.categories.map((category) => category.percentage), [33.4, 33.3, 33.3]);
  assert.equal(stats.categories.reduce((total, category) => total + Math.round(category.percentage * 10), 0), 1000);
});

test("duration labels retain minutes and handle zero and full hours", () => {
  assert.equal(formatDuration(0), "0 分钟");
  assert.equal(formatDuration(30), "30 分钟");
  assert.equal(formatDuration(60), "1 小时");
  assert.equal(formatDuration(135), "2 小时 15 分钟");
});
