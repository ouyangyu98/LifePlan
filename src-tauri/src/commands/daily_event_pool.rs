use crate::db::{current_space_id, now_millis};
use crate::models::{DailyEventPool, DailyEventPoolEntry, DailyScheduleSlot, UpdateDailyEventPool};
use crate::AppState;
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use tauri::State;

fn validate_date(value: &str) -> Result<(), String> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "日期格式无效")?;
    if date.format("%Y-%m-%d").to_string() != value {
        return Err("日期格式无效".into());
    }
    Ok(())
}

fn read_ids(conn: &Connection, space: &str, date: &str) -> Result<Vec<i64>, String> {
    let key = format!("daily-event-pool:{space}:{date}");
    let value: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    value.map(|json| serde_json::from_str(&json).map_err(|_| "今日事件池记录无法读取，请重试".into()))
        .unwrap_or_else(|| Ok(Vec::new()))
}

pub(super) fn read_pool(conn: &Connection, date: &str) -> Result<DailyEventPool, String> {
    validate_date(date)?;
    let space = current_space_id(conn).map_err(|error| error.to_string())?;
    let event_ids = read_ids(conn, &space, date)?;
    if event_ids.is_empty() {
        return Ok(DailyEventPool { space_id: space, list_date: date.into(), event_ids, entries: Vec::new() });
    }
    let mut events = super::events::list_events(conn).map_err(|error| error.to_string())?;
    let actions = super::actions::list_actions(conn).map_err(|error| error.to_string())?;
    let entries = event_ids.iter().filter_map(|id| {
        let index = events.iter().position(|event| event.id == *id)?;
        let event = events.remove(index);
        let event_actions = actions.iter().filter(|action| action.event_id == Some(event.id)).cloned().collect();
        Some(DailyEventPoolEntry { event, actions: event_actions })
    }).collect();
    Ok(DailyEventPool { space_id: space, list_date: date.into(), event_ids, entries })
}

#[tauri::command]
pub fn get_daily_event_pool(state: State<'_, AppState>, list_date: String) -> Result<DailyEventPool, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    read_pool(&conn, &list_date)
}

pub(super) fn save_pool(state: &AppState, payload: UpdateDailyEventPool) -> Result<DailyEventPool, String> {
    validate_date(&payload.list_date)?;
    let mut seen = HashSet::new();
    if payload.event_ids.len() > 200 || payload.event_ids.iter().any(|id| !seen.insert(*id)) {
        return Err("今日事件池包含重复事件或超过数量限制".into());
    }
    let mut conn = state.db.lock().map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let space = current_space_id(&tx).map_err(|error| error.to_string())?;
    if payload.space_id != space {
        return Err("当前空间已改变，请重新打开今日事".into());
    }
    let existing = read_ids(&tx, &space, &payload.list_date)?;
    for id in &payload.event_ids {
        if existing.contains(id) { continue; }
        let allowed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE id=?1 AND space_id=?2 AND deleted_at IS NULL AND status=1)",
            params![id, space], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !allowed { return Err("只能添加当前空间进行中的事件".into()); }
    }
    let value = serde_json::to_string(&payload.event_ids).map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![format!("daily-event-pool:{space}:{}", payload.list_date), value, now_millis()],
    ).map_err(|error| error.to_string())?;
    let result = read_pool(&tx, &payload.list_date)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn save_daily_event_pool(state: State<'_, AppState>, payload: UpdateDailyEventPool) -> Result<DailyEventPool, String> {
    save_pool(&state, payload)
}

pub(super) fn assign_from_pool(
    state: &AppState, date: &str, space_id: &str, action_id: i64, slot_id: i64,
) -> Result<DailyScheduleSlot, String> {
    validate_date(date)?;
    let mut conn = state.db.lock().map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let space = current_space_id(&tx).map_err(|error| error.to_string())?;
    if space_id != space { return Err("当前空间已改变，请重新打开今日事".into()); }
    let event_id: Option<i64> = tx.query_row(
        "SELECT event_id FROM actions WHERE id=?1 AND space_id=?2 AND status=0 AND deleted_at IS NULL",
        params![action_id, space], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?.flatten();
    let ids = read_ids(&tx, &space, date)?;
    if !event_id.is_some_and(|id| ids.contains(&id)) {
        return Err("行动不在当前日期的事件池中或已不可安排".into());
    }
    super::actions::validate_schedulable_event(&tx, &space, action_id)?;
    let changed = tx.execute(
        "UPDATE daily_schedule_slots SET action_id=?1,updated_at=?2
         WHERE id=?3 AND space_id=?4 AND list_date=?5 AND action_id IS NULL
           AND COALESCE(TRIM(actual_notes),'')='' AND met_expectation IS NULL AND focused IS NULL
           AND NOT EXISTS(SELECT 1 FROM ai_tasks WHERE slot_id=?3 AND space_id=?4 AND deleted_at IS NULL)",
        params![action_id, now_millis(), slot_id, space, date],
    ).map_err(|error| error.to_string())?;
    if changed != 1 { return Err("时间段已有行动或复盘，请选择空时间段".into()); }
    let result = super::daily_schedule::slot_query(&tx, date).map_err(|error| error.to_string())?
        .into_iter().find(|slot| slot.id == slot_id).ok_or("安排后读取失败")?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn assign_daily_pool_action(
    state: State<'_, AppState>, list_date: String, space_id: String, action_id: i64, slot_id: i64,
) -> Result<DailyScheduleSlot, String> {
    assign_from_pool(&state, &list_date, &space_id, action_id, slot_id)
}
