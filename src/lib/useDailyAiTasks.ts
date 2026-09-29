import { useEffect, useState } from "react";
import { aiTasksApi } from "@/lib/api";
import { userFacingError } from "@/lib/errors";
import type { AiTask, DailyScheduleSlot } from "@/types";

export function useDailyAiTasks(date: string, enabled = true) {
  const [state, setState] = useState<{ date: string; tasks: AiTask[]; loading: boolean; error: string }>({
    date, tasks: [], loading: true, error: "",
  });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setState({ date, tasks: [], loading: false, error: "" });
      return;
    }
    let active = true;
    setState({ date, tasks: [], loading: true, error: "" });
    aiTasksApi.list(date).then((tasks) => {
      if (active) setState({ date, tasks, loading: false, error: "" });
    }).catch((cause) => {
      if (active) setState({ date, tasks: [], loading: false, error: userFacingError(cause) });
    });
    return () => { active = false; };
  }, [date, version, enabled]);
  const upsert = (task: AiTask) => setState((current) => current.date !== task.list_date ? current : {
    ...current, tasks: current.tasks.some((item) => item.id === task.id)
      ? current.tasks.map((item) => item.id === task.id ? task : item)
      : [...current.tasks, task],
  });
  const remove = (task: AiTask) => setState((current) => current.date !== task.list_date ? current : {
    ...current, tasks: current.tasks.filter((item) => item.id !== task.id),
  });
  const moveWithSlots = (source: DailyScheduleSlot, target: DailyScheduleSlot) => {
    setState(current => current.date !== source.list_date ? current : {
      ...current, loading: true, tasks: current.tasks.map(task => {
        if (task.slot_id === source.id && task.action_id === source.action?.id) return { ...task, slot_id: target.id };
        if (task.slot_id === target.id && task.action_id === target.action?.id) return { ...task, slot_id: source.id };
        return task;
      }),
    });
    setVersion(current => current + 1);
  };
  return {
    tasks: enabled && state.date === date ? state.tasks : [],
    loading: enabled && (state.date !== date || state.loading),
    error: enabled && state.date === date ? state.error : "",
    retry: () => setVersion((current) => current + 1), upsert, remove, moveWithSlots,
  };
}
