use super::{new_uuid, DbError};
use rusqlite::{params, Connection};

pub(super) fn migrate(conn: &mut Connection) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "ALTER TABLE ai_tasks ADD COLUMN linked_action_id INTEGER REFERENCES actions(id);
         CREATE UNIQUE INDEX idx_ai_task_attachment
         ON ai_tasks(space_id,list_date,action_id,linked_action_id)
         WHERE deleted_at IS NULL;",
    )?;
    let legacy = {
        let mut statement = tx.prepare(
            "SELECT t.id,t.space_id,t.title,t.notes,t.status,t.list_date,t.created_at,t.updated_at,
                    COALESCE(t.deleted_at,p.deleted_at,e.deleted_at),e.id
             FROM ai_tasks t
             LEFT JOIN actions p ON p.id=t.action_id AND p.space_id=t.space_id
             LEFT JOIN events e ON e.id=p.event_id AND e.space_id=t.space_id ORDER BY t.id",
        )?;
        let rows = statement.query_map([], |row| Ok((
            row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            row.get::<_, i64>(6)?, row.get::<_, i64>(7)?, row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<i64>>(9)?,
        )))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut recovered_events = std::collections::HashMap::new();
    for (id, space, title, notes, status, date, created, updated, deleted, event_id) in legacy {
        // Recurring/legacy parent actions may have no event; preserve their records too.
        let event_id = match event_id {
            Some(id) => id,
            None => recovered_events.get(&space).copied().unwrap_or(0),
        };
        let event_id = if event_id == 0 {
            tx.execute(
                "INSERT INTO events (space_id,sync_id,title,status,created_at,updated_at)
                 VALUES (?1,?2,'历史 AI 任务',1,?3,?4)",
                params![space, new_uuid(), created, updated],
            )?;
            let event_id = tx.last_insert_rowid();
            recovered_events.insert(space.clone(), event_id);
            event_id
        } else { event_id };
        let completed = status == "completed";
        tx.execute(
            "INSERT INTO actions
             (space_id,sync_id,event_id,title,description,estimated_hours,start_date,status,completed_at,
              sort_order,deleted_at,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,0,?6,?7,?8,
                     (SELECT COALESCE(MAX(sort_order),-1)+1 FROM actions WHERE event_id=?3 AND space_id=?1),
                     ?9,?10,?11)",
            params![space, new_uuid(), event_id, title, notes, date, i32::from(completed),
                    completed.then_some(updated), deleted, created, updated],
        )?;
        tx.execute("UPDATE ai_tasks SET linked_action_id=?1 WHERE id=?2",
            params![tx.last_insert_rowid(), id])?;
    }
    tx.pragma_update(None, "user_version", 20)?;
    tx.commit()?;
    Ok(())
}
