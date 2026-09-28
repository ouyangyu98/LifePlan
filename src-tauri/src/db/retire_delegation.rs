use super::{column_exists, migrations, validate_current_schema, DbError};
use rusqlite::Connection;

// Legacy names are used only here to preserve records before retiring the feature.
pub(super) fn migrate(conn: &mut Connection) -> Result<(), DbError> {
    let tx = conn.transaction().map_err(DbError::ConnectionFailed)?;
    if !column_exists(&tx, "events", "history_note")? {
        tx.execute_batch("ALTER TABLE events ADD COLUMN history_note TEXT;")?;
    }
    let mut lines = Vec::new();
    for (column, label) in [
        ("delegated_to", "原委托对象"),
        ("follow_up_date", "原跟进日期"),
        ("follow_up_note", "原跟进备注"),
    ] {
        if column_exists(&tx, "events", column)? {
            lines.push(format!(
                "CASE WHEN {column} IS NOT NULL AND TRIM({column}) <> '' THEN CHAR(10) || '{label}：' || {column} ELSE '' END"
            ));
        }
    }
    if !lines.is_empty() {
        let content = lines.join(" || ");
        tx.execute_batch(&format!(
            "UPDATE events SET history_note =
                CASE WHEN COALESCE(history_note, '') = '' THEN ''
                     ELSE history_note || CHAR(10) || CHAR(10) END ||
                '历史说明' || ({content})
             WHERE ({content}) <> '';"
        ))?;
    }
    // Migrate every space, including soft-deleted history. Do not renumber other statuses.
    tx.execute_batch("UPDATE events SET status = 1 WHERE status = 2;")?;
    for column in ["delegated_to", "follow_up_date", "follow_up_note"] {
        if column_exists(&tx, "events", column)? {
            tx.execute_batch(&format!("ALTER TABLE events DROP COLUMN {column};"))?;
        }
    }
    if column_exists(&tx, "actions", "is_delegated_follow_up")? {
        tx.execute_batch("ALTER TABLE actions DROP COLUMN is_delegated_follow_up;")?;
    }
    validate_current_schema(&tx)?;
    tx.pragma_update(None, "user_version", migrations::CURRENT_SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{ensure_current_space, migrations};

    #[test]
    fn retires_delegation_without_losing_history_or_relations() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(migrations::INIT_MIGRATION).unwrap();
        let space = ensure_current_space(&mut conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE events ADD COLUMN delegated_to TEXT;
             ALTER TABLE events ADD COLUMN follow_up_date TEXT;
             ALTER TABLE events ADD COLUMN follow_up_note TEXT;
             ALTER TABLE actions ADD COLUMN is_delegated_follow_up INTEGER NOT NULL DEFAULT 0;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO events (id, space_id, sync_id, title, status, delegated_to, follow_up_date, follow_up_note, history_note, created_at, updated_at)
             VALUES (1, ?1, 'active', 'Active', 2, 'Alex', '2026-09-30', 'Call back', '已有记录', 10, 11),
                    (2, ?1, 'deleted', 'Deleted', 2, 'Sam', NULL, NULL, NULL, 12, 13),
                    (3, ?1, 'completed', 'Completed', 5, NULL, NULL, NULL, NULL, 14, 15)",
            [&space],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO actions (id, space_id, sync_id, event_id, title, status, is_delegated_follow_up, created_at, updated_at)
             VALUES (1, ?1, 'child', 1, 'Child', 1, 1, 20, 21)",
            [&space],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO daily_list_items (space_id, action_id, list_date, sort_order, created_at)
             VALUES (?1, 1, '2026-09-28', 3, 22)",
            [&space],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO user_points (space_id, total_points, updated_at) VALUES (?1, 42, 23)",
            [&space],
        )
        .unwrap();
        conn.execute("UPDATE events SET deleted_at = 99 WHERE id = 2", []).unwrap();
        conn.pragma_update(None, "user_version", 17).unwrap();

        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();

        let status: Vec<i32> = conn
            .prepare("SELECT status FROM events ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(status, vec![1, 1, 5]);
        let note: String = conn
            .query_row("SELECT history_note FROM events WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert!(note.contains("已有记录"));
        assert!(note.contains("原委托对象：Alex"));
        assert!(note.contains("原跟进日期：2026-09-30"));
        assert!(note.contains("原跟进备注：Call back"));
        assert!(!column_exists(&conn, "events", "delegated_to").unwrap());
        assert!(!column_exists(&conn, "events", "follow_up_date").unwrap());
        assert!(!column_exists(&conn, "events", "follow_up_note").unwrap());
        assert!(!column_exists(&conn, "actions", "is_delegated_follow_up").unwrap());
        assert_eq!(
            conn.query_row("SELECT event_id, status FROM actions WHERE id = 1", [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i32>(1)?))
            })
            .unwrap(),
            (1, 1)
        );
        assert_eq!(
            conn.query_row("SELECT action_id, sort_order FROM daily_list_items", [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap(),
            (1, 3)
        );
        assert_eq!(
            conn.query_row("SELECT total_points FROM user_points", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            42
        );
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, migrations::CURRENT_SCHEMA_VERSION);
    }
}
