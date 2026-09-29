use super::{actions, ai_tasks, daily_schedule, recurring_actions};
use crate::db::{current_space_id, ensure_current_space, run_migrations, AppState};
use crate::models::{AiTaskFields, AiTaskStatus, NewAiTask, UpdateAiTask};
use rusqlite::{params, Connection};
use std::sync::Mutex;

fn state() -> AppState {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    let space = ensure_current_space(&mut conn).unwrap();
    conn.execute(
        "INSERT INTO events (id,space_id,sync_id,title,status,created_at,updated_at)
         VALUES (11,?1,'parent-event','Parent event',1,1,1),(12,?1,'linked-event','Linked event',1,1,1)",
        [&space],
    ).unwrap();
    conn.execute(
        "INSERT INTO actions (id,space_id,sync_id,event_id,title,description,status,created_at,updated_at)
         VALUES (101,?1,'ai-parent',11,'Parent','',0,1,1),(102,?1,'ai-other',11,'Other','',1,1,1),
                (103,?1,'ai-linked',12,'Research','Task instructions',0,1,1),
                (104,?1,'ai-linked-other',12,'More research','',0,1,1)",
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
        status: AiTaskStatus::Queued,
        start_time: Some("09:00".into()), end_time: Some("11:30".into()),
        result: String::new(),
    }
}

fn payload() -> NewAiTask {
    NewAiTask { slot_id: 201, action_id: 101, linked_action_id: 103, list_date: "2026-09-29".into(), fields: fields() }
}

#[test]
fn same_ai_action_can_attach_to_multiple_slots_but_not_twice_in_one_slot() {
    let state = state();
    let first = ai_tasks::create_task_impl(&state, payload()).unwrap();
    let mut second = payload(); second.slot_id = 202;
    let second = ai_tasks::create_task_impl(&state, second).unwrap();
    assert_ne!(first.id, second.id);
    assert!(ai_tasks::create_task_impl(&state, payload()).unwrap_err().contains("这个时间段"));
    let mut other = payload(); other.linked_action_id = 104;
    let other = ai_tasks::create_task_impl(&state, other).unwrap();
    assert!(ai_tasks::replace_task_impl(&state, other.id, 103, other.updated_at).is_err());
    ai_tasks::delete_task_impl(&state, first.id, first.updated_at).unwrap();
    let replaced = ai_tasks::replace_task_impl(&state, other.id, 103, other.updated_at).unwrap();
    assert_eq!(replaced.slot_id, Some(201));
    let conn = state.db.lock().unwrap();
    let tasks = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
    assert_eq!(tasks.len(), 2);
    assert!(tasks.iter().any(|task| task.id == second.id && task.slot_id == Some(202)));
    assert!(conn.execute(
        "INSERT INTO ai_tasks(space_id,slot_id,action_id,linked_action_id,list_date,title,created_at,updated_at)
         SELECT space_id,slot_id,action_id,linked_action_id,list_date,title,created_at,updated_at
         FROM ai_tasks WHERE id=?1", [second.id],
    ).is_err());
}

#[test]
fn swapping_slots_with_the_same_ai_action_preserves_each_record_and_rolls_back_on_failure() {
    let state = state();
    let mut first = payload(); first.fields.result = "First slot result".into();
    let first = ai_tasks::create_task_impl(&state, first).unwrap();
    let mut second = payload(); second.slot_id = 202; second.fields.result = "Second slot result".into();
    let second = ai_tasks::create_task_impl(&state, second).unwrap();
    daily_schedule::move_slot_action_impl(&state, "2026-09-29", 201, 202).unwrap();
    {
        let conn = state.db.lock().unwrap();
        let tasks = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
        assert!(tasks.iter().any(|task| task.id == first.id && task.slot_id == Some(202) && task.result == "First slot result"));
        assert!(tasks.iter().any(|task| task.id == second.id && task.slot_id == Some(201) && task.result == "Second slot result"));
        conn.execute_batch(
            "CREATE TRIGGER fail_reattach BEFORE UPDATE OF slot_id ON ai_tasks
             WHEN NEW.slot_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test move failure'); END;",
        ).unwrap();
    }
    assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-29", 201, 202).is_err());
    let conn = state.db.lock().unwrap();
    let tasks = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
    assert!(tasks.iter().any(|task| task.id == first.id && task.slot_id == Some(202)));
    assert!(tasks.iter().any(|task| task.id == second.id && task.slot_id == Some(201)));
    assert_eq!(conn.query_row("SELECT actual_notes FROM daily_schedule_slots WHERE id=202", [], |r| r.get::<_, String>(0)).unwrap(), "Keep review");
}

fn legacy_v22(conn: &mut Connection) {
    conn.execute_batch(
        "DROP INDEX idx_ai_task_attachment;
         CREATE UNIQUE INDEX idx_ai_task_attachment ON ai_tasks(space_id,list_date,action_id,linked_action_id)
         WHERE deleted_at IS NULL;",
    ).unwrap();
    conn.pragma_update(None, "user_version", 22).unwrap();
}

#[test]
fn v22_upgrade_preserves_records_and_allows_cross_slot_attachments() {
    let state = state();
    let mut first = payload(); first.fields.result = "Keep historical result".into();
    ai_tasks::create_task_impl(&state, first).unwrap();
    let mut removed = payload(); removed.linked_action_id = 104;
    let removed = ai_tasks::create_task_impl(&state, removed).unwrap();
    ai_tasks::delete_task_impl(&state, removed.id, removed.updated_at).unwrap();
    {
        let mut conn = state.db.lock().unwrap();
        legacy_v22(&mut conn);
        let before = serde_json::to_value(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap()).unwrap();
        run_migrations(&mut conn).unwrap();
        run_migrations(&mut conn).unwrap();
        assert_eq!(serde_json::to_value(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap()).unwrap(), before);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        assert_eq!(conn.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0)).unwrap(), 23);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    let mut second = payload(); second.slot_id = 202;
    assert!(ai_tasks::create_task_impl(&state, second).is_ok());
}

#[test]
fn failed_v22_upgrade_keeps_old_index_version_and_records() {
    let state = state();
    ai_tasks::create_task_impl(&state, payload()).unwrap();
    let mut conn = state.db.lock().unwrap();
    legacy_v22(&mut conn);
    // A malformed historical row must abort the index upgrade, not be discarded.
    conn.execute(
        "INSERT INTO ai_tasks(space_id,slot_id,action_id,linked_action_id,list_date,title,created_at,updated_at)
         SELECT space_id,slot_id,action_id,linked_action_id,'2026-09-30',title,created_at,updated_at FROM ai_tasks", [],
    ).unwrap();
    assert!(run_migrations(&mut conn).is_err());
    assert_eq!(conn.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0)).unwrap(), 22);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    let index: String = conn.query_row("SELECT sql FROM sqlite_master WHERE name='idx_ai_task_attachment'", [], |r| r.get(0)).unwrap();
    assert!(index.contains("list_date"));
}

#[test]
fn replacing_ai_action_is_atomic_and_keeps_source_progress() {
    let state = state();
    let mut request = payload();
    request.fields.status = AiTaskStatus::Completed;
    request.fields.result = "Original result".into();
    let old = ai_tasks::create_task_impl(&state, request).unwrap();
    assert!(ai_tasks::replace_task_impl(&state, old.id, 999, old.updated_at).is_err());
    assert!(ai_tasks::replace_task_impl(&state, old.id, 104, old.updated_at - 1).is_err());
    assert_eq!(ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().len(), 1);
    let new = ai_tasks::replace_task_impl(&state, old.id, 104, old.updated_at).unwrap();
    assert_ne!(new.id, old.id);
    assert_eq!(new.slot_id, old.slot_id);
    assert_eq!(new.result, "");
    let conn = state.db.lock().unwrap();
    assert_eq!(conn.query_row("SELECT status FROM actions WHERE id=103", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("SELECT result FROM ai_tasks WHERE id=?1", [old.id], |r| r.get::<_, String>(0)).unwrap(), "Original result");
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().len(), 1);
}

#[test]
fn removing_one_slot_clears_review_and_only_its_ai_attachments() {
    let state = state();
    ai_tasks::create_task_impl(&state, payload()).unwrap();
    let mut second = payload(); second.slot_id = 202; second.linked_action_id = 104;
    let other = ai_tasks::create_task_impl(&state, second).unwrap();
    let unchanged = daily_schedule::assign_slot_action_impl(&state, 201, Some(101)).unwrap();
    assert_eq!(unchanged.actual_notes.as_deref(), Some("Keep review"));
    let cleared = daily_schedule::assign_slot_action_impl(&state, 201, None).unwrap();
    assert!(cleared.action_id.is_none());
    assert!(cleared.actual_notes.is_none());
    assert!(cleared.met_expectation.is_none());
    assert!(cleared.focused.is_none());
    assert_eq!(cleared.start_time, "09:00");
    let restored = daily_schedule::assign_slot_action_impl(&state, 201, Some(101)).unwrap();
    assert!(restored.actual_notes.is_none());
    let conn = state.db.lock().unwrap();
    let remaining = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, other.id);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM actions WHERE deleted_at IS NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
}

#[test]
fn ai_crud_preserves_parent_review_and_supports_all_manual_states() {
    let state = state();
    let before = serde_json::to_value(daily_schedule::slot_query(&state.db.lock().unwrap(), "2026-09-29").unwrap()).unwrap();
    let mut task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    assert_eq!(task.title, "Research");
    assert_eq!(task.notes, "Task instructions");
    assert_eq!(task.event_title, "Linked event");
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
        let linked_status: i32 = state.db.lock().unwrap().query_row(
            "SELECT status FROM actions WHERE id=103", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(linked_status, i32::from(expected == "completed"));
    }
    ai_tasks::delete_task_impl(&state, task.id, task.updated_at).unwrap();
    let conn = state.db.lock().unwrap();
    assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
    assert_eq!(serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap(), before);
    let preserved: String = conn.query_row("SELECT result FROM ai_tasks WHERE id=?1 AND deleted_at IS NOT NULL", [task.id], |row| row.get(0)).unwrap();
    assert_eq!(preserved, task.result);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM actions WHERE id=103 AND deleted_at IS NULL", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
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
    for linked_action_id in [101, 102, 999] {
        let mut request = payload(); request.linked_action_id = linked_action_id;
        assert!(ai_tasks::create_task_impl(&state, request).is_err());
    }
    let mut request = payload(); request.fields.result = "a".repeat(20001);
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    let mut request = payload(); request.action_id = 999;
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    let mut request = payload(); request.list_date = "2026-10-01".into();
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    assert!(serde_json::from_value::<AiTaskStatus>(serde_json::json!("unknown")).is_err());
    assert!(ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().is_empty());
    let mut request = payload(); request.fields.start_time = None; request.fields.end_time = None;
    assert!(ai_tasks::create_task_impl(&state, request).is_ok());
    assert!(ai_tasks::create_task_impl(&state, payload()).is_err());
    let mut request = payload(); request.linked_action_id = 104; request.fields.start_time = Some("23:30".into()); request.fields.end_time = Some("24:00".into());
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
    assert_eq!(tasks[0].slot_id, Some(203));
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
    assert_eq!(version, crate::db::migrations::CURRENT_SCHEMA_VERSION);
    assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
    assert_eq!(serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap(), before);
    let space = current_space_id(&conn).unwrap();
    conn.execute("INSERT INTO ai_tasks (space_id,action_id,linked_action_id,list_date,title,created_at,updated_at) VALUES (?1,101,103,'2026-09-29','Legacy snapshot',1,1)", params![space]).unwrap();
    run_migrations(&mut conn).unwrap();
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap()[0].title, "Research");
    let errors: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).unwrap();
    assert_eq!(errors, 0);
}

#[test]
fn pool_edits_completion_and_restore_are_shared_and_stale_writes_are_rejected() {
    let state = state();
    let task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    let mut next_day = payload(); next_day.list_date = "2026-09-30".into(); next_day.slot_id = 205;
    ai_tasks::create_task_impl(&state, next_day).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE actions SET title='Renamed',description='Shared notes',updated_at=?1 WHERE id=103",
            [task.updated_at + 10]).unwrap();
    }
    let renamed = ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().remove(0);
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(renamed.notes, "Shared notes");
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: task.updated_at, fields: fields() }).is_err());
    assert!(ai_tasks::delete_task_impl(&state, task.id, task.updated_at).is_err());
    actions::complete_action_impl(&state, 103).unwrap();
    for date in ["2026-09-29", "2026-09-30"] {
        assert_eq!(ai_tasks::list_tasks(&state.db.lock().unwrap(), date).unwrap()[0].status.as_str(), "completed");
    }
    actions::restore_action_impl(&state, 103).unwrap();
    assert_eq!(ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap()[0].status.as_str(), "queued");
    let fresh = ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().remove(0);
    let mut completed = fields(); completed.status = AiTaskStatus::Completed;
    let done = ai_tasks::update_task_impl(&state, UpdateAiTask { id: fresh.id, expected_updated_at: fresh.updated_at, fields: completed }).unwrap();
    assert_eq!(ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-30").unwrap()[0].status.as_str(), "completed");
    ai_tasks::delete_task_impl(&state, done.id, done.updated_at).unwrap();
    let conn = state.db.lock().unwrap();
    assert_eq!(conn.query_row("SELECT status FROM actions WHERE id=103", [], |row| row.get::<_, i32>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("SELECT status FROM actions WHERE id=101", [], |row| row.get::<_, i32>(0)).unwrap(), 0);
}

#[test]
fn archived_deleted_or_foreign_pool_actions_cannot_be_attached_or_overwritten() {
    let state = state();
    let task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE events SET status=5 WHERE id=12", []).unwrap();
    }
    let archived = ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().remove(0);
    assert!(archived.read_only);
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: archived.updated_at, fields: fields() }).is_err());
    let mut request = payload(); request.linked_action_id = 104;
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE events SET status=1 WHERE id=12", []).unwrap();
        conn.execute("UPDATE actions SET deleted_at=1 WHERE id=104", []).unwrap();
    }
    let mut request = payload(); request.linked_action_id = 104;
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('foreign',1,1)", []).unwrap();
        conn.execute("UPDATE actions SET deleted_at=NULL,space_id='foreign' WHERE id=104", []).unwrap();
    }
    let mut request = payload(); request.linked_action_id = 104;
    assert!(ai_tasks::create_task_impl(&state, request).is_err());
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE actions SET deleted_at=1 WHERE id=103", []).unwrap();
        assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
    }
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: task.updated_at, fields: fields() }).is_err());
}

#[test]
fn completing_linked_action_and_saving_result_is_atomic() {
    let state = state();
    let task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    state.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_linked_completion BEFORE UPDATE OF status ON actions
         WHEN NEW.id=103 BEGIN SELECT RAISE(ABORT,'test write failure'); END;"
    ).unwrap();
    let mut changes = fields(); changes.status = AiTaskStatus::Completed; changes.result = "Must roll back".into();
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: task.updated_at, fields: changes }).is_err());
    let current = ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().remove(0);
    assert_eq!(current.updated_at, task.updated_at);
    assert_eq!(current.result, "");
    assert_eq!(current.status.as_str(), "queued");
}

fn legacy_v19(conn: &mut Connection) {
    conn.execute_batch("DROP TABLE ai_tasks;").unwrap();
    conn.execute_batch(crate::db::migrations::AI_TASKS_MIGRATION).unwrap();
    conn.pragma_update(None, "user_version", 19).unwrap();
    let space = current_space_id(conn).unwrap();
    conn.execute("UPDATE actions SET event_id=NULL WHERE id=102", []).unwrap();
    conn.execute(
        "INSERT INTO ai_tasks (id,space_id,action_id,list_date,title,notes,status,result,start_time,end_time,deleted_at,created_at,updated_at)
         VALUES (1,?1,101,'2026-09-29','Legacy task','Legacy notes','running','Keep result','09:00','10:00',NULL,100,200),
                (2,?1,101,'2026-09-29','Done','Done notes','completed','Done result',NULL,NULL,NULL,101,201),
                (3,?1,101,'2026-09-29','Removed','Removed notes','queued','Archived result',NULL,NULL,202,102,202),
                (4,?1,102,'2026-09-29','Recurring parent','Notes','paused','Result',NULL,NULL,NULL,103,203),
                (5,?1,102,'2026-09-29','Same recurring parent','Notes','queued','Result',NULL,NULL,NULL,104,204)",
        [space],
    ).unwrap();
}

#[test]
fn v19_migration_preserves_records_and_creates_pool_actions_exactly_once() {
    let state = state();
    let mut conn = state.db.lock().unwrap();
    legacy_v19(&mut conn);
    let before = serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap();
    run_migrations(&mut conn).unwrap();
    run_migrations(&mut conn).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM actions", [], |row| row.get::<_, i64>(0)).unwrap(), 9);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM events", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
    let tasks = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
    assert_eq!(tasks.len(), 4);
    assert_eq!(tasks[0].notes, "Legacy notes");
    assert_eq!(tasks[0].result, "Keep result");
    assert_eq!(tasks[0].status.as_str(), "running");
    assert_eq!(tasks[0].start_time.as_deref(), Some("09:00"));
    assert_eq!(tasks[1].status.as_str(), "completed");
    assert_eq!(tasks[2].event_title, "历史 AI 任务");
    assert_eq!(conn.query_row("SELECT event_id FROM actions WHERE id=?1", [tasks[0].linked_action_id], |row| row.get::<_, i64>(0)).unwrap(), 11);
    assert_eq!(conn.query_row("SELECT a.completed_at FROM actions a JOIN ai_tasks t ON t.linked_action_id=a.id WHERE t.id=2", [], |row| row.get::<_, i64>(0)).unwrap(), 201);
    assert_eq!(conn.query_row("SELECT a.deleted_at FROM actions a JOIN ai_tasks t ON t.linked_action_id=a.id WHERE t.id=3", [], |row| row.get::<_, i64>(0)).unwrap(), 202);
    assert_eq!(serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap(), before);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn failed_v19_migration_rolls_back_schema_and_records() {
    let state = state();
    let mut conn = state.db.lock().unwrap();
    legacy_v19(&mut conn);
    conn.execute_batch("CREATE TRIGGER fail_migration BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(run_migrations(&mut conn).is_err());
    assert_eq!(conn.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0)).unwrap(), 19);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM actions", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks", [], |row| row.get::<_, i64>(0)).unwrap(), 5);
    assert!(conn.prepare("SELECT linked_action_id FROM ai_tasks").is_err());
}

#[test]
fn standalone_temporary_and_recurring_actions_support_ai_attachment_without_replacing_parent() {
    let state = state();
    let temporary = actions::create_action_impl(&state, serde_json::from_value(serde_json::json!({
        "title": "Temporary AI", "estimated_hours": 0.5, "is_frog": 0
    })).unwrap()).unwrap();
    let template = recurring_actions::create_recurring_action_impl(&state, serde_json::from_value(serde_json::json!({
        "title": "Recurring AI", "estimated_hours": 2, "is_frog": 0,
        "frequency_unit": "daily", "frequency_count": 1
    })).unwrap()).unwrap();
    let recurring = recurring_actions::create_action_from_recurring_impl(&state, template.id).unwrap();
    let before = serde_json::to_value(daily_schedule::slot_query(&state.db.lock().unwrap(), "2026-09-29").unwrap()).unwrap();
    for source in [temporary, recurring] {
        assert!(source.event_id.is_none());
        let mut request = payload(); request.linked_action_id = source.id;
        let task = ai_tasks::create_task_impl(&state, request).unwrap();
        assert_eq!(task.title, source.title);
        assert_eq!(task.event_title, "");
        assert!(!task.read_only);
        let mut completed = fields(); completed.status = AiTaskStatus::Completed;
        let done = ai_tasks::update_task_impl(&state, UpdateAiTask { id: task.id, expected_updated_at: task.updated_at, fields: completed }).unwrap();
        assert_eq!(done.status.as_str(), "completed");
        let restored = ai_tasks::update_task_impl(&state, UpdateAiTask { id: done.id, expected_updated_at: done.updated_at, fields: fields() }).unwrap();
        assert_eq!(restored.status.as_str(), "queued");
        ai_tasks::delete_task_impl(&state, restored.id, restored.updated_at).unwrap();
        assert!(actions::list_actions(&state.db.lock().unwrap()).unwrap().iter().any(|action| action.id == source.id));
    }
    assert_eq!(serde_json::to_value(daily_schedule::slot_query(&state.db.lock().unwrap(), "2026-09-29").unwrap()).unwrap(), before);
}

#[test]
fn eventless_support_does_not_expose_actions_with_missing_or_foreign_events() {
    let state = state();
    // Simulate historical invalid references; normal writes enforce foreign keys.
    state.db.lock().unwrap().pragma_update(None, "foreign_keys", false).unwrap();
    for event_id in [999, 13] {
        {
            let conn = state.db.lock().unwrap();
            conn.execute("INSERT OR IGNORE INTO local_spaces(space_id,created_at,updated_at) VALUES('foreign',1,1)", []).unwrap();
            conn.execute("INSERT OR IGNORE INTO events(id,space_id,sync_id,title,status,created_at,updated_at) VALUES(13,'foreign','foreign-event','Foreign',1,1,1)", []).unwrap();
            conn.execute("UPDATE actions SET event_id=?1 WHERE id=103", [event_id]).unwrap();
        }
        assert!(ai_tasks::create_task_impl(&state, payload()).is_err());
        let conn = state.db.lock().unwrap();
        let space = current_space_id(&conn).unwrap();
        conn.execute("INSERT INTO ai_tasks(space_id,action_id,linked_action_id,list_date,title,created_at,updated_at) VALUES(?1,101,103,'2026-09-29','Hidden',1,1)", [&space]).unwrap();
        assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().is_empty());
        conn.execute("DELETE FROM ai_tasks", []).unwrap();
    }
}

#[test]
fn attachments_remember_the_selected_slot_independently_of_planned_times() {
    let state = state();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE daily_schedule_slots SET start_time='13:30',end_time='14:30' WHERE id=202", []).unwrap();
    }
    let morning = ai_tasks::create_task_impl(&state, payload()).unwrap();
    let mut request = payload();
    request.slot_id = 202;
    request.linked_action_id = 104;
    request.fields.start_time = Some("13:30".into());
    request.fields.end_time = Some("14:30".into());
    let afternoon = ai_tasks::create_task_impl(&state, request).unwrap();
    assert_eq!(morning.slot_id, Some(201));
    assert_eq!(afternoon.slot_id, Some(202));
    let mut changes = fields(); changes.start_time = None; changes.end_time = None;
    let edited = ai_tasks::update_task_impl(&state, UpdateAiTask {
        id: afternoon.id, expected_updated_at: afternoon.updated_at, fields: changes,
    }).unwrap();
    assert_eq!(edited.slot_id, Some(202));
    // Even identical parent actions can trade their distinct occurrence content.
    daily_schedule::move_slot_action_impl(&state, "2026-09-29", 201, 202).unwrap();
    let moved = ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap();
    assert_eq!(moved.iter().find(|task| task.id == morning.id).unwrap().slot_id, Some(202));
    assert_eq!(moved.iter().find(|task| task.id == afternoon.id).unwrap().slot_id, Some(201));
    daily_schedule::move_slot_action_impl(&state, "2026-09-29", 202, 204).unwrap();
    let moved = ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap();
    assert_eq!(moved.iter().find(|task| task.id == morning.id).unwrap().slot_id, Some(204));
    assert_eq!(moved.iter().find(|task| task.id == afternoon.id).unwrap().slot_id, Some(201));
    assert!(ai_tasks::update_task_impl(&state, UpdateAiTask {
        id: afternoon.id, expected_updated_at: edited.updated_at, fields: fields(),
    }).is_err());
}

#[test]
fn invalid_or_changed_attachment_slots_are_rejected() {
    let state = state();
    for slot_id in [999, 203, 204, 205] {
        let mut request = payload(); request.slot_id = slot_id;
        assert!(ai_tasks::create_task_impl(&state, request).is_err());
    }
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces(space_id,created_at,updated_at) VALUES('slot-other',1,1)", []).unwrap();
        conn.execute("UPDATE daily_schedule_slots SET space_id='slot-other' WHERE id=201", []).unwrap();
    }
    assert!(ai_tasks::create_task_impl(&state, payload()).is_err());
    assert!(ai_tasks::list_tasks(&state.db.lock().unwrap(), "2026-09-29").unwrap().is_empty());
}

#[test]
fn failed_attachment_move_rolls_back_action_review_and_location() {
    let state = state();
    let task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    let before = serde_json::to_value(daily_schedule::slot_query(&state.db.lock().unwrap(), "2026-09-29").unwrap()).unwrap();
    state.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_ai_move BEFORE UPDATE OF slot_id ON ai_tasks
         BEGIN SELECT RAISE(ABORT,'test move failure'); END;",
    ).unwrap();
    assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-29", 201, 203).is_err());
    let conn = state.db.lock().unwrap();
    let after = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().remove(0);
    assert_eq!(after.slot_id, task.slot_id);
    assert_eq!(after.updated_at, task.updated_at);
    assert_eq!(serde_json::to_value(daily_schedule::slot_query(&conn, "2026-09-29").unwrap()).unwrap(), before);
}

#[test]
fn deleting_an_attachment_slot_preserves_task_without_reanchoring_it() {
    let state = state();
    let task = ai_tasks::create_task_impl(&state, payload()).unwrap();
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM daily_schedule_slots WHERE id=201", []).unwrap();
    let preserved = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().remove(0);
    assert_eq!(preserved.id, task.id);
    assert_eq!(preserved.slot_id, None);
    assert_eq!(preserved.title, task.title);
    assert_eq!(preserved.result, task.result);
}

fn legacy_v20(conn: &mut Connection) {
    conn.execute_batch(
        "DROP INDEX idx_ai_tasks_slot;
         DROP INDEX idx_ai_task_attachment;
         ALTER TABLE ai_tasks DROP COLUMN slot_id;
         CREATE UNIQUE INDEX idx_ai_task_attachment ON ai_tasks(space_id,list_date,action_id,linked_action_id)
         WHERE deleted_at IS NULL;
         UPDATE daily_schedule_slots SET start_time='13:30',end_time='14:30' WHERE id=202;",
    ).unwrap();
    conn.pragma_update(None, "user_version", 20).unwrap();
    let space = current_space_id(conn).unwrap();
    conn.execute(
        "INSERT INTO ai_tasks(id,space_id,action_id,linked_action_id,list_date,title,notes,result,status,start_time,end_time,created_at,updated_at)
         VALUES(301,?1,101,103,'2026-09-29','Snapshot','Saved notes','Saved result','running','13:30','14:30',10,20),
               (302,?1,101,104,'2026-09-29','Snapshot','Notes','Result','queued','13:45','14:30',11,21),
               (303,?1,101,103,'2026-09-30','Snapshot','Notes','Result','queued',NULL,NULL,12,22),
               (304,?1,101,104,'2026-10-01','Snapshot','Notes','Result','queued','13:30','14:30',13,23),
               (305,?1,101,103,'2026-10-02','Snapshot','Notes','Result','queued','13:30','14:30',14,24)",
        [&space],
    ).unwrap();
    conn.execute(
        "INSERT INTO local_spaces(space_id,created_at,updated_at) VALUES('slot-other',1,1)", [],
    ).unwrap();
    conn.execute(
        "INSERT INTO daily_schedule_slots(space_id,list_date,start_time,end_time,action_id,created_at,updated_at)
         VALUES('slot-other','2026-10-02','13:30','14:30',101,1,1)", [],
    ).unwrap();
}

#[test]
fn v20_upgrade_recovers_afternoon_attachments_once_and_preserves_all_records() {
    let state = state();
    let mut conn = state.db.lock().unwrap();
    legacy_v20(&mut conn);
    run_migrations(&mut conn).unwrap();
    run_migrations(&mut conn).unwrap();
    let tasks = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
    assert_eq!(tasks.len(), 2);
    assert!(tasks.iter().all(|task| task.slot_id == Some(202)));
    assert_eq!(tasks[0].result, "Saved result");
    assert_eq!(tasks[0].status.as_str(), "running");
    assert_eq!(tasks[0].created_at, 10);
    assert_eq!(tasks[0].updated_at, 20);
    assert_eq!(tasks[0].start_time.as_deref(), Some("13:30"));
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-09-30").unwrap()[0].slot_id, Some(205));
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-10-01").unwrap()[0].slot_id, None);
    assert_eq!(ai_tasks::list_tasks(&conn, "2026-10-02").unwrap()[0].slot_id, None);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks", [], |row| row.get::<_, i64>(0)).unwrap(), 5);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM actions", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(conn.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0)).unwrap(), crate::db::migrations::CURRENT_SCHEMA_VERSION);
    conn.execute("UPDATE daily_schedule_slots SET start_time='16:00',end_time='17:00' WHERE id=202", []).unwrap();
    run_migrations(&mut conn).unwrap();
    assert!(ai_tasks::list_tasks(&conn, "2026-09-29").unwrap().iter().all(|task| task.slot_id == Some(202)));
}

#[test]
fn failed_v20_upgrade_rolls_back_without_partial_attachment_locations() {
    let state = state();
    let mut conn = state.db.lock().unwrap();
    legacy_v20(&mut conn);
    conn.execute_batch("CREATE TRIGGER fail_locations BEFORE UPDATE ON ai_tasks BEGIN SELECT RAISE(ABORT,'test migration failure'); END;").unwrap();
    assert!(run_migrations(&mut conn).is_err());
    assert!(conn.prepare("SELECT slot_id FROM ai_tasks").is_err());
    assert_eq!(conn.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0)).unwrap(), 20);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks", [], |row| row.get::<_, i64>(0)).unwrap(), 5);
}
