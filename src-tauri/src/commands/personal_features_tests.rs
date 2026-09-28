use super::{actions, daily_list, daily_schedule, event_categories as categories, events, insights};
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
            "ALTER TABLE events ADD COLUMN delegated_to TEXT;
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
