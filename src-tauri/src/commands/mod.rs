pub mod actions;
pub mod ai_tasks;
pub mod analytics;
pub mod daily_list;
pub mod daily_schedule;
pub mod event_categories;
pub mod events;
pub mod insights;
pub mod pomodoro;
pub mod recurring_actions;
pub mod rewards;
pub mod system;
pub mod weekly_summary;

#[cfg(test)]
mod legacy_priority_tests;

#[cfg(test)]
mod personal_features_tests;

#[cfg(test)]
mod ai_tasks_tests;

#[cfg(test)]
mod event_delays_tests;
