use super::{actions, ai_tasks, daily_schedule, events};
use crate::db::{current_space_id, ensure_current_space, migrations, run_migrations, AppState};
use crate::models::{AiTaskFields, AiTaskStatus, NewAiTask, ProcessEvent, UpdateDailySlot};
use chrono::NaiveDateTime;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Mutex;

fn state() -> AppState {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    let space = ensure_current_space(&mut conn).unwrap();
    conn.execute(
        "INSERT INTO event_categories(id,space_id,name,color,created_at,updated_at)
         VALUES(1,?1,'Work','#1778FF',1,1)", [&space],
    ).unwrap();
    conn.execute(
        "INSERT INTO events(id,space_id,sync_id,title,status,target,category_id,created_at,updated_at)
         VALUES(1,?1,'active','Project',1,'Original goal',1,1,1),
               (2,?1,'pending','Pending',0,NULL,NULL,1,1),
               (3,?1,'other','Other project',1,NULL,NULL,1,1)",
        [&space],
    ).unwrap();
    conn.execute(
        "INSERT INTO actions(id,space_id,sync_id,event_id,title,status,description,start_date,completed_at,created_at,updated_at)
         VALUES(11,?1,'todo',1,'Todo',0,'Keep instructions','2026-09-29',NULL,1,1),
               (12,?1,'done',1,'Done',1,'Keep result','2026-09-28',123,1,1),
               (13,?1,'other-todo',3,'Other todo',0,'Unrelated',NULL,NULL,1,1)",
        [&space],
    ).unwrap();
    conn.execute(
        "INSERT INTO daily_schedule_slots(id,space_id,list_date,start_time,end_time,action_id,actual_notes,created_at,updated_at)
         VALUES(101,?1,'2026-09-28','13:00','14:00',11,'Past review',1,1),
               (102,?1,'2026-09-29','11:30','12:30',11,NULL,1,1),
               (103,?1,'2026-09-29','12:00','13:00',11,NULL,1,1),
               (104,?1,'2026-09-29','13:00','14:00',11,NULL,1,1),
               (105,?1,'2026-09-30','09:00','10:00',11,NULL,1,1),
               (106,?1,'2026-09-30','10:00','11:00',11,'Already reviewed',1,1),
               (107,?1,'2026-09-29','14:00','15:00',13,NULL,1,1),
               (108,?1,'2026-09-30','11:00','12:00',13,NULL,1,1),
               (109,?1,'2026-09-29','15:00','16:00',NULL,NULL,1,1)",
        [&space],
    ).unwrap();
    conn.execute(
        "INSERT INTO ai_tasks(id,space_id,action_id,linked_action_id,slot_id,list_date,title,result,status,created_at,updated_at)
         VALUES(201,?1,11,13,102,'2026-09-29','Past AI','Keep current result','running',1,1),
               (202,?1,11,13,105,'2026-09-30','Future AI','Keep detached result','queued',1,1),
               (203,?1,13,11,107,'2026-09-29','Linked AI','Keep linked result','queued',1,1),
               (204,?1,13,11,108,'2026-09-30','Linked future AI','Keep future result','queued',1,1)",
        [&space],
    ).unwrap();
    AppState { db: Mutex::new(conn), db_path: ":memory:".into(), startup_notice: Mutex::new(None) }
}

fn now() -> NaiveDateTime {
    NaiveDateTime::parse_from_str("2026-09-29 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap()
}

fn delay(id: i64, date: Option<&str>) -> ProcessEvent {
    serde_json::from_value(json!({
        "event_id": id, "decision": "delay", "delay_until": date, "delay_note": "  Waiting  ",
    })).unwrap()
}

fn child_snapshot(state: &AppState) -> Value {
    serde_json::to_value(actions::list_actions(&state.db.lock().unwrap()).unwrap()).unwrap()
}

fn slot_action(state: &AppState, id: i64) -> Option<i64> {
    state.db.lock().unwrap().query_row(
        "SELECT action_id FROM daily_schedule_slots WHERE id=?1", [id], |row| row.get(0),
    ).unwrap()
}

fn event_status(state: &AppState, id: i64) -> (i32, i32) {
    state.db.lock().unwrap().query_row(
        "SELECT status,delay_resume_status FROM events WHERE id=?1", [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap()
}

#[test]
fn delay_releases_only_unstarted_arrangements_and_keeps_progress_and_results() {
    let state = state();
    let before = child_snapshot(&state);
    events::process_event_at(&state, delay(1, None), now()).unwrap();
    assert_eq!(event_status(&state, 1), (3, 1));
    for id in [101, 102, 103, 106] { assert_eq!(slot_action(&state, id), Some(11)); }
    for id in [104, 105, 109] { assert_eq!(slot_action(&state, id), None); }
    for id in [107, 108] { assert_eq!(slot_action(&state, id), Some(13)); }
    assert_eq!(child_snapshot(&state), before);
    let conn = state.db.lock().unwrap();
    let tasks = ai_tasks::list_tasks(&conn, "2026-09-29").unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, 201);
    assert_eq!(tasks[0].result, "Keep current result");
    assert!(ai_tasks::list_tasks(&conn, "2026-09-30").unwrap().is_empty());
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks WHERE result LIKE 'Keep %'", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM daily_schedule_slots", [], |r| r.get::<_, i64>(0)).unwrap(), 9);
    let e = events::list_events(&conn).unwrap().into_iter().find(|e| e.id == 1).unwrap();
    assert_eq!(e.category_name.as_deref(), Some("Work"));
    assert_eq!(e.target.as_deref(), Some("Original goal"));
    assert_eq!(e.delay_note.as_deref(), Some("Waiting"));
    assert_eq!(e.completed_action_count, 1);
    assert_eq!(e.action_count, 2);
}

#[test]
fn manual_restore_and_repeated_delay_keep_origin_without_recreating_arrangements() {
    let state = state();
    let before = child_snapshot(&state);
    events::process_event_at(&state, delay(1, Some("2099-10-01")), now()).unwrap();
    events::process_event_at(&state, delay(1, None), now()).unwrap();
    assert_eq!(event_status(&state, 1), (3, 1));
    let split: ProcessEvent = serde_json::from_value(json!({
        "event_id": 1, "decision": "self", "quick_complete": true, "title": "Do not overwrite",
    })).unwrap();
    assert!(events::process_event_at(&state, split, now()).is_err());
    events::restore_event_impl(&state, 1).unwrap();
    assert_eq!(event_status(&state, 1), (1, 0));
    assert_eq!(slot_action(&state, 104), None);
    assert_eq!(slot_action(&state, 105), None);
    assert_eq!(child_snapshot(&state), before);
    events::process_event_at(&state, delay(1, None), now()).unwrap();
    assert_eq!(event_status(&state, 1), (3, 1));
    events::process_event_at(&state, delay(2, None), now()).unwrap();
    events::restore_event_impl(&state, 2).unwrap();
    assert_eq!(event_status(&state, 2), (0, 0));
    let conn = state.db.lock().unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM actions", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
}

#[test]
fn dated_restore_uses_local_calendar_date_and_leaves_undated_delays_alone() {
    let state = state();
    for (id, date) in [(1, Some("2099-10-01")), (2, Some("2099-10-01")), (3, None)] {
        events::process_event_at(&state, delay(id, date), now()).unwrap();
    }
    {
        let conn = state.db.lock().unwrap();
        events::restore_due_delays_on(&conn, "2099-09-30").unwrap();
    }
    assert_eq!(event_status(&state, 1), (3, 1));
    {
        let conn = state.db.lock().unwrap();
        events::restore_due_delays_on(&conn, "2099-10-01").unwrap();
        events::restore_due_delays_on(&conn, "2099-10-01").unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM events WHERE id IN(1,2) AND delay_until IS NULL AND delay_note IS NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }
    assert_eq!(event_status(&state, 1), (1, 0));
    assert_eq!(event_status(&state, 2), (0, 0));
    assert_eq!(event_status(&state, 3), (3, 1));
    assert_eq!(slot_action(&state, 105), None);
}

#[test]
fn invalid_dates_and_ineligible_events_do_not_change_data() {
    let state = state();
    for date in ["invalid", "2026-02-30", "2026-9-30", "2026-09-28", "2026-09-29"] {
        assert!(events::process_event_at(&state, delay(1, Some(date)), now()).is_err());
        assert_eq!(event_status(&state, 1), (1, 0));
        assert_eq!(slot_action(&state, 104), Some(11));
    }
    for status in [4, 5] {
        state.db.lock().unwrap().execute("UPDATE events SET status=?1 WHERE id=1", [status]).unwrap();
        assert!(events::process_event_at(&state, delay(1, None), now()).is_err());
        assert_eq!(event_status(&state, 1), (status, 0));
    }
    assert!(events::process_event_at(&state, delay(999, None), now()).is_err());
}

#[test]
fn midnight_boundary_frees_next_day_but_not_current_minute() {
    let state = state();
    let midnight = NaiveDateTime::parse_from_str("2026-09-28 23:59:59", "%Y-%m-%d %H:%M:%S").unwrap();
    events::process_event_at(&state, delay(1, None), midnight).unwrap();
    assert_eq!(slot_action(&state, 101), Some(11));
    for id in [102, 103, 104, 105] { assert_eq!(slot_action(&state, id), None); }
}

#[test]
fn delay_transaction_rolls_back_event_ai_and_schedule_together() {
    let state = state();
    state.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_release BEFORE UPDATE OF action_id ON daily_schedule_slots
         BEGIN SELECT RAISE(ABORT,'test release failure'); END;",
    ).unwrap();
    assert!(events::process_event_at(&state, delay(1, None), now()).is_err());
    assert_eq!(event_status(&state, 1), (1, 0));
    assert_eq!(slot_action(&state, 104), Some(11));
    let conn = state.db.lock().unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks WHERE deleted_at IS NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
}

fn ai_payload(parent: i64, linked: i64, slot: i64) -> NewAiTask {
    NewAiTask {
        action_id: parent, linked_action_id: linked, slot_id: slot, list_date: "2026-09-29".into(),
        fields: AiTaskFields { status: AiTaskStatus::Queued, start_time: None, end_time: None, result: String::new() },
    }
}

#[test]
fn delayed_actions_cannot_be_reassigned_dragged_or_attached_but_resume_can_be_scheduled() {
    let state = state();
    events::process_event_at(&state, delay(1, None), now()).unwrap();
    assert!(daily_schedule::assign_slot_action_impl(&state, 109, Some(11)).is_err());
    assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-29", 102, 109).is_err());
    assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-29", 107, 102).is_err());
    assert!(daily_schedule::update_slot_impl(&state, UpdateDailySlot {
        id: 102, start_time: "16:00".into(), end_time: "17:00".into(),
    }).is_err());
    assert!(ai_tasks::create_task_impl(&state, ai_payload(13, 11, 107)).is_err());
    assert!(ai_tasks::create_task_impl(&state, ai_payload(11, 13, 102)).is_err());
    assert_eq!(slot_action(&state, 109), None);
    events::restore_event_impl(&state, 1).unwrap();
    assert!(daily_schedule::assign_slot_action_impl(&state, 109, Some(11)).is_ok());
    // Re-attaching creates a new association while retaining the old result record.
    assert!(ai_tasks::create_task_impl(&state, ai_payload(13, 11, 107)).is_ok());
    assert_eq!(state.db.lock().unwrap().query_row(
        "SELECT result FROM ai_tasks WHERE id=203 AND deleted_at IS NOT NULL", [], |r| r.get::<_, String>(0),
    ).unwrap(), "Keep linked result");
}

#[test]
fn delay_and_restore_are_scoped_to_the_current_space() {
    let state = state();
    {
        let conn = state.db.lock().unwrap();
        let space = current_space_id(&conn).unwrap();
        conn.execute("INSERT INTO local_spaces(space_id,created_at,updated_at) VALUES('other-space',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='other-space' WHERE key='current_space_id'", []).unwrap();
        assert_ne!(current_space_id(&conn).unwrap(), space);
    }
    assert!(events::process_event_at(&state, delay(1, None), now()).is_err());
    assert!(events::restore_event_impl(&state, 1).is_err());
    assert_eq!(slot_action(&state, 104), Some(11));
}

#[test]
fn v21_upgrade_preserves_existing_data_and_defaults_legacy_delay_to_pending() {
    let state = state();
    let before = child_snapshot(&state);
    {
        let mut conn = state.db.lock().unwrap();
        conn.execute("UPDATE events SET status=3,delay_until='2099-10-01',delay_note='Legacy reason' WHERE id=2", []).unwrap();
        conn.execute_batch("ALTER TABLE events DROP COLUMN delay_resume_status;").unwrap();
        conn.pragma_update(None, "user_version", 21).unwrap();
        run_migrations(&mut conn).unwrap();
        run_migrations(&mut conn).unwrap();
        assert_eq!(conn.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0)).unwrap(), migrations::CURRENT_SCHEMA_VERSION);
        assert_eq!(conn.query_row("SELECT delay_note FROM events WHERE id=2", [], |r| r.get::<_, String>(0)).unwrap(), "Legacy reason");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM ai_tasks WHERE deleted_at IS NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
    }
    assert_eq!(event_status(&state, 2), (3, 0));
    assert_eq!(child_snapshot(&state), before);
    assert_eq!(slot_action(&state, 104), Some(11));
    events::restore_event_impl(&state, 2).unwrap();
    assert_eq!(event_status(&state, 2), (0, 0));
}
