use crate::db::{current_space_id, now_millis};
use crate::models::{AiTask, AiTaskFields, AiTaskStatus, NewAiTask, UpdateAiTask};
use crate::AppState;
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

fn validate_date(date: &str) -> Result<(), String> {
    if date.len() != 10 || NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return Err("日期格式无效".into());
    }
    Ok(())
}

fn time_minutes(value: &str, allow_day_end: bool) -> Option<u32> {
    if allow_day_end && value == "24:00" { return Some(1440); }
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' ||
        ![bytes[0], bytes[1], bytes[3], bytes[4]].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let hour = value[..2].parse::<u32>().ok()?;
    let minute = value[3..].parse::<u32>().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

fn validate_fields(fields: &AiTaskFields) -> Result<(), String> {
    if fields.result.chars().count() > 20000 {
        return Err("结果内容过长".into());
    }
    match (&fields.start_time, &fields.end_time) {
        (None, None) => {},
        (Some(start), Some(end)) => {
            let start = time_minutes(start, false).ok_or("开始时间格式无效")?;
            let end = time_minutes(end, true).ok_or("结束时间格式无效")?;
            if start >= end { return Err("结束时间必须晚于开始时间，且不能跨天".into()); }
        },
        _ => return Err("请同时填写开始和结束时间，或同时留空".into()),
    }
    Ok(())
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiTask> {
    let status: String = row.get(4)?;
    let status = match status.as_str() {
        "queued" => AiTaskStatus::Queued, "running" => AiTaskStatus::Running,
        "paused" => AiTaskStatus::Paused, "ready" => AiTaskStatus::Ready,
        "completed" => AiTaskStatus::Completed, "failed" => AiTaskStatus::Failed,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(AiTask {
        id: row.get(0)?, action_id: row.get(1)?, list_date: row.get(2)?, title: row.get(3)?,
        status, start_time: row.get(5)?, end_time: row.get(6)?, notes: row.get(7)?,
        result: row.get(8)?, created_at: row.get(9)?, updated_at: row.get(10)?,
        linked_action_id: row.get(11)?, event_title: row.get(12)?, read_only: row.get(13)?,
        slot_id: row.get(14)?,
    })
}

const SELECT_TASK: &str =
    "SELECT t.id,t.action_id,t.list_date,linked.title,
            CASE WHEN linked.status=1 THEN 'completed'
                 WHEN linked.status=2 THEN 'paused'
                 WHEN t.status='completed' THEN 'queued' ELSE t.status END,
            t.start_time,t.end_time,COALESCE(linked.description,''),t.result,t.created_at,
            MAX(t.updated_at,linked.updated_at,COALESCE(e.updated_at,0)),linked.id,COALESCE(e.title,''),
            (linked.status=2 OR COALESCE(e.status IN (4,5),0)),t.slot_id
     FROM ai_tasks t JOIN actions a ON a.id=t.action_id AND a.space_id=t.space_id
     JOIN actions linked ON linked.id=t.linked_action_id AND linked.space_id=t.space_id
     LEFT JOIN events e ON e.id=linked.event_id AND e.space_id=t.space_id
     WHERE t.space_id=?1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL
       AND linked.deleted_at IS NULL
       AND (linked.event_id IS NULL OR (e.id IS NOT NULL AND e.deleted_at IS NULL))";

fn sync_completion(conn: &Connection, space: &str, action_id: i64, status: &AiTaskStatus, timestamp: i64) -> Result<(), String> {
    let completed = matches!(status, AiTaskStatus::Completed);
    conn.execute(
        "UPDATE actions SET status=?1,completed_at=?2,updated_at=?3
         WHERE id=?4 AND space_id=?5 AND deleted_at IS NULL AND status IN (0,1) AND status<>?1",
        params![i32::from(completed), completed.then_some(timestamp), timestamp, action_id, space],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn list_tasks(conn: &Connection, date: &str) -> Result<Vec<AiTask>, String> {
    validate_date(date)?;
    let space = current_space_id(conn).map_err(|error| error.to_string())?;
    let mut statement = conn.prepare(&format!("{SELECT_TASK} AND t.list_date=?2 ORDER BY t.id"))
        .map_err(|error| error.to_string())?;
    let tasks = statement.query_map(params![space, date], row_to_task)
        .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>();
    tasks.map_err(|error| error.to_string())
}

fn read_task(conn: &Connection, space: &str, id: i64) -> Result<AiTask, String> {
    conn.query_row(&format!("{SELECT_TASK} AND t.id=?2"), params![space, id], row_to_task)
        .optional().map_err(|error| error.to_string())?.ok_or_else(|| "AI 任务不存在".into())
}

#[tauri::command]
pub fn get_ai_tasks(state: State<'_, AppState>, list_date: String) -> Result<Vec<AiTask>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    list_tasks(&conn, &list_date)
}

#[tauri::command]
pub fn create_ai_task(state: State<'_, AppState>, payload: NewAiTask) -> Result<AiTask, String> {
    create_task_impl(&state, payload)
}

pub(super) fn create_task_impl(state: &AppState, payload: NewAiTask) -> Result<AiTask, String> {
    let mut conn = state.db.lock().map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let task = insert_task(&tx, payload)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(task)
}

fn insert_task(tx: &Connection, payload: NewAiTask) -> Result<AiTask, String> {
    validate_date(&payload.list_date)?;
    validate_fields(&payload.fields)?;
    if payload.action_id == payload.linked_action_id {
        return Err("不能将主行动挂载到自身".into());
    }
    let space = current_space_id(&tx).map_err(|error| error.to_string())?;
    super::actions::validate_schedulable_event(&tx, &space, payload.action_id)?;
    let scheduled: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM daily_schedule_slots s JOIN actions a ON a.id=s.action_id AND a.space_id=s.space_id
         WHERE s.space_id=?1 AND s.list_date=?2 AND a.id=?3 AND a.deleted_at IS NULL AND s.id=?4)",
        params![space, payload.list_date, payload.action_id, payload.slot_id], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !scheduled { return Err("该时间段的主行动已变化，请刷新后重试".into()); }
    let linked: Option<(String, String, i64)> = tx.query_row(
        "SELECT a.title,COALESCE(a.description,''),MAX(a.updated_at,COALESCE(e.updated_at,0))
         FROM actions a LEFT JOIN events e ON e.id=a.event_id AND e.space_id=a.space_id
         WHERE a.id=?1 AND a.space_id=?2 AND a.deleted_at IS NULL AND a.status=0
           AND (a.event_id IS NULL OR (e.deleted_at IS NULL AND e.status=1))",
        params![payload.linked_action_id, space],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    let (title, notes, linked_version) = linked.ok_or("请选择可安排的待办行动")?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_tasks WHERE space_id=?1 AND list_date=?2 AND action_id=?3
         AND linked_action_id=?4 AND slot_id=?5 AND deleted_at IS NULL)",
        params![space, payload.list_date, payload.action_id, payload.linked_action_id, payload.slot_id], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if exists { return Err("该行动已挂载到这个时间段，请勿重复添加".into()); }
    let f = payload.fields;
    let now = now_millis().max(linked_version + 1);
    tx.execute(
        "INSERT INTO ai_tasks (space_id,action_id,list_date,title,status,start_time,end_time,notes,result,created_at,updated_at,linked_action_id,slot_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11,?12)",
        params![space, payload.action_id, payload.list_date, title, f.status.as_str(),
                f.start_time, f.end_time, notes, f.result, now, payload.linked_action_id, payload.slot_id],
    ).map_err(|error| error.to_string())?;
    let id = tx.last_insert_rowid();
    sync_completion(&tx, &space, payload.linked_action_id, &f.status, now)?;
    let task = read_task(&tx, &space, id)?;
    Ok(task)
}

#[tauri::command]
pub fn replace_ai_task_action(
    state: State<'_, AppState>, id: i64, linked_action_id: i64, expected_updated_at: i64,
) -> Result<AiTask, String> {
    replace_task_impl(&state, id, linked_action_id, expected_updated_at)
}

pub(super) fn replace_task_impl(
    state: &AppState, id: i64, linked_action_id: i64, expected_updated_at: i64,
) -> Result<AiTask, String> {
    let mut conn = state.db.lock().map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let space = current_space_id(&tx).map_err(|error| error.to_string())?;
    let old = read_task(&tx, &space, id)?;
    if old.updated_at != expected_updated_at { return Err("任务已被更新，请关闭后重新打开".into()); }
    if old.read_only { return Err("所属事件已完成或放弃，请先恢复后再修改".into()); }
    if old.linked_action_id == linked_action_id { return Ok(old); }
    let slot_id = old.slot_id.ok_or("该挂载已移出今日事，请刷新后重试")?;
    let task = insert_task(&tx, NewAiTask {
        slot_id, action_id: old.action_id, linked_action_id, list_date: old.list_date,
        fields: AiTaskFields {
            status: AiTaskStatus::Queued, start_time: old.start_time,
            end_time: old.end_time, result: String::new(),
        },
    })?;
    tx.execute("UPDATE ai_tasks SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND space_id=?3",
        params![now_millis().max(old.updated_at + 1), id, space]).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(task)
}

#[tauri::command]
pub fn update_ai_task(state: State<'_, AppState>, payload: UpdateAiTask) -> Result<AiTask, String> {
    update_task_impl(&state, payload)
}

pub(super) fn update_task_impl(state: &AppState, payload: UpdateAiTask) -> Result<AiTask, String> {
    validate_fields(&payload.fields)?;
    let mut conn = state.db.lock().map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let space = current_space_id(&tx).map_err(|error| error.to_string())?;
    let task = read_task(&tx, &space, payload.id)?;
    if task.read_only {
        return Err("所属事件已完成或放弃，请在事件篮中恢复后再修改".into());
    }
    if task.updated_at != payload.expected_updated_at {
        return Err("任务已被更新，请关闭后重新打开".into());
    }
    let f = payload.fields;
    let timestamp = now_millis().max(task.updated_at + 1);
    tx.execute(
        "UPDATE ai_tasks SET status=?1,start_time=?2,end_time=?3,result=?4,updated_at=?5
         WHERE id=?6 AND space_id=?7 AND deleted_at IS NULL",
        params![f.status.as_str(), f.start_time, f.end_time, f.result, timestamp, payload.id, space],
    ).map_err(|error| error.to_string())?;
    sync_completion(&tx, &space, task.linked_action_id, &f.status, timestamp)?;
    let updated = read_task(&tx, &space, payload.id)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_ai_task(state: State<'_, AppState>, id: i64, expected_updated_at: i64) -> Result<(), String> {
    delete_task_impl(&state, id, expected_updated_at)
}

pub(super) fn delete_task_impl(state: &AppState, id: i64, expected_updated_at: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    let space = current_space_id(&conn).map_err(|error| error.to_string())?;
    let task = read_task(&conn, &space, id)?;
    if task.updated_at != expected_updated_at { return Err("任务已被更新，请关闭后重新打开".into()); }
    conn.execute("UPDATE ai_tasks SET deleted_at=?1,updated_at=?1 WHERE id=?2 AND space_id=?3",
        params![now_millis().max(task.updated_at + 1), id, space]).map_err(|error| error.to_string())?;
    Ok(())
}
