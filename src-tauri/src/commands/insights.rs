use crate::db::{current_space_id, now_millis};
use crate::models::InsightsNote;
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

pub(super) fn read_note(conn: &Connection) -> Result<InsightsNote, String> {
    let space_id = current_space_id(conn).map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT content, updated_at FROM insights_notes WHERE space_id = ?1",
        [&space_id],
        |row| {
            Ok(InsightsNote {
                space_id: space_id.clone(),
                content: row.get(0)?,
                updated_at: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
    .map(|note| {
        note.unwrap_or(InsightsNote {
            space_id,
            content: String::new(),
            updated_at: 0,
        })
    })
}

#[tauri::command]
pub fn get_insights_note(state: State<'_, AppState>) -> Result<InsightsNote, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    read_note(&conn)
}

#[tauri::command]
pub fn save_insights_note(
    state: State<'_, AppState>,
    content: String,
    space_id: String,
) -> Result<InsightsNote, String> {
    save_note_impl(&state, content, space_id)
}

pub(super) fn save_note_impl(state: &AppState, content: String, space_id: String) -> Result<InsightsNote, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    if space_id != current_space_id(&conn).map_err(|error| error.to_string())? {
        return Err("当前空间已改变，请重新打开心得".into());
    }
    let updated_at = now_millis();
    conn.execute(
        "INSERT INTO insights_notes (space_id, content, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(space_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
        params![space_id, content, updated_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(InsightsNote { space_id, content, updated_at })
}
