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
    if fields.title.trim().is_empty() || fields.title.trim().chars().count() > 100 {
        return Err("任务名称需为 1 至 100 个字".into());
    }
    if fields.notes.chars().count() > 10000 || fields.result.chars().count() > 20000 {
        return Err("任务说明或结果内容过长".into());
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
    })
}

const SELECT_TASK: &str =
    "SELECT t.id,t.action_id,t.list_date,t.title,t.status,t.start_time,t.end_time,t.notes,t.result,t.created_at,t.updated_at
     FROM ai_tasks t JOIN actions a ON a.id=t.action_id AND a.space_id=t.space_id
     WHERE t.space_id=?1 AND t.deleted_at IS NULL AND a.deleted_at IS NULL";

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
    validate_date(&payload.list_date)?;
    validate_fields(&payload.fields)?;
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    let space = current_space_id(&conn).map_err(|error| error.to_string())?;
    let scheduled: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM daily_schedule_slots s JOIN actions a ON a.id=s.action_id AND a.space_id=s.space_id
         WHERE s.space_id=?1 AND s.list_date=?2 AND a.id=?3 AND a.deleted_at IS NULL)",
        params![space, payload.list_date, payload.action_id], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !scheduled { return Err("主行动未安排到当天，请刷新后重试".into()); }
    let f = payload.fields;
    let now = now_millis();
    conn.execute(
        "INSERT INTO ai_tasks (space_id,action_id,list_date,title,status,start_time,end_time,notes,result,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
        params![space, payload.action_id, payload.list_date, f.title.trim(), f.status.as_str(),
                f.start_time, f.end_time, f.notes, f.result, now],
    ).map_err(|error| error.to_string())?;
    read_task(&conn, &space, conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_ai_task(state: State<'_, AppState>, payload: UpdateAiTask) -> Result<AiTask, String> {
    update_task_impl(&state, payload)
}

pub(super) fn update_task_impl(state: &AppState, payload: UpdateAiTask) -> Result<AiTask, String> {
    validate_fields(&payload.fields)?;
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    let space = current_space_id(&conn).map_err(|error| error.to_string())?;
    let task = read_task(&conn, &space, payload.id)?;
    if task.updated_at != payload.expected_updated_at {
        return Err("任务已被更新，请关闭后重新打开".into());
    }
    let f = payload.fields;
    let timestamp = now_millis().max(task.updated_at + 1);
    conn.execute(
        "UPDATE ai_tasks SET title=?1,status=?2,start_time=?3,end_time=?4,notes=?5,result=?6,updated_at=?7
         WHERE id=?8 AND space_id=?9 AND deleted_at IS NULL",
        params![f.title.trim(), f.status.as_str(), f.start_time, f.end_time, f.notes, f.result, timestamp, payload.id, space],
    ).map_err(|error| error.to_string())?;
    read_task(&conn, &space, payload.id)
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
