use super::{ai_tasks, daily_schedule};
use crate::db::{current_space_id, ensure_current_space, run_migrations, AppState};
use crate::models::{AiTaskFields, AiTaskStatus, NewAiTask, UpdateAiTask};
use rusqlite::{params, Connection};
use std::sync::Mutex;

fn state() -> AppState {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    let space = ensure_current_space(&mut conn).unwrap();
    conn.execute(
        "INSERT INTO actions (id,space_id,sync_id,title,status,created_at,updated_at)
         VALUES (101,?1,'ai-parent','Parent',0,1,1),(102,?1,'ai-other','Other',1,1,1)",
        [&space],
    ).unwrap();
    conn.execute(
        "INSERT INTO daily_schedule_slots
         (id,space_id,list_date,start_time,end_time,action_id,actual_notes,met_expectation,focused,created_at,updated_at)
         VALUES (201,?1,'2026-09-29','09:00','10:00',101,'Keep review',1,1,1,1),
                (202,?1,'2026-09-29','10:00','11:00',101,NULL,NULL,NULL,1,1),
                (203,?1,'2026-09-29','11:00','12:00',102,'Other review',0,0,1,1),
                (204,?1,'2026-09-29','13:00','14:00',NULL,NULL,NULL,NULL,1,1),
                (205,?1,'2026-09-30','09:00','10:00',101,NULL,NULL,NULL,1,1)",
        [&space],
    ).unwrap();
    AppState { db: Mutex::new(conn), db_path: ":memory:".into(), startup_notice: Mutex::new(None) }
}

fn fields() -> AiTaskFields {
    AiTaskFields {
        title: "  Research  ".into(), status: AiTaskStatus::Queued,
        start_time: Some("09:00".into()), end_time: Some("11:30".into()),
        notes: "Task instructions".into(), result: String::new(),
    }
}

fn payload() -> NewAiTask {
    NewAiTask { action_id: 101, list_date: "2026-09-29".into(), fields: fields() }
}

#[test]
fn ai_crud_preserves_parent_review_and_supports_all_manual_states() {
    let state = state();
    let before = serde_json::to_value(daily_schedule::slot_query(&state.db.lock().unwrap(), "2026-09-29").unwrap()).unwrap();
    let mut task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    assert_eq!(task.title, "Research");
    assert_eq!(ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().len(), 1);
    for status in [AiTaskStatus::Running, AiTaskStatus::Paused, AiTaskStatus::Failed, AiTaskStatus::Ready, AiTaskStatus::Completed, AiTaskStatus::Queued] {
        let expected = status.as_str();
        let previous = task.updated_at;
        let mut fields = fields();
        fields.status = status;
        fields.result = "Result\n<script>plain text</script>".into();
        task = ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: task.updated_at, fields }).unwrap();
        assert!(task.updated_at > previous);
        assert_eq!(task.status.as_str(), expected);
        assert_eq!(task.result, "Result\n<script>plain text</script>");
    }
    ai_tasks::delete_task_impl(&state, task.id, task.updated_at).unwrap();
    let conn = state.db.lock().unwrap();
    assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
    assert_eq!(serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap(), before);
    let preserved: String = conn.query_row("SELECT result FROM ai_tasks WHERE id=?1 AND deleted_at IS NOT NULL", [task.id], |row| row.get(0)).unwrap();
    assert_eq!(preserved, task.result);
}

#[test]
fn ai_validation_rejects_bad_dates_times_and_missing_parent_without_writes() {
    let state = state();
    for date in ["2026-02-30", "invalid", "2026-09-31"] {
        let mut request = payload(); request.list_date = date.into();
        assert!(ai_tasks::create_task_impl(&state, request).is_err());
        assert!(ai_tasks::list_tasks(&state.db.lock().unwrap(), date).is_err());
    }
    for (start, end) in [
        (Some("10:00"), Some("09:00")), (Some("23:30"), Some("00:30")),
        (Some("24:00"), Some("24:30")), (Some("09:60"), Some("11:00")),
        (Some("日:00"), Some("11:00")), (Some("09:00"), None), (None, Some("11:00")),
    ] {
        let mut request = payload();
        request.fields.start_time = start.map(str::to_string); request.fields.end_time = end.map(str::to_string);
        assert!(ai_tasks::create_task_impl(&state, request).is_err());
    }
    for title in [" ".to_string(), "a".repeat(101)] {
        let mut request = payload(); request.fields.title = title;
        assert!(ai_tasks::create_task_impl(&state, request).is_err());
    }
    let mut request = payload(); request.action_id = 999;
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    let mut request = payload(); request.list_date = "2026-10-01".into();
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    assert!(serde_json::from_value::<AiTaskStatus>(serde_json::json!("unknown")).is_err());
    assert!(ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().is_empty());
    let mut request = payload(); request.fields.start_time = None; request.fields.end_time = None;
    assert!(ai_tasks::create_task_impl(&state, request).is_ok());
    let mut request = payload(); request.fields.start_time = Some("23:30".into()); request.fields.end_time = Some("24:00".into());
    assert!(ai_tasks::create_task_impl(&state, request).is_ok());
}

#[test]
fn ai_tasks_stay_with_action_when_slots_swap_and_are_not_duplicated() {
    let state = state();
    let task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    daily_schedule::move_slot_action_impl(&state, "2026-09-29", 201, 203).unwrap();
    daily_schedule::move_slot_action_impl(&state, "2026-09-29", 202, 204).unwrap();
    let conn = state.db.lock().unwrap();
    let tasks = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, task.id);
    assert_eq!(tasks[0].action_id, 101);
    assert_eq!(tasks[0].start_time.as_deref(), Some("09:00"));
    assert_eq!(tasks[0].end_time.as_deref(), Some("11:30"));
    // Removing or replacing the daily assignment must not discard task records.
    conn.execute("UPDATE daily_schedule_slots SET action_id=NULL WHERE action_id=101", []).unwrap();
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().len(), 1);
    conn.execute("UPDATE daily_schedule_slots SET action_id=101 WHERE id=201", []).unwrap();
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap()[0].id, task.id);
}

#[test]
fn ai_tasks_are_scoped_to_space_and_date_and_reject_stale_updates() {
    let state = state();
    let task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    let updated = ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: task.updated_at, fields: fields() }).unwrap();
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: task.updated_at, fields: fields() }).is_err());
    assert!(ai_tasks::delete_task_impl(&state, task.id, task.updated_at).is_err());
    let original_space;
    {
        let conn = state.db.lock().unwrap();
        original_space = current_space_id(&conn).unwrap();
        assert!(ai_tasks::list_tasks(&conn, "2026-09-30").unwrap().is_empty());
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('other',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='other' WHERE key='current_space_id'", []).unwrap();
        assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
    }
    assert!(ai_tasks::create_task_impl(&state, payload()).is_err());
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: updated.updated_at, fields: fields() }).is_err());
    assert!(ai_tasks::delete_task_impl(&state, task.id, updated.updated_at).is_err());
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE settings SET value=?1 WHERE key='current_space_id'", [&original_space]).unwrap();
        conn.execute("UPDATE actions SET deleted_at=1 WHERE id=101", []).unwrap();
        assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
    }
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: updated.updated_at, fields: fields() }).is_err());
}

#[test]
fn v18_upgrade_is_repeatable_and_preserves_existing_schedule() {
    let state = state();
    let mut conn = state.db.lock().unwrap();
    let before = serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap();
    conn.execute_batch("DROP TABLE ai_tasks;").unwrap();
    conn.pragma_update(None, "user_version", 18).unwrap();
    run_migrations(&mut conn).unwrap();
    run_migrations(&mut conn).unwrap();
    let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, 19);
    assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
    assert_eq!(serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap(), before);
    let space = current_space_id(&conn).unwrap();
    conn.execute("INSERT INTO ai_tasks (space_id,action_id,list_date,title,created_at,updated_at) VALUES (?1,101,'2026-09-29','Persistent',1,1)", params![space]).unwrap();
    run_migrations(&mut conn).unwrap();
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap()[0].title, "Persistent");
    let errors: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).unwrap();
    assert_eq!(errors, 0);
}
