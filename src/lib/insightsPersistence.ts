import { insightsApi } from "@/lib/api";

// Keep writes ordered even when the editor unmounts and mounts again.
let writes: Promise<unknown> = Promise.resolve();
export const loadInsights = async () => {
  await writes;
  return insightsApi.get();
};
export const saveInsights = (content: string, spaceId: string) => {
  const write = writes.then(() => insightsApi.save(content, spaceId));
  writes = write.catch(() => undefined);
  return write;
};
