use super::{actions, daily_event_pool, daily_list, daily_schedule, event_categories as categories, events, insights, weekly_summary};
use crate::db::{current_space_id, ensure_current_space, migrations, run_migrations, AppState};
use crate::models::*;
use rusqlite::{params, Connection};
use serde_json::json;
use std::sync::Mutex;

fn state() -> AppState {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    ensure_current_space(&mut conn).unwrap();
    AppState { db: Mutex::new(conn), db_path: ":memory:".into(), startup_notice: Mutex::new(None) }
}

fn category(state: &AppState, name: &str) -> EventCategory {
    categories::create_category_impl(state, NewEventCategory { name: name.into(), color: "#13a8a8".into() }).unwrap()
}

fn event(state: &AppState, category_id: Option<i64>) -> Event {
    events::create_event_impl(state, NewEvent { title: "Keep history".into(), category_id }).unwrap()
}

fn edit_event(state: &AppState, id: i64, category_id: Option<i64>) -> Event {
    events::update_event_impl(state, UpdateEvent {
        id, title: "Keep history".into(), target: Some("Do not change completed goal".into()), deadline: None, category_id,
    }).unwrap()
}

#[test]
fn category_create_rename_clear_and_delete_preserve_events() {
    let state = state();
    let work = category(&state, "Work");
    let growth = category(&state, "Growth");
    assert_eq!(work.color, "#13A8A8");
    let e = event(&state, Some(work.id));
    assert_eq!(e.category_name.as_deref(), Some("Work"));
    assert_eq!(edit_event(&state, e.id, Some(growth.id)).category_id, Some(growth.id));
    assert_eq!(edit_event(&state, e.id, None).category_id, None);
    edit_event(&state, e.id, Some(work.id));
    categories::update_category_impl(&state, UpdateEventCategory { id: work.id, name: "Office".into(), color: "#1778FF".into() }).unwrap();
    assert_eq!(events::list_events(&state.db.lock().unwrap()).unwrap()[0].category_name.as_deref(), Some("Office"));
    // Include soft-deleted historical records when deleting a category.
    let deleted = event(&state, Some(work.id));
    state.db.lock().unwrap().execute("UPDATE events SET deleted_at=1 WHERE id=?1", [deleted.id]).unwrap();
    categories::delete_category_impl(&state, work.id).unwrap();
    let conn = state.db.lock().unwrap();
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM events WHERE category_id IS NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 2);
    assert_eq!(events::list_events(&conn).unwrap().len(), 1);
    assert_eq!(categories::list_categories(&conn).unwrap().len(), 1);
}

#[test]
fn category_validation_and_completed_event_classification() {
    let state = state();
    for name in [" ", "123456789012345678901"] {
        assert!(categories::create_category_impl(&state, NewEventCategory { name: name.into(), color: "#1778FF".into() }).is_err());
    }
    let c = category(&state, "Work");
    assert!(categories::create_category_impl(&state, NewEventCategory { name: " Work ".into(), color: "#1778FF".into() }).is_err());
    let e = event(&state, None);
    state.db.lock().unwrap().execute("UPDATE events SET status=5,target='Original',completion_points_awarded=5 WHERE id=?1", [e.id]).unwrap();
    let updated = edit_event(&state, e.id, Some(c.id));
    assert_eq!(updated.category_id, Some(c.id));
    assert_eq!(updated.status, 5);
    assert_eq!(updated.target.as_deref(), Some("Original"));
    assert!(events::create_event_impl(&state, NewEvent { title: "Invalid".into(), category_id: Some(99999) }).is_err());
}

#[test]
fn categories_and_notes_are_space_scoped() {
    let state = state();
    let c = category(&state, "Work");
    let space = current_space_id(&state.db.lock().unwrap()).unwrap();
    insights::save_note_impl(&state, "# First\n\n**Keep me**".into(), space.clone()).unwrap();
    let e = event(&state, Some(c.id));
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('other',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='other' WHERE key='current_space_id'", []).unwrap();
        assert!(categories::list_categories(&conn).unwrap().is_empty());
        assert_eq!(insights::read_note(&conn).unwrap().content, "");
    }
    assert!(categories::delete_category_impl(&state, c.id).is_err());
    assert!(categories::update_category_impl(&state, UpdateEventCategory { id: c.id, name: "Bad".into(), color: "#1778FF".into() }).is_err());
    assert!(events::create_event_impl(&state, NewEvent { title: "Invalid".into(), category_id: Some(c.id) }).is_err());
    let other_event = event(&state, None);
    assert!(events::update_event_impl(&state, UpdateEvent { id: other_event.id, title: "Invalid".into(), target: None, deadline: None, category_id: Some(c.id) }).is_err());
    assert!(insights::save_note_impl(&state, "Wrong space".into(), space.clone()).is_err());
    insights::save_note_impl(&state, "Other note".into(), "other".into()).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE settings SET value=?1 WHERE key='current_space_id'", [space]).unwrap();
        assert_eq!(insights::read_note(&conn).unwrap().content, "# First\n\n**Keep me**");
        assert_eq!(events::list_events(&conn).unwrap()[0].id, e.id);
    }
}

#[test]
fn insights_round_trip_and_clear_keep_one_note() {
    let state = state();
    let space = current_space_id(&state.db.lock().unwrap()).unwrap();
    for content in ["# Heading\n\n**Bold**\n\n- Item\n\n> Quote", "", "Second draft"] {
        insights::save_note_impl(&state, content.into(), space.clone()).unwrap();
        assert_eq!(insights::read_note(&state.db.lock().unwrap()).unwrap().content, content);
    }
    let count: i64 = state.db.lock().unwrap().query_row("SELECT COUNT(*) FROM insights_notes", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn completing_last_child_and_undo_do_not_change_parent_or_points() {
    for status in [1] {
        let state = state();
        let e = event(&state, None);
        state.db.lock().unwrap().execute("UPDATE events SET status=1 WHERE id=?1", [e.id]).unwrap();
        let child = actions::create_action_impl(&state, serde_json::from_value(json!({
            "event_id": e.id, "title": "Child", "estimated_hours": 0, "is_frog": 0,
        })).unwrap()).unwrap();
        state.db.lock().unwrap().execute(
            "UPDATE events SET status=?1,updated_at=123 WHERE id=?2", params![status, e.id],
        ).unwrap();
        let completed = actions::complete_action_impl(&state, child.id).unwrap();
        assert_eq!(completed.status, 1);
        assert!(actions::complete_action_impl(&state, child.id).is_err());
        let restored = actions::restore_action_impl(&state, child.id).unwrap();
        assert_eq!(restored.status, 0);
        let conn = state.db.lock().unwrap();
        let parent: (i32, i64, i64) = conn.query_row(
            "SELECT status,updated_at,completion_points_awarded FROM events WHERE id=?1",
            [e.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(parent, (status, 123, 0));
        let points: i64 = conn.query_row("SELECT COALESCE(SUM(total_points),0) FROM user_points", [], |r| r.get(0)).unwrap();
        assert_eq!(points, 0);
    }
}

#[test]
fn v15_and_v16_upgrade_preserve_history_and_are_repeatable() {
    for version in [15, 16] {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(migrations::INIT_MIGRATION).unwrap();
        let space = ensure_current_space(&mut conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE events DROP COLUMN category_id;
             DROP TABLE event_categories;
             DROP TABLE insights_notes;"
        ).unwrap();
        if version == 15 {
            conn.execute_batch("ALTER TABLE events DROP COLUMN is_quick_completed;").unwrap();
        }
        conn.execute("INSERT INTO events (space_id,sync_id,title,status,target,created_at,updated_at) VALUES (?1,'legacy','Historical',1,'Goal',11,12)", [&space]).unwrap();
        conn.execute("INSERT INTO actions (space_id,sync_id,event_id,title,status,created_at,updated_at) VALUES (?1,'child',1,'Child',1,13,14)", [&space]).unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        run_migrations(&mut conn).unwrap();
        run_migrations(&mut conn).unwrap();
        let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, migrations::CURRENT_SCHEMA_VERSION);
        let events = events::list_events(&conn).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Historical");
        assert_eq!(events[0].target.as_deref(), Some("Goal"));
        assert_eq!(events[0].category_id, None);
        assert_eq!(events[0].completed_action_count, 1);
        assert_eq!(events[0].updated_at, 12);
        assert_eq!(actions::list_actions(&conn).unwrap()[0].updated_at, 14);
        assert_eq!(insights::read_note(&conn).unwrap().content, "");
        assert!(categories::list_categories(&conn).unwrap().is_empty());
        let foreign_key_errors: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(foreign_key_errors, 0);
    }
}

#[test]
fn retired_process_rejected_and_active_abandon_preserves_completed_children() {
    let state = state();
    let e = event(&state, None);
    let retired: ProcessEvent = serde_json::from_value(json!({
        "event_id": e.id, "decision": "delegate"
    })).unwrap();
    assert_eq!(events::process_event_impl(&state, retired).unwrap_err(), "不支持的事件处理方式");
    {
        let conn = state.db.lock().unwrap();
        assert_eq!(events::list_events(&conn).unwrap()[0].status, 0);
        conn.execute("UPDATE events SET status=1,history_note='Preserved history' WHERE id=?1", [e.id]).unwrap();
    }
    let pending = actions::create_action_impl(&state, serde_json::from_value(json!({
        "event_id": e.id, "title": "Pending", "estimated_hours": 0, "is_frog": 0
    })).unwrap()).unwrap();
    let completed = actions::create_action_impl(&state, serde_json::from_value(json!({
        "event_id": e.id, "title": "Completed", "estimated_hours": 1, "is_frog": 0
    })).unwrap()).unwrap();
    actions::complete_action_impl(&state, completed.id).unwrap();
    events::process_event_impl(&state, serde_json::from_value(json!({
        "event_id": e.id, "decision": "abandon", "abandon_reason": "Stopped"
    })).unwrap()).unwrap();
    let conn = state.db.lock().unwrap();
    let e = events::list_events(&conn).unwrap().remove(0);
    assert_eq!(e.status, 4);
    assert_eq!(e.history_note.as_deref(), Some("Preserved history"));
    let children = actions::list_actions(&conn).unwrap();
    assert_eq!(children.iter().find(|a| a.id == pending.id).unwrap().status, 2);
    assert_eq!(children.iter().find(|a| a.id == completed.id).unwrap().status, 1);
}

#[test]
fn migrated_actions_decode_identically_in_daily_readers_and_delete_keeps_parent() {
    let state = state();
    let e = event(&state, None);
    {
        let mut conn = state.db.lock().unwrap();
        let space = current_space_id(&conn).unwrap();
        conn.execute_batch(
            "DROP TABLE ai_tasks;
             ALTER TABLE events ADD COLUMN delegated_to TEXT;
             ALTER TABLE actions ADD COLUMN is_delegated_follow_up INTEGER DEFAULT 0;"
        ).unwrap();
        conn.execute("UPDATE events SET status=2,delegated_to='Historical person',updated_at=123 WHERE id=?1", [e.id]).unwrap();
        conn.execute("INSERT INTO actions (space_id,sync_id,event_id,title,description,estimated_hours,start_date,status,completed_at,sort_order,is_delegated_follow_up,created_at,updated_at) VALUES (?1,'old-child',?2,'Child','Description',1.5,'2026-09-28',1,456,7,1,100,456)", params![space,e.id]).unwrap();
        let id = conn.last_insert_rowid();
        conn.execute("INSERT INTO daily_list_items (space_id,action_id,list_date,sort_order,created_at) VALUES (?1,?2,'2026-09-28',2,100)", params![space,id]).unwrap();
        conn.execute("INSERT INTO daily_schedule_slots (space_id,action_id,list_date,start_time,end_time,created_at,updated_at) VALUES (?1,?2,'2026-09-28','09:00','10:30',100,101)", params![space,id]).unwrap();
        conn.pragma_update(None,"user_version",17).unwrap();
        run_migrations(&mut conn).unwrap();
        let expected = serde_json::to_value(&actions::list_actions(&conn).unwrap()[0]).unwrap();
        assert_eq!(expected, serde_json::to_value(&daily_list::list_items(&conn,"2026-09-28").unwrap()[0].action).unwrap());
        assert_eq!(expected, serde_json::to_value(&daily_schedule::slot_query(&conn,"2026-09-28").unwrap()[0].action).unwrap());
    }
    actions::restore_action_impl(&state, 1).unwrap();
    actions::complete_action_impl(&state, 1).unwrap();
    actions::delete_action_impl(&state, 1).unwrap();
    let conn = state.db.lock().unwrap();
    let parent = events::list_events(&conn).unwrap().remove(0);
    assert_eq!(parent.status, 1);
    assert_eq!(parent.updated_at, 123);
    assert!(parent.history_note.unwrap().contains("Historical person"));
    assert!(actions::list_actions(&conn).unwrap().is_empty());
}

#[test]
fn used_dates_include_plans_and_reviews_but_not_empty_schedule_days() {
    let state = state();
    let event = event(&state, None);
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE events SET status=1 WHERE id=?1", [event.id]).unwrap();
    }
    let action = actions::create_action_impl(&state, serde_json::from_value(json!({
        "event_id": event.id, "title": "Planned", "estimated_hours": 1, "is_frog": 0
    })).unwrap()).unwrap();
    let space = current_space_id(&state.db.lock().unwrap()).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO daily_schedule_days (space_id, list_date, created_at)
             VALUES (?1, '2026-09-25', 1), (?1, '2026-09-26', 1), (?1, '2026-09-27', 1)",
            [&space],
        ).unwrap();
        conn.execute(
            "INSERT INTO daily_schedule_slots
             (space_id, list_date, start_time, end_time, actual_notes, created_at, updated_at)
             VALUES (?1, '2026-09-25', '09:00', '10:00', NULL, 1, 1),
                    (?1, '2026-09-26', '09:00', '10:00', '完成复盘', 1, 1),
                    (?1, '2026-09-27', '09:00', '10:00', NULL, 1, 1)",
            [&space],
        ).unwrap();
        conn.execute(
            "UPDATE daily_schedule_slots
             SET met_expectation = 1
             WHERE list_date = '2026-09-27'",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO daily_list_items (space_id, action_id, list_date, sort_order, created_at)
             VALUES (?1, ?2, '2026-09-28', 1, 1)",
            params![space, action.id],
        ).unwrap();
    }
    let conn = state.db.lock().unwrap();
    assert_eq!(
        daily_schedule::used_dates(&conn).unwrap(),
        vec!["2026-09-26", "2026-09-27", "2026-09-28"]
    );
}

fn drag_state() -> AppState {
    let state = state();
    {
        let conn = state.db.lock().unwrap();
        let space = current_space_id(&conn).unwrap();
        conn.execute(
            "INSERT INTO actions (id,space_id,sync_id,title,status,created_at,updated_at)
             VALUES (101,?1,'drag-a','First',0,1,1),(102,?1,'drag-b','Second',1,1,1)",
            [&space],
        ).unwrap();
        conn.execute(
            "INSERT INTO daily_schedule_slots
             (id,space_id,list_date,start_time,end_time,action_id,actual_notes,met_expectation,focused,created_at,updated_at)
             VALUES (201,?1,'2026-09-28','09:00','10:00',101,'First review',1,0,1,1),
                    (202,?1,'2026-09-28','10:00','11:30',102,'Second review',0,1,1,1),
                    (203,?1,'2026-09-28','13:00','14:00',NULL,NULL,NULL,NULL,1,1),
                    (204,?1,'2026-09-29','09:00','10:00',NULL,NULL,NULL,NULL,1,1)",
            [&space],
        ).unwrap();
    }
    state
}

fn drag_snapshot(state: &AppState) -> serde_json::Value {
    serde_json::to_value(daily_schedule::slot_query(&state.db.lock().unwrap(), "2026-09-28").unwrap()).unwrap()
}

#[test]
fn optional_review_rating_preserves_history_and_accepts_unrated_reviews() {
    let state = drag_state();
    for (id, expected) in [(201, Some(1)), (202, Some(0)), (203, None)] {
        let payload: UpdateDailySlotReview = serde_json::from_value(json!({
            "id": id, "actual_notes": " Updated notes ", "focused": 1,
        })).unwrap();
        let reviewed = daily_schedule::update_review_impl(&state, payload).unwrap();
        assert_eq!(reviewed.actual_notes.as_deref(), Some("Updated notes"));
        assert_eq!(reviewed.focused, Some(1));
        assert_eq!(reviewed.met_expectation, expected);
    }
    for rating in [0, 1] {
        let reviewed = daily_schedule::update_review_impl(&state, UpdateDailySlotReview {
            id: 203, actual_notes: "Explicit rating".into(), focused: 0, met_expectation: Some(rating),
        }).unwrap();
        assert_eq!(reviewed.met_expectation, Some(rating));
        assert_eq!(reviewed.focused, Some(0));
    }
    let before = drag_snapshot(&state);
    for (notes, focused, rating) in [("Invalid", 1, Some(2)), ("Invalid", 2, None), (" \n ", 1, None)] {
        assert!(daily_schedule::update_review_impl(&state, UpdateDailySlotReview {
            id: 201, actual_notes: notes.into(), focused, met_expectation: rating,
        }).is_err());
        assert_eq!(drag_snapshot(&state), before);
    }
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('other',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='other' WHERE key='current_space_id'", []).unwrap();
    }
    assert!(daily_schedule::update_review_impl(&state, UpdateDailySlotReview {
        id: 201, actual_notes: "Wrong space".into(), focused: 1, met_expectation: None,
    }).is_err());
    let notes: String = state.db.lock().unwrap().query_row(
        "SELECT actual_notes FROM daily_schedule_slots WHERE id=201", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(notes, "Updated notes");
}

#[test]
fn drag_swaps_actions_and_all_review_fields_without_changing_times_or_statuses() {
    let state = drag_state();
    let updated = daily_schedule::move_slot_action_impl(&state, "2026-09-28", 201, 202).unwrap();
    assert_eq!(updated.len(), 2);
    assert_eq!(updated[0].action_id, Some(102));
    assert_eq!(updated[0].actual_notes.as_deref(), Some("Second review"));
    assert_eq!(updated[0].met_expectation, Some(0));
    assert_eq!(updated[0].focused, Some(1));
    assert_eq!(updated[0].action.as_ref().unwrap().status, 1);
    assert_eq!(updated[0].start_time, "09:00");
    assert_eq!(updated[0].end_time, "10:00");
    assert_eq!(updated[1].action_id, Some(101));
    assert_eq!(updated[1].actual_notes.as_deref(), Some("First review"));
    assert_eq!(updated[1].met_expectation, Some(1));
    assert_eq!(updated[1].focused, Some(0));
    assert_eq!(updated[1].action.as_ref().unwrap().status, 0);
    assert_eq!(updated[1].start_time, "10:00");
    assert_eq!(updated[1].end_time, "11:30");
}

#[test]
fn drag_to_empty_slot_clears_source_and_preserves_existing_orphan_reviews() {
    let state = drag_state();
    let updated = daily_schedule::move_slot_action_impl(&state, "2026-09-28", 201, 203).unwrap();
    assert_eq!(updated[0].action_id, None);
    assert_eq!(updated[0].actual_notes, None);
    assert_eq!(updated[0].met_expectation, None);
    assert_eq!(updated[0].focused, None);
    assert_eq!(updated[1].action_id, Some(101));
    assert_eq!(updated[1].actual_notes.as_deref(), Some("First review"));
    state.db.lock().unwrap().execute(
        "UPDATE daily_schedule_slots SET actual_notes='Historical review' WHERE id=201", [],
    ).unwrap();
    let updated = daily_schedule::move_slot_action_impl(&state, "2026-09-28", 203, 201).unwrap();
    assert_eq!(updated[0].action_id, Some(101));
    assert_eq!(updated[0].actual_notes.as_deref(), Some("First review"));
    assert_eq!(updated[1].action_id, None);
    assert_eq!(updated[1].actual_notes.as_deref(), Some("Historical review"));
}

#[test]
fn drag_rejects_same_empty_missing_cross_date_and_other_space_slots() {
    let state = drag_state();
    let before = drag_snapshot(&state);
    for (source, target) in [(201, 201), (203, 201), (999, 201), (201, 999), (201, 204)] {
        assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-28", source, target).is_err());
        assert_eq!(drag_snapshot(&state), before);
    }
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('other',1,1)", []).unwrap();
        conn.execute("UPDATE daily_schedule_slots SET space_id='other' WHERE id=202", []).unwrap();
    }
    let before = drag_snapshot(&state);
    assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-28", 201, 202).is_err());
    assert_eq!(drag_snapshot(&state), before);
    state.db.lock().unwrap().execute("UPDATE actions SET deleted_at=1 WHERE id=101", []).unwrap();
    assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-28", 201, 203).is_err());
}

#[test]
fn drag_rolls_back_first_write_when_second_write_fails() {
    let state = drag_state();
    let before = drag_snapshot(&state);
    state.db.lock().unwrap().execute_batch(
        "CREATE TRIGGER fail_second_drag_write BEFORE UPDATE ON daily_schedule_slots
         WHEN OLD.id=202 BEGIN SELECT RAISE(ABORT,'Simulated write failure'); END;",
    ).unwrap();
    assert!(daily_schedule::move_slot_action_impl(&state, "2026-09-28", 201, 202).is_err());
    assert_eq!(drag_snapshot(&state), before);
}

#[test]
fn weekly_summary_uses_planned_main_action_time_and_keeps_notes_per_week() {
    let state = state();
    let work = category(&state, "Work");
    let growth = category(&state, "Growth");
    let work_event = event(&state, Some(work.id));
    let growth_event = event(&state, Some(growth.id));
    state.db.lock().unwrap().execute(
        "UPDATE events SET status=1 WHERE id IN (?1,?2)",
        params![work_event.id, growth_event.id],
    ).unwrap();
    let work_action = actions::create_action_impl(&state, serde_json::from_value(json!({
        "event_id": work_event.id, "title": "Work action", "estimated_hours": 1, "is_frog": 0
    })).unwrap()).unwrap();
    let growth_action = actions::create_action_impl(&state, serde_json::from_value(json!({
        "event_id": growth_event.id, "title": "Growth action", "estimated_hours": 1, "is_frog": 0
    })).unwrap()).unwrap();
    let uncategorized_action = actions::create_action_impl(&state, serde_json::from_value(json!({
        "title": "Personal action", "estimated_hours": 1, "is_frog": 0
    })).unwrap()).unwrap();
    let ignored_action = actions::create_action_impl(&state, serde_json::from_value(json!({
        "title": "Deleted action", "estimated_hours": 1, "is_frog": 0
    })).unwrap()).unwrap();
    let space = current_space_id(&state.db.lock().unwrap()).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO daily_schedule_slots
             (space_id,list_date,start_time,end_time,action_id,sort_order,created_at,updated_at)
             VALUES (?1,'2026-09-28','09:00','10:00',?2,0,1,1),
                    (?1,'2026-09-29','10:00','11:30',?3,1,1,1),
                    (?1,'2026-10-04','23:00','24:00',?4,2,1,1),
                    (?1,'2026-10-04','12:00','13:00',?5,3,1,1),
                    (?1,'2026-10-05','09:00','10:00',?2,4,1,1)",
            params![space, work_action.id, growth_action.id, uncategorized_action.id, ignored_action.id],
        ).unwrap();
        conn.execute("UPDATE actions SET deleted_at=2 WHERE id=?1", [ignored_action.id]).unwrap();
    }

    let summary = weekly_summary::read_summary(&state.db.lock().unwrap(), "2026-09-28").unwrap();
    assert_eq!(summary.total_minutes, 210);
    assert_eq!(summary.categories.iter().map(|category| category.percentage).sum::<f64>(), 100.0);
    assert_eq!(
        summary.categories.iter().map(|category| (&category.name, category.minutes)).collect::<Vec<_>>(),
        vec![(&"Growth".to_string(), 90), (&"未分类".to_string(), 60), (&"Work".to_string(), 60)]
    );
    assert!(weekly_summary::read_summary(&state.db.lock().unwrap(), "2026-09-27").is_err());
    assert!(weekly_summary::read_summary(&state.db.lock().unwrap(), "2026-09-xx").is_err());

    let saved = weekly_summary::save_note_impl(&state, "2026-09-28".into(), "# Keep\n\nThought".into(), space.clone()).unwrap();
    assert_eq!(saved.content, "# Keep\n\nThought");
    weekly_summary::save_note_impl(&state, "2026-09-14".into(), "Older thought".into(), space.clone()).unwrap();
    let records = weekly_summary::list_records(&state.db.lock().unwrap(), None, 12).unwrap();
    assert_eq!(records.iter().map(|record| record.week_start.as_str()).collect::<Vec<_>>(), vec!["2026-10-05", "2026-09-28", "2026-09-14"]);
    assert_eq!(records[0].content, "");
    assert_eq!(records[1].total_minutes, 210);

    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('other',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='other' WHERE key='current_space_id'", []).unwrap();
        assert_eq!(weekly_summary::read_summary(&conn, "2026-09-28").unwrap().total_minutes, 0);
        assert!(weekly_summary::list_records(&conn, None, 12).unwrap().is_empty());
    }
    assert!(weekly_summary::save_note_impl(&state, "2026-09-28".into(), "Wrong space".into(), space).is_err());
}

#[test]
fn weekly_items_deduplicate_arrangements_and_use_local_completion_dates_without_writes() {
    use chrono::{Days, Local, NaiveDate};
    let state = drag_state();
    let monday = NaiveDate::from_ymd_opt(2026, 9, 28).unwrap();
    let boundary = |date: NaiveDate| date.and_hms_opt(0, 0, 0).unwrap()
        .and_local_timezone(Local).earliest().unwrap().timestamp_millis();
    let start = boundary(monday);
    let end = boundary(monday.checked_add_days(Days::new(7)).unwrap());
    {
        let conn = state.db.lock().unwrap();
        let space = current_space_id(&conn).unwrap();
        conn.execute(
            "INSERT INTO actions(id,space_id,sync_id,title,status,completed_at,created_at,updated_at)
             VALUES (103,?1,'week-unscheduled','Unscheduled completion',1,?2,1,1),
                    (104,?1,'week-old','Completed before week',1,?3,1,1),
                    (105,?1,'week-next','Next Monday',1,?4,1,1),
                    (106,?1,'week-restored','Restored',0,?2,1,1),
                    (107,?1,'week-deleted','Deleted',1,?2,1,1),
                    (108,?1,'week-ai','Parallel research',0,NULL,1,1),
                    (109,?1,'week-ai-deleted','Removed attachment',0,NULL,1,1)",
            params![space, start, start - 1, end],
        ).unwrap();
        conn.execute("UPDATE actions SET deleted_at=2 WHERE id=107", []).unwrap();
        conn.execute("UPDATE actions SET status=1,completed_at=?1 WHERE id=102", [end - 1]).unwrap();
        conn.execute(
            "INSERT INTO daily_schedule_slots(id,space_id,list_date,start_time,end_time,action_id,actual_notes,created_at,updated_at)
             VALUES (205,?1,'2026-09-30','13:00','14:00',101,'Second day',1,1),
                    (206,?1,'2026-09-27','13:00','14:00',101,'Before week',1,1),
                    (207,?1,'2026-09-30','14:00','15:00',104,'Old completion arranged again',1,1),
                    (208,?1,'2026-09-30','15:00','16:00',107,'Deleted action',1,1)",
            [&space],
        ).unwrap();
        conn.execute(
            "INSERT INTO ai_tasks(space_id,slot_id,action_id,linked_action_id,list_date,title,result,deleted_at,created_at,updated_at)
             VALUES (?1,201,101,108,'2026-09-28','Parallel research','Result one',NULL,1,1),
                    (?1,205,101,108,'2026-09-30','Parallel research','Result two',NULL,1,1),
                    (?1,201,101,109,'2026-09-28','Removed attachment','',2,1,1)",
            [&space],
        ).unwrap();
    }
    let before = drag_snapshot(&state);
    let conn = state.db.lock().unwrap();
    let summary = weekly_summary::read_summary(&conn, "2026-09-28").unwrap();
    assert_eq!(summary.items.iter().map(|item| item.id).collect::<Vec<_>>(), vec![101, 102, 103, 104, 108]);
    let first = &summary.items[0];
    assert_eq!(first.planned_minutes, 120);
    assert_eq!(first.arrangements.len(), 2);
    assert_eq!(first.arrangements[0].actual_notes.as_deref(), Some("First review"));
    assert_eq!(first.arrangements[1].list_date, "2026-09-30");
    assert_eq!(summary.items.iter().filter(|item| item.completed_in_week).map(|item| item.id).collect::<Vec<_>>(), vec![102, 103]);
    assert_eq!(summary.items[2].arrangements.len(), 0);
    assert!(!summary.items[3].completed_in_week);
    let parallel = summary.items.iter().find(|item| item.id == 108).unwrap();
    assert_eq!(parallel.planned_minutes, 0);
    assert_eq!(parallel.arrangements.len(), 2);
    assert!(parallel.arrangements.iter().all(|entry| entry.parallel));
    assert_eq!(parallel.arrangements[0].actual_notes.as_deref(), Some("Result one"));
    assert_eq!(summary.total_minutes, 270);
    // Completion-only weeks remain reachable from the history even without schedules or notes.
    let records = weekly_summary::list_records(&conn, None, 12).unwrap();
    assert_eq!(records[0].week_start, "2026-10-05");
    assert_eq!(records[0].total_minutes, 0);
    assert!(weekly_summary::read_summary(&conn, "2026-10-05").unwrap().items.iter().any(|item| item.id == 105 && item.completed_in_week));
    drop(conn);
    assert_eq!(drag_snapshot(&state), before);
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE actions SET status=0,completed_at=NULL WHERE id=102", []).unwrap();
        let restored = weekly_summary::read_summary(&conn, "2026-09-28").unwrap();
        assert!(!restored.items.iter().find(|item| item.id == 102).unwrap().completed_in_week);
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('other',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='other' WHERE key='current_space_id'", []).unwrap();
        assert!(weekly_summary::read_summary(&conn, "2026-09-28").unwrap().items.is_empty());
        assert!(weekly_summary::list_records(&conn, None, 12).unwrap().is_empty());
    }
}

#[test]
fn weekly_event_completion_uses_parent_status_not_child_completion_or_edit_dates() {
    let state = drag_state();
    let active = event(&state, None);
    let completed = event(&state, None);
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE events SET status=1 WHERE id=?1", [active.id]).unwrap();
        conn.execute("UPDATE events SET status=5,updated_at=1 WHERE id=?1", [completed.id]).unwrap();
        conn.execute("UPDATE actions SET event_id=?1 WHERE id=101", [active.id]).unwrap();
        conn.execute("UPDATE actions SET event_id=?1 WHERE id=102", [completed.id]).unwrap();
        let summary = weekly_summary::read_summary(&conn, "2026-09-28").unwrap();
        assert!(!summary.items.iter().find(|item| item.id == 101).unwrap().event_completed);
        assert!(summary.items.iter().find(|item| item.id == 102).unwrap().event_completed);
        // Even when every child is completed, only the event's own status is authoritative.
        conn.execute("UPDATE actions SET status=1 WHERE id=101", []).unwrap();
        conn.execute("UPDATE events SET updated_at=?1 WHERE id=?2", params![crate::db::now_millis(), completed.id]).unwrap();
        let summary = weekly_summary::read_summary(&conn, "2026-09-28").unwrap();
        assert!(!summary.items.iter().find(|item| item.id == 101).unwrap().event_completed);
        assert!(summary.items.iter().find(|item| item.id == 102).unwrap().event_completed);
        conn.execute("UPDATE events SET deleted_at=2 WHERE id=?1", [completed.id]).unwrap();
        let summary = weekly_summary::read_summary(&conn, "2026-09-28").unwrap();
        let deleted = summary.items.iter().find(|item| item.id == 102).unwrap();
        assert!(!deleted.event_completed);
        assert!(deleted.event_id.is_none());
    }
}

#[test]
fn daily_event_pool_is_date_scoped_and_removal_preserves_schedule_reviews_and_actions() {
    let state = drag_state();
    let parent = event(&state, None);
    let space = current_space_id(&state.db.lock().unwrap()).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE events SET status=1 WHERE id=?1", [parent.id]).unwrap();
        conn.execute("UPDATE actions SET event_id=?1 WHERE id IN (101,102)", [parent.id]).unwrap();
    }
    let snapshot = drag_snapshot(&state);
    let save = |date: &str, ids: Vec<i64>| daily_event_pool::save_pool(&state, UpdateDailyEventPool {
        space_id: space.clone(), list_date: date.into(), event_ids: ids,
    });
    let pool = save("2026-09-28", vec![parent.id]).unwrap();
    assert_eq!(pool.entries.len(), 1);
    assert_eq!(pool.entries[0].actions.len(), 2);
    assert_eq!(pool.entries[0].actions.iter().filter(|action| action.status == 1).count(), 1);
    assert!(daily_event_pool::read_pool(&state.db.lock().unwrap(), "2026-09-29").unwrap().entries.is_empty());
    assert!(save("2026-09-28", vec![parent.id, parent.id]).is_err());
    assert!(save("2026-02-30", vec![parent.id]).is_err());
    assert!(save("2026-09-28", vec![999999]).is_err());
    assert_eq!(daily_event_pool::read_pool(&state.db.lock().unwrap(), "2026-09-28").unwrap().event_ids, vec![parent.id]);
    assert_eq!(drag_snapshot(&state), snapshot);
    let assigned = daily_event_pool::assign_from_pool(&state, "2026-09-28", &space, 101, 203).unwrap();
    assert_eq!(assigned.action_id, Some(101));
    assert_eq!(assigned.action.as_ref().unwrap().event_title.as_deref(), Some("Keep history"));
    assert!(daily_event_pool::assign_from_pool(&state, "2026-09-28", &space, 101, 204).is_err());
    assert!(daily_event_pool::assign_from_pool(&state, "2026-09-28", &space, 102, 203).is_err());
    let scheduled = drag_snapshot(&state);
    assert!(daily_event_pool::assign_from_pool(&state, "2026-09-28", &space, 101, 201).is_err());
    assert_eq!(drag_snapshot(&state), scheduled);
    save("2026-09-28", vec![]).unwrap();
    assert_eq!(drag_snapshot(&state), scheduled);
    let conn = state.db.lock().unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM actions", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    assert_eq!(conn.query_row("SELECT actual_notes FROM daily_schedule_slots WHERE id=201", [], |row| row.get::<_, String>(0)).unwrap(), "First review");
}

#[test]
fn daily_pool_rejects_stale_spaces_unavailable_events_and_orphan_reviews() {
    let state = drag_state();
    let parent = event(&state, None);
    let space = current_space_id(&state.db.lock().unwrap()).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE actions SET event_id=?1 WHERE id=101", [parent.id]).unwrap();
    }
    let payload = || UpdateDailyEventPool { space_id: space.clone(), list_date: "2026-09-28".into(), event_ids: vec![parent.id] };
    assert!(daily_event_pool::save_pool(&state, payload()).is_err());
    state.db.lock().unwrap().execute("UPDATE events SET status=1 WHERE id=?1", [parent.id]).unwrap();
    daily_event_pool::save_pool(&state, payload()).unwrap();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("UPDATE daily_schedule_slots SET actual_notes='Orphan review' WHERE id=203", []).unwrap();
    }
    assert!(daily_event_pool::assign_from_pool(&state, "2026-09-28", &space, 101, 203).is_err());
    let snapshot = drag_snapshot(&state);
    for status in [3, 4, 5] {
        state.db.lock().unwrap().execute("UPDATE events SET status=?1 WHERE id=?2", params![status, parent.id]).unwrap();
        assert!(daily_event_pool::assign_from_pool(&state, "2026-09-28", &space, 101, 203).is_err());
        // Existing memberships remain readable and removable after event status changes.
        assert_eq!(daily_event_pool::read_pool(&state.db.lock().unwrap(), "2026-09-28").unwrap().entries.len(), 1);
    }
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces(space_id,created_at,updated_at) VALUES('other',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='other' WHERE key='current_space_id'", []).unwrap();
        assert!(daily_event_pool::read_pool(&conn, "2026-09-28").unwrap().entries.is_empty());
    }
    assert!(daily_event_pool::save_pool(&state, payload()).is_err());
    assert!(daily_event_pool::assign_from_pool(&state, "2026-09-28", &space, 101, 203).is_err());
    state.db.lock().unwrap().execute("UPDATE settings SET value=?1 WHERE key='current_space_id'", [&space]).unwrap();
    assert_eq!(drag_snapshot(&state), snapshot);
}

#[test]
fn draft_actions_can_be_prepared_without_starting_and_survive_direct_start_unchanged() {
    let state = state();
    let parent = event(&state, None);
    let make_action = |title: &str| actions::create_action_impl(&state, serde_json::from_value(json!({
        "event_id": parent.id, "title": title, "description": "Keep notes", "estimated_hours": 0.5, "is_frog": 0,
    })).unwrap()).unwrap();
    let first = make_action("First draft step");
    let second = make_action("Second draft step");
    let removable = make_action("Discard this draft step");
    let updated = actions::update_action_impl(&state, UpdateAction {
        id: first.id, title: "Refined first step".into(), description: Some("Keep refined notes".into()),
        estimated_hours: 1.0, start_date: None, deadline: None, is_frog: 0,
    }).unwrap();
    assert_eq!(updated.title, "Refined first step");
    actions::reorder_event_actions_impl(&state, ReorderEventActions {
        event_id: parent.id, action_ids: vec![second.id, first.id, removable.id],
    }).unwrap();
    actions::delete_action_impl(&state, removable.id).unwrap();
    let space = current_space_id(&state.db.lock().unwrap()).unwrap();
    let before = {
        let conn = state.db.lock().unwrap();
        assert_eq!(events::list_events(&conn).unwrap()[0].status, 0);
        assert!(actions::validate_schedulable_event(&conn, &space, first.id).is_err());
        conn.execute("UPDATE events SET target='Keep goal',history_note='Keep historical note',deadline='2026-12-31' WHERE id=?1", [parent.id]).unwrap();
        serde_json::to_value(actions::list_actions(&conn).unwrap()).unwrap()
    };
    events::start_event_impl(&state, parent.id).unwrap();
    {
        let conn = state.db.lock().unwrap();
        let started = &events::list_events(&conn).unwrap()[0];
        assert_eq!(started.status, 1);
        assert_eq!(started.action_count, 2);
        assert_eq!(started.target.as_deref(), Some("Keep goal"));
        assert_eq!(started.history_note.as_deref(), Some("Keep historical note"));
        assert_eq!(started.deadline.as_deref(), Some("2026-12-31"));
        assert_eq!(started.completed_action_count, 0);
        assert_eq!(serde_json::to_value(actions::list_actions(&conn).unwrap()).unwrap(), before);
        actions::validate_schedulable_event(&conn, &space, first.id).unwrap();
    }
    assert!(events::start_event_impl(&state, parent.id).is_err());
    assert_eq!(serde_json::to_value(actions::list_actions(&state.db.lock().unwrap()).unwrap()).unwrap(), before);
}

#[test]
fn starting_empty_drafts_is_allowed_but_invalid_status_foreign_and_deleted_events_are_rejected() {
    let state = state();
    let empty = event(&state, None);
    events::start_event_impl(&state, empty.id).unwrap();
    assert_eq!(events::list_events(&state.db.lock().unwrap()).unwrap()[0].action_count, 0);
    for status in [1, 3, 4, 5] {
        let parent = event(&state, None);
        state.db.lock().unwrap().execute("UPDATE events SET status=?1 WHERE id=?2", params![status, parent.id]).unwrap();
        let before = serde_json::to_value(events::list_events(&state.db.lock().unwrap()).unwrap()).unwrap();
        assert!(events::start_event_impl(&state, parent.id).is_err());
        assert_eq!(serde_json::to_value(events::list_events(&state.db.lock().unwrap()).unwrap()).unwrap(), before);
        if status != 1 {
            assert!(actions::create_action_impl(&state, serde_json::from_value(json!({
                "event_id": parent.id, "title": "Blocked", "estimated_hours": 0, "is_frog": 0,
            })).unwrap()).is_err());
        }
    }
    let deleted = event(&state, None);
    state.db.lock().unwrap().execute("UPDATE events SET deleted_at=1 WHERE id=?1", [deleted.id]).unwrap();
    assert!(events::start_event_impl(&state, deleted.id).is_err());
    assert!(events::start_event_impl(&state, 999999).is_err());
    let foreign = event(&state, None);
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces(space_id,created_at,updated_at) VALUES('draft-other',1,1)", []).unwrap();
        conn.execute("UPDATE settings SET value='draft-other' WHERE key='current_space_id'", []).unwrap();
    }
    assert!(events::start_event_impl(&state, foreign.id).is_err());
    assert_eq!(state.db.lock().unwrap().query_row("SELECT status FROM events WHERE id=?1", [foreign.id], |row| row.get::<_, i32>(0)).unwrap(), 0);
}

#[test]
fn daily_activity_uses_one_local_day_and_keeps_completion_and_arrangements_separate() {
    use chrono::{Days, Local, NaiveDate};
    let state = drag_state();
    let date = NaiveDate::from_ymd_opt(2026, 9, 28).unwrap();
    let midnight = |value: NaiveDate| value.and_hms_opt(0, 0, 0).unwrap()
        .and_local_timezone(Local).earliest().unwrap().timestamp_millis();
    let start = midnight(date);
    let end = midnight(date.checked_add_days(Days::new(1)).unwrap());
    {
        let conn = state.db.lock().unwrap();
        let space = current_space_id(&conn).unwrap();
        conn.execute(
            "INSERT INTO actions(id,space_id,sync_id,title,status,completed_at,created_at,updated_at)
             VALUES (103,?1,'daily-unscheduled','Unscheduled completion',1,?2,1,1),
                    (104,?1,'daily-next-day','Next day completion',1,?3,1,1),
                    (105,?1,'daily-restored','Restored action',0,?2,1,1),
                    (106,?1,'daily-deleted','Deleted action',1,?2,1,1),
                    (107,?1,'daily-ai','Parallel action',0,NULL,1,1)",
            params![space, start, end],
        ).unwrap();
        conn.execute("UPDATE actions SET completed_at=?1 WHERE id=102", [start - 1]).unwrap();
        conn.execute("UPDATE actions SET deleted_at=1 WHERE id=106", []).unwrap();
        conn.execute(
            "INSERT INTO daily_schedule_slots(id,space_id,list_date,start_time,end_time,action_id,created_at,updated_at)
             VALUES (205,?1,'2026-09-28','23:30','24:00',101,1,1),
                    (206,?1,'2026-09-28','14:00','15:00',106,1,1)",
            [&space],
        ).unwrap();
        conn.execute(
            "INSERT INTO ai_tasks(space_id,slot_id,action_id,linked_action_id,list_date,title,result,created_at,updated_at)
             VALUES (?1,201,101,107,'2026-09-28','Parallel action','AI result',1,1)",
            [&space],
        ).unwrap();
    }
    let before = drag_snapshot(&state);
    {
        let conn = state.db.lock().unwrap();
        let items = weekly_summary::read_daily_items(&conn, "2026-09-28").unwrap();
        assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), vec![101, 102, 103, 107]);
        let repeated = items.iter().find(|item| item.id == 101).unwrap();
        assert_eq!(repeated.planned_minutes, 90);
        assert_eq!(repeated.arrangements.len(), 2);
        assert!(repeated.arrangements.iter().all(|entry| entry.list_date == "2026-09-28"));
        assert_eq!(items.iter().filter(|item| item.completed_in_week).map(|item| item.id).collect::<Vec<_>>(), vec![103]);
        assert!(items.iter().find(|item| item.id == 103).unwrap().arrangements.is_empty());
        let parallel = items.iter().find(|item| item.id == 107).unwrap();
        assert_eq!(parallel.planned_minutes, 0);
        assert!(parallel.arrangements[0].parallel);
        assert_eq!(parallel.arrangements[0].actual_notes.as_deref(), Some("AI result"));
        assert!(weekly_summary::read_daily_items(&conn, "2026-02-30").is_err());
        assert!(weekly_summary::read_daily_items(&conn, "2026-9-28").is_err());
        let next = weekly_summary::read_daily_items(&conn, "2026-09-29").unwrap();
        assert!(next.iter().any(|item| item.id == 104 && item.completed_in_week));
        assert!(!next.iter().any(|item| item.id == 103));
        let weekly = weekly_summary::read_summary(&conn, "2026-09-28").unwrap();
        assert!(weekly.items.iter().any(|item| item.id == 104 && item.completed_in_week));
        conn.execute("UPDATE actions SET status=1,completed_at=?1 WHERE id=101", [end - 1]).unwrap();
        assert!(weekly_summary::read_daily_items(&conn, "2026-09-28").unwrap().iter().find(|item| item.id == 101).unwrap().completed_in_week);
        conn.execute("UPDATE actions SET status=0,completed_at=NULL WHERE id=101", []).unwrap();
        assert!(!weekly_summary::read_daily_items(&conn, "2026-09-28").unwrap().iter().find(|item| item.id == 101).unwrap().completed_in_week);
    }
    assert_eq!(drag_snapshot(&state), before);
    let conn = state.db.lock().unwrap();
    conn.execute("INSERT INTO local_spaces(space_id,created_at,updated_at) VALUES('daily-other',1,1)", []).unwrap();
    conn.execute("UPDATE settings SET value='daily-other' WHERE key='current_space_id'", []).unwrap();
    assert!(weekly_summary::read_daily_items(&conn, "2026-09-28").unwrap().is_empty());
}

#[test]
fn weekly_summary_v23_migration_is_repeatable_and_preserves_existing_data() {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    let space = ensure_current_space(&mut conn).unwrap();
    conn.execute(
        "INSERT INTO events (space_id,sync_id,title,status,created_at,updated_at)
         VALUES (?1,'weekly-migration-event','Keep me',1,1,2)",
        [&space],
    ).unwrap();
    conn.execute_batch("DROP TABLE weekly_notes;").unwrap();
    conn.pragma_update(None, "user_version", 23).unwrap();
    run_migrations(&mut conn).unwrap();
    run_migrations(&mut conn).unwrap();
    assert_eq!(conn.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0)).unwrap(), migrations::CURRENT_SCHEMA_VERSION);
    assert_eq!(conn.query_row("SELECT title FROM events WHERE sync_id='weekly-migration-event'", [], |row| row.get::<_, String>(0)).unwrap(), "Keep me");
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM weekly_notes", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}
