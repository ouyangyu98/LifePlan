import { useEffect, useState } from "react";
import { Alert, Button, Skeleton } from "antd";
import { weeklySummaryApi } from "@/lib/api";
import { userFacingError } from "@/lib/errors";
import WeeklyItems from "@/components/WeeklyItems";
import type { AiTask, DailyScheduleSlot, WeeklyAction } from "@/types";

export default function DailyActivityItems({ date, slots, aiTasks }: {
  date: string; slots: DailyScheduleSlot[]; aiTasks: AiTask[];
}) {
  const [state, setState] = useState<{ date: string; items: WeeklyAction[]; loading: boolean; error: string }>({
    date, items: [], loading: true, error: "",
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ date, items: [], loading: true, error: "" });
    weeklySummaryApi.dailyItems(date).then((items) => {
      if (!Array.isArray(items)) throw Error("当日事项读取失败，请重试");
      if (active) setState({ date, items, loading: false, error: "" });
    }).catch((cause) => {
      if (active) setState({ date, items: [], loading: false, error: userFacingError(cause) });
    });
    return () => { active = false; };
  }, [date, slots, aiTasks, retry]);
  if (state.date !== date || state.loading) {
    return <div className="daily-activity-loading" aria-label="正在读取当日事项"><Skeleton active title={false} paragraph={{ rows: 3 }} /></div>;
  }
  if (state.error) {
    return <Alert className="page-alert" type="warning" showIcon message={state.error}
      action={<Button size="small" onClick={() => setRetry((value) => value + 1)}>重试</Button>} />;
  }
  return <WeeklyItems key={date} period="day" items={state.items} />;
}
