const EDITION: &str = "ouyangyu98";

pub fn data_folder(environment: Option<&str>, debug: bool) -> String {
    let value = environment.unwrap_or_default().trim().to_ascii_lowercase();
    let valid = value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    let suffix = if !valid || matches!(value.as_str(), "" | "production" | "prod") {
        if debug {
            format!("{EDITION}-dev")
        } else {
            EDITION.to_string()
        }
    } else if value == EDITION || value.starts_with(&format!("{EDITION}-")) {
        value
    } else {
        format!("{EDITION}-{value}")
    };
    format!("LifePlanTodolist-{suffix}")
}

#[cfg(test)]
mod tests {
    use super::data_folder;

    #[test]
    fn stable_never_uses_upstream_folder() {
        for environment in [None, Some(""), Some("production"), Some("prod"), Some("ouyangyu98")] {
            assert_eq!(data_folder(environment, false), "LifePlanTodolist-ouyangyu98");
        }
    }

    #[test]
    fn existing_personal_development_folder_is_preserved() {
        for environment in [None, Some(""), Some("dev"), Some("ouyangyu98-dev")] {
            assert_eq!(data_folder(environment, true), "LifePlanTodolist-ouyangyu98-dev");
        }
    }

    #[test]
    fn other_channels_stay_inside_the_personal_namespace() {
        assert_eq!(data_folder(Some(" Beta "), false), "LifePlanTodolist-ouyangyu98-beta");
        assert_eq!(data_folder(Some("ouyangyu98-test"), false), "LifePlanTodolist-ouyangyu98-test");
    }

    #[test]
    fn invalid_paths_fall_back_to_the_isolated_folder() {
        for environment in ["../LifePlanTodolist", "test/../../prod", "test\\prod", "."] {
            assert_eq!(data_folder(Some(environment), false), "LifePlanTodolist-ouyangyu98");
        }
    }
}
