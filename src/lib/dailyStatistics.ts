import type { DailyScheduleSlot, Event } from "../types/index";

export interface CategoryDuration {
  id: number | null;
  name: string;
  color: string;
  minutes: number;
  percentage: number;
}

const timeMinutes = (value: string) => {
  if (value === "24:00") return 1440;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours} 小时${remainder ? ` ${remainder} 分钟` : ""}` : `${remainder} 分钟`;
}

export function summarizeDailyReview(slots: readonly DailyScheduleSlot[]) {
  let plannedMinutes = 0;
  let reviewedMinutes = 0;
  let efficientMinutes = 0;
  for (const slot of slots) {
    if (!slot.action) continue;
    const minutes = timeMinutes(slot.end_time) - timeMinutes(slot.start_time);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    plannedMinutes += minutes;
    if (!slot.actual_notes?.trim()
      || ![0, 1].includes(slot.met_expectation as number)
      || ![0, 1].includes(slot.focused as number)) continue;
    reviewedMinutes += minutes;
    if (slot.met_expectation === 1 && slot.focused === 1) efficientMinutes += minutes;
  }
  const share = (part: number, total: number) => total ? Math.round(part / total * 1000) / 10 : null;
  return {
    plannedMinutes, reviewedMinutes, efficientMinutes,
    efficientPercentage: share(efficientMinutes, reviewedMinutes),
    reviewCoverage: share(reviewedMinutes, plannedMinutes),
  };
}

export function summarizeDailySchedule(
  slots: readonly DailyScheduleSlot[],
  events: readonly Event[],
): { totalMinutes: number; categories: CategoryDuration[] } {
  const eventMap = new Map(events.map((event) => [event.id, event]));
  const groups = new Map<number | null, CategoryDuration>();
  let totalMinutes = 0;
  for (const slot of slots) {
    if (!slot.action) continue;
    const minutes = timeMinutes(slot.end_time) - timeMinutes(slot.start_time);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const event = slot.action.event_id == null ? undefined : eventMap.get(slot.action.event_id);
    const categoryId = event?.category_id ?? null;
    const category = groups.get(categoryId) ?? {
      id: categoryId,
      name: categoryId === null ? "未分类" : event?.category_name || "未命名分类",
      color: categoryId === null ? "#8c98a5" : event?.category_color || "#1677ff",
      minutes: 0,
      percentage: 0,
    };
    category.minutes += minutes;
    groups.set(categoryId, category);
    totalMinutes += minutes;
  }
  const categories = [...groups.values()].sort((a, b) => b.minutes - a.minutes || (a.id ?? Infinity) - (b.id ?? Infinity));
  // Allocate tenths of a percent so displayed shares add up to exactly 100%.
  const shares = categories.map((category) => category.minutes * 1000 / totalMinutes);
  const tenths = shares.map(Math.floor);
  const remainder = 1000 - tenths.reduce((sum, share) => sum + share, 0);
  const order = shares.map((share, index) => ({ index, fraction: share - tenths[index] }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const { index } of order.slice(0, remainder)) tenths[index] += 1;
  categories.forEach((category, index) => { category.percentage = tenths[index] / 10; });
  return { totalMinutes, categories };
}
