import { weeklySummaryApi } from "@/lib/api";

// 周笔记切换周次时也必须保持写入顺序，避免较早的自动保存覆盖较新的内容。
let writes: Promise<unknown> = Promise.resolve();

export const loadWeeklySummary = async (weekStart: string) => {
  await writes;
  return weeklySummaryApi.get(weekStart);
};

export const saveWeeklySummary = (weekStart: string, content: string, spaceId: string) => {
  const write = writes.then(() => weeklySummaryApi.save(weekStart, content, spaceId));
  writes = write.catch(() => undefined);
  return write;
};

export const loadWeeklyRecords = async (beforeWeekStart?: string) => {
  await writes;
  return weeklySummaryApi.list(beforeWeekStart);
};
