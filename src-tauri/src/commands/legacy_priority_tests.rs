use super::{actions, events, recurring_actions};
use crate::db::{ensure_current_space, run_migrations, AppState};
use crate::models::*;
use rusqlite::{params, Connection};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::Mutex;

fn state() -> AppState {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    ensure_current_space(&mut conn).unwrap();
    AppState {
        db: Mutex::new(conn),
        db_path: ":memory:".into(),
        startup_notice: Mutex::new(None),
    }
}

fn payload<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn new_event(state: &AppState) -> i64 {
    events::create_event_impl(state, NewEvent { title: "Test".into(), category_id: None })
        .unwrap()
        .id
}

fn metadata(state: &AppState, table: &str, id: i64) -> (i32, i32, i32) {
    assert!(["events", "actions", "recurring_actions"].contains(&table));
    state.db.lock().unwrap().query_row(
        &format!("SELECT importance, urgency, priority FROM {table} WHERE id = ?1"),
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap()
}

fn legacy_metadata(state: &AppState, table: &str, id: i64) {
    assert!(["events", "actions", "recurring_actions"].contains(&table));
    state.db.lock().unwrap().execute(
        &format!("UPDATE {table} SET importance=1, urgency=1, priority=1 WHERE id=?1"),
        [id],
    ).unwrap();
}

#[test]
fn editing_event_preserves_legacy_metadata_and_does_not_touch_actions() {
    let state = state();
    let id = new_event(&state);
    assert_eq!(metadata(&state, "events", id), (0, 0, 4));
    legacy_metadata(&state, "events", id);
    state.db.lock().unwrap().execute("UPDATE events SET status=1 WHERE id=?1", [id]).unwrap();
    let action = actions::create_action_impl(&state, payload(json!({
        "event_id": id, "title": "Child", "estimated_hours": 0.5, "is_frog": 0
    }))).unwrap();
    state.db.lock().unwrap().execute(
        "UPDATE actions SET importance=0, urgency=1, priority=3, updated_at=123 WHERE id=?1",
        [action.id],
    ).unwrap();
    let event = events::update_event_impl(&state, payload(json!({
        "id": id, "title": "Renamed", "target": "Goal",
        "importance": -99, "urgency": 42
    }))).unwrap();
    assert_eq!(event.title, "Renamed");
    assert_eq!(event.target.as_deref(), Some("Goal"));
    assert_eq!(metadata(&state, "events", id), (1, 1, 1));
    assert_eq!(metadata(&state, "actions", action.id), (0, 1, 3));
    let updated: i64 = state.db.lock().unwrap()
        .query_row("SELECT updated_at FROM actions WHERE id=?1", [action.id], |row| row.get(0))
        .unwrap();
    assert_eq!(updated, 123);

    state.db.lock().unwrap().execute("UPDATE events SET status=5 WHERE id=?1", [id]).unwrap();
    let completed = events::update_event_impl(&state, payload(json!({
        "id": id, "title": "Completed title", "target": "Must not change"
    }))).unwrap();
    assert_eq!(completed.target.as_deref(), Some("Goal"));
    assert_eq!(metadata(&state, "events", id), (1, 1, 1));
}

#[test]
fn processing_events_does_not_inherit_or_recalculate_priority() {
    for decision in ["self", "delegate"] {
        let state = state();
        let id = new_event(&state);
        legacy_metadata(&state, "events", id);
        events::process_event_impl(&state, payload(json!({
            "event_id": id, "decision": decision, "title": "Processed",
            "action_steps": [{"title": "Step", "estimated_hours": 0.5, "start_date": "2026-09-28"}],
            "delegated_to": "Test person", "follow_up_date": "2026-09-29",
            "importance": 1, "urgency": 1
        }))).unwrap();
        assert_eq!(metadata(&state, "events", id), (1, 1, 1));
        let actions = actions::list_actions(&state.db.lock().unwrap()).unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!((actions[0].importance, actions[0].urgency, actions[0].priority), (0, 0, 4));
    }
}

#[test]
fn quick_completion_preserves_metadata_without_creating_actions() {
    let state = state();
    let id = new_event(&state);
    legacy_metadata(&state, "events", id);
    events::process_event_impl(&state, payload(json!({
        "event_id": id, "decision": "self", "title": "Quick",
        "quick_complete": true, "action_steps": []
    }))).unwrap();
    assert_eq!(metadata(&state, "events", id), (1, 1, 1));
    let conn = state.db.lock().unwrap();
    assert!(actions::list_actions(&conn).unwrap().is_empty());
    let status: i32 = conn.query_row("SELECT status FROM events WHERE id=?1", [id], |r| r.get(0)).unwrap();
    assert_eq!(status, 5);
}

#[test]
fn action_creation_ignores_old_inputs_and_editing_preserves_old_values() {
    let state = state();
    let action = actions::create_action_impl(&state, payload(json!({
        "title": "Action", "estimated_hours": 0.5, "start_date": "2026-09-28",
        "is_frog": 0, "importance": 1, "urgency": 1
    }))).unwrap();
    assert_eq!(metadata(&state, "actions", action.id), (0, 0, 4));
    legacy_metadata(&state, "actions", action.id);
    let edited = actions::update_action_impl(&state, payload(json!({
        "id": action.id, "title": "Edited", "estimated_hours": 1.0,
        "start_date": "2026-09-29", "is_frog": 0, "importance": 0, "urgency": 0
    }))).unwrap();
    assert_eq!(edited.title, "Edited");
    assert_eq!(edited.start_date.as_deref(), Some("2026-09-29"));
    assert_eq!(metadata(&state, "actions", action.id), (1, 1, 1));
}

#[test]
fn recurring_edits_preserve_metadata_but_instances_do_not_inherit_it() {
    let state = state();
    let recurring = recurring_actions::create_recurring_action_impl(&state, payload(json!({
        "title": "Recurring", "estimated_hours": 0.5, "is_frog": 0,
        "frequency_unit": "daily", "frequency_count": 1, "importance": 1, "urgency": 1
    }))).unwrap();
    assert_eq!(metadata(&state, "recurring_actions", recurring.id), (0, 0, 4));
    legacy_metadata(&state, "recurring_actions", recurring.id);
    let edited = recurring_actions::update_recurring_action_impl(&state, payload(json!({
        "id": recurring.id, "title": "Edited", "estimated_hours": 1.0, "is_frog": 0,
        "frequency_unit": "weekly", "frequency_count": 2, "importance": 0, "urgency": 0
    }))).unwrap();
    assert_eq!(edited.frequency_unit, "weekly");
    assert_eq!(edited.frequency_count, 2);
    assert_eq!(metadata(&state, "recurring_actions", recurring.id), (1, 1, 1));
    let action = recurring_actions::create_action_from_recurring_impl(&state, recurring.id).unwrap();
    assert_eq!(metadata(&state, "actions", action.id), (0, 0, 4));
    assert_eq!(action.title, "Edited");
}

#[test]
fn event_edit_remains_scoped_to_current_space() {
    let state = state();
    let id = new_event(&state);
    {
        let conn = state.db.lock().unwrap();
        conn.execute("INSERT INTO local_spaces (space_id,created_at,updated_at) VALUES ('other',1,1)", []).unwrap();
        conn.execute("UPDATE events SET space_id='other' WHERE id=?1", params![id]).unwrap();
    }
    let result = events::update_event_impl(&state, payload(json!({"id": id, "title": "Wrong space"})));
    assert!(result.is_err());
}
