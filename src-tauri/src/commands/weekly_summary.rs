use crate::db::{current_space_id, now_millis};
use crate::models::{WeeklyCategoryDuration, WeeklyRecord, WeeklySummary};
use crate::AppState;
use chrono::{Datelike, NaiveDate, Weekday};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

const SLOT_MINUTES: &str = "
    (CASE WHEN s.end_time = '24:00' THEN 1440
          ELSE CAST(SUBSTR(s.end_time, 1, 2) AS INTEGER) * 60 + CAST(SUBSTR(s.end_time, 4, 2) AS INTEGER)
     END) -
    (CASE WHEN s.start_time = '24:00' THEN 1440
          ELSE CAST(SUBSTR(s.start_time, 1, 2) AS INTEGER) * 60 + CAST(SUBSTR(s.start_time, 4, 2) AS INTEGER)
     END)
";

fn validate_week_start(value: &str) -> Result<(), String> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| "周起始日期格式无效".to_string())?;
    if date.weekday() != Weekday::Mon {
        return Err("周总结需从周一开始".into());
    }
    Ok(())
}

fn read_note(conn: &Connection, space_id: &str, week_start: &str) -> Result<(String, i64), String> {
    conn.query_row(
        "SELECT content, updated_at FROM weekly_notes WHERE space_id=?1 AND week_start=?2",
        params![space_id, week_start],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| error.to_string())
    .map(|note| note.unwrap_or((String::new(), 0)))
}

fn week_statistics(conn: &Connection, space_id: &str, week_start: &str) -> Result<(i64, Vec<WeeklyCategoryDuration>), String> {
    let query = format!(
        "SELECT e.category_id,
                COALESCE(c.name, '未分类'),
                COALESCE(c.color, '#8C98A5'),
                SUM({SLOT_MINUTES})
         FROM daily_schedule_slots s
         JOIN actions a ON a.id=s.action_id AND a.space_id=s.space_id AND a.deleted_at IS NULL
         LEFT JOIN events e ON e.id=a.event_id AND e.space_id=a.space_id AND e.deleted_at IS NULL
         LEFT JOIN event_categories c ON c.id=e.category_id AND c.space_id=s.space_id
         WHERE s.space_id=?1 AND s.list_date>=?2 AND s.list_date<date(?2, '+7 days')
         GROUP BY e.category_id, c.name, c.color
         HAVING SUM({SLOT_MINUTES}) > 0
         ORDER BY SUM({SLOT_MINUTES}) DESC, e.category_id"
    );
    let mut statement = conn.prepare(&query).map_err(|error| error.to_string())?;
    let mut categories: Vec<WeeklyCategoryDuration> = statement
        .query_map(params![space_id, week_start], |row| {
            Ok(WeeklyCategoryDuration {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                minutes: row.get(3)?,
                percentage: 0.0,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    let total_minutes = categories.iter().map(|category| category.minutes).sum::<i64>();
    if total_minutes > 0 {
        let shares: Vec<f64> = categories
            .iter()
            .map(|category| category.minutes as f64 * 1000.0 / total_minutes as f64)
            .collect();
        let mut tenths: Vec<i64> = shares.iter().map(|share| share.floor() as i64).collect();
        let remaining = 1000 - tenths.iter().sum::<i64>();
        let mut order: Vec<(usize, f64)> = shares
            .iter()
            .enumerate()
            .map(|(index, share)| (index, share - share.floor()))
            .collect();
        order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        for (index, _) in order.into_iter().take(remaining.max(0) as usize) {
            tenths[index] += 1;
        }
        for (category, share) in categories.iter_mut().zip(tenths) {
            category.percentage = share as f64 / 10.0;
        }
    }
    Ok((total_minutes, categories))
}

pub(super) fn read_summary(conn: &Connection, week_start: &str) -> Result<WeeklySummary, String> {
    validate_week_start(week_start)?;
    let space_id = current_space_id(conn).map_err(|error| error.to_string())?;
    let (content, updated_at) = read_note(conn, &space_id, week_start)?;
    let (total_minutes, categories) = week_statistics(conn, &space_id, week_start)?;
    Ok(WeeklySummary {
        space_id,
        week_start: week_start.into(),
        content,
        updated_at,
        total_minutes,
        categories,
    })
}

#[tauri::command]
pub fn get_weekly_summary(state: State<'_, AppState>, week_start: String) -> Result<WeeklySummary, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    read_summary(&conn, &week_start)
}

#[tauri::command]
pub fn save_weekly_note(
    state: State<'_, AppState>,
    week_start: String,
    content: String,
    space_id: String,
) -> Result<WeeklySummary, String> {
    save_note_impl(&state, week_start, content, space_id)
}

pub(super) fn save_note_impl(
    state: &AppState,
    week_start: String,
    content: String,
    space_id: String,
) -> Result<WeeklySummary, String> {
    validate_week_start(&week_start)?;
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    if space_id != current_space_id(&conn).map_err(|error| error.to_string())? {
        return Err("当前空间已改变，请重新打开周总结".into());
    }
    let updated_at = now_millis();
    conn.execute(
        "INSERT INTO weekly_notes (space_id, week_start, content, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(space_id, week_start) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at",
        params![space_id, week_start, content, updated_at],
    )
    .map_err(|error| error.to_string())?;
    read_summary(&conn, &week_start)
}

#[tauri::command]
pub fn list_weekly_records(
    state: State<'_, AppState>,
    before_week_start: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<WeeklyRecord>, String> {
    let conn = state.db.lock().map_err(|error| error.to_string())?;
    list_records(&conn, before_week_start.as_deref(), limit.unwrap_or(12))
}

pub(super) fn list_records(
    conn: &Connection,
    before_week_start: Option<&str>,
    limit: i64,
) -> Result<Vec<WeeklyRecord>, String> {
    if let Some(week_start) = before_week_start {
        validate_week_start(week_start)?;
    }
    if !(1..=48).contains(&limit) {
        return Err("历史周数范围无效".into());
    }
    let space_id = current_space_id(conn).map_err(|error| error.to_string())?;
    let before = before_week_start.unwrap_or("9999-12-27");
    let mut statement = conn
        .prepare(
            "WITH weeks AS (
                SELECT week_start FROM weekly_notes
                WHERE space_id=?1 AND TRIM(content)<>''
                UNION
                SELECT date(s.list_date, printf('-%d days', (CAST(strftime('%w', s.list_date) AS INTEGER) + 6) % 7))
                FROM daily_schedule_slots s
                JOIN actions a ON a.id=s.action_id AND a.space_id=s.space_id AND a.deleted_at IS NULL
                WHERE s.space_id=?1
            )
            SELECT w.week_start,
                   COALESCE(n.content, ''),
                   COALESCE(n.updated_at, 0)
            FROM weeks w
            LEFT JOIN weekly_notes n ON n.space_id=?1 AND n.week_start=w.week_start
            WHERE w.week_start<?2
            ORDER BY w.week_start DESC
            LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let seeds: Vec<(String, String, i64)> = statement
        .query_map(params![space_id, before, limit], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    seeds
        .into_iter()
        .map(|(week_start, content, updated_at)| {
            let (total_minutes, _) = week_statistics(conn, &space_id, &week_start)?;
            Ok(WeeklyRecord { week_start, content, updated_at, total_minutes })
        })
        .collect()
}
