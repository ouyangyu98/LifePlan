use crate::db::{current_space_id, now_millis};
use crate::models::{EventCategory, NewEventCategory, UpdateEventCategory};
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

fn row_to_category(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventCategory> {
    Ok(EventCategory {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn list_categories(conn: &Connection) -> rusqlite::Result<Vec<EventCategory>> {
    let space_id = current_space_id(conn).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(error))
    })?;
    let mut statement = conn.prepare(
        "SELECT id, name, color, sort_order, created_at, updated_at
         FROM event_categories
         WHERE space_id = ?1
         ORDER BY sort_order, id",
    )?;
    let categories = statement
        .query_map([space_id], row_to_category)?
        .collect();
    categories
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("分类名称不能为空".into());
    }
    if name.chars().count() > 20 {
        return Err("分类名称不能超过 20 个字".into());
    }
    Ok(name.to_string())
}

fn normalize_color(color: &str) -> String {
    let trimmed = color.trim();
    if trimmed.len() == 7
        && trimmed.starts_with('#')
        && trimmed[1..].chars().all(|value| value.is_ascii_hexdigit())
    {
        trimmed.to_ascii_uppercase()
    } else {
        "#1778FF".into()
    }
}

pub(super) fn validate_category(conn: &Connection, space: &str, id: Option<i64>) -> Result<(), String> {
    if let Some(id) = id {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM event_categories WHERE id=?1 AND space_id=?2)",
            params![id, space], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if !exists { return Err("事件分类不存在".into()); }
    }
    Ok(())
}

#[tauri::command]
pub fn get_event_categories(state: State<'_, AppState>) -> Result<Vec<EventCategory>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    list_categories(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_event_category(
    state: State<'_, AppState>,
    payload: NewEventCategory,
) -> Result<EventCategory, String> {
    create_category_impl(&state, payload)
}

pub(super) fn create_category_impl(state: &AppState, payload: NewEventCategory) -> Result<EventCategory, String> {
    let name = validate_name(&payload.name)?;
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    let space_id = current_space_id(&conn).map_err(|error| error.to_string())?;
    let now = now_millis();
    let order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_categories WHERE space_id = ?1",
            [&space_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO event_categories (space_id, name, color, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![space_id, name, normalize_color(&payload.color), order, now],
    )
    .map_err(|error| {
        if error.to_string().contains("UNIQUE") {
            "已经存在同名分类".into()
        } else {
            error.to_string()
        }
    })?;
    let id = conn.last_insert_rowid();
    list_categories(&conn)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|category| category.id == id)
        .ok_or_else(|| "创建分类后读取失败".into())
}

#[tauri::command]
pub fn update_event_category(
    state: State<'_, AppState>,
    payload: UpdateEventCategory,
) -> Result<EventCategory, String> {
    update_category_impl(&state, payload)
}

pub(super) fn update_category_impl(state: &AppState, payload: UpdateEventCategory) -> Result<EventCategory, String> {
    let name = validate_name(&payload.name)?;
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    let space_id = current_space_id(&conn).map_err(|error| error.to_string())?;
    let changed = conn
        .execute(
            "UPDATE event_categories
             SET name = ?1, color = ?2, updated_at = ?3
             WHERE id = ?4 AND space_id = ?5",
            params![name, normalize_color(&payload.color), now_millis(), payload.id, space_id],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "已经存在同名分类".into()
            } else {
                error.to_string()
            }
        })?;
    if changed == 0 {
        return Err("分类不存在".into());
    }
    list_categories(&conn)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|category| category.id == payload.id)
        .ok_or_else(|| "分类不存在".into())
}

#[tauri::command]
pub fn delete_event_category(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    delete_category_impl(&state, id)
}

pub(super) fn delete_category_impl(state: &AppState, id: i64) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let space_id = current_space_id(&tx).map_err(|error| error.to_string())?;
    let exists: Option<i64> = tx
        .query_row(
            "SELECT id FROM event_categories WHERE id = ?1 AND space_id = ?2",
            params![id, space_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if exists.is_none() {
        return Err("分类不存在".into());
    }
    tx.execute(
        "UPDATE events SET category_id = NULL, updated_at = ?1
         WHERE category_id = ?2 AND space_id = ?3",
        params![now_millis(), id, space_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM event_categories WHERE id = ?1 AND space_id = ?2",
        params![id, space_id],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}
