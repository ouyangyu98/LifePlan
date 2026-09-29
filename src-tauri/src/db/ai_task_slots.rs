use super::DbError;
use rusqlite::{params, Connection, OptionalExtension};

pub(super) fn migrate(conn: &mut Connection) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "ALTER TABLE ai_tasks ADD COLUMN slot_id INTEGER REFERENCES daily_schedule_slots(id) ON DELETE SET NULL;
         CREATE INDEX idx_ai_tasks_slot ON ai_tasks(space_id,slot_id,deleted_at);",
    )?;
    let legacy = {
        let mut statement = tx.prepare("SELECT id,space_id,action_id,list_date,start_time FROM ai_tasks")?;
        let rows = statement.query_map([], |row| Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?,
        )))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, space, action_id, date, start) in legacy {
        // Old records have no attachment location. Prefer the recorded start,
        // then a containing/nearest occurrence; untimed records keep their old first occurrence.
        let slot_id: Option<i64> = tx.query_row(
            "SELECT id FROM daily_schedule_slots
             WHERE space_id=?1 AND action_id=?2 AND list_date=?3
             ORDER BY CASE WHEN start_time=?4 THEN 0
                           WHEN start_time<=?4 AND end_time>?4 THEN 1 ELSE 2 END,
                      ABS((CAST(substr(start_time,1,2) AS INTEGER)*60+CAST(substr(start_time,4,2) AS INTEGER))
                        -(CAST(substr(?4,1,2) AS INTEGER)*60+CAST(substr(?4,4,2) AS INTEGER))),
                      start_time,id LIMIT 1",
            params![space, action_id, date, start], |row| row.get(0),
        ).optional()?;
        tx.execute("UPDATE ai_tasks SET slot_id=?1 WHERE id=?2", params![slot_id, id])?;
    }
    tx.pragma_update(None, "user_version", 21)?;
    tx.commit()?;
    Ok(())
}
