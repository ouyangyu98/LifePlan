import type { DailyScheduleSlot } from "../types/index";

export function isDailyReviewComplete(slot: DailyScheduleSlot): boolean {
  return Boolean(slot.actual_notes?.trim())
    && [0, 1].includes(slot.focused as number);
}

export function dailyReviewDetails(slots: readonly DailyScheduleSlot[], includeExpectation: boolean): string {
  return slots.map((slot, index) => {
    const expectation = includeExpectation
      ? `｜完成预期：${slot.met_expectation == null ? "未填写" : slot.met_expectation === 1 ? "达到预期" : "未达预期"}`
      : "";
    const flow = slot.focused == null ? "未填写" : slot.focused === 1 ? "心流" : "未进入心流";
    return `${index + 1}. ${slot.start_time}-${slot.end_time}｜行动：${slot.action?.title || "未安排行动"}${expectation}｜心流状态：${flow}｜复盘：${slot.actual_notes || "未填写"}`;
  }).join("\n");
}
