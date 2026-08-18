// MSIX virtualization stores the app's AppData under Packages\<family>\LocalCache, invisible to
// Explorer at the plain appLogDir()/appDataDir() paths; resolve_explorer_path maps to the real location.

#[cfg(windows)]
use std::path::Path;

// The helpers stay cfg-free (with allow(dead_code)) so their tests run on non-Windows hosts.
#[allow(dead_code)]
fn derive_family_name(full_name: &str) -> Option<String> {
    let mut segments = full_name.split('_');
    let first_segment = segments.next()?;
    let last_segment = segments.next_back()?;
    if first_segment.is_empty() || last_segment.is_empty() {
        return None;
    }
    Some(format!("{first_segment}_{last_segment}"))
}

#[allow(dead_code)]
fn extract_package_full_name(exe_path: &str) -> Option<String> {
    let mut segments = exe_path.split(['\\', '/']);
    while let Some(segment) = segments.next() {
        if segment.eq_ignore_ascii_case("WindowsApps") {
            return segments.next().map(str::to_string);
        }
    }
    None
}

#[allow(dead_code)]
fn map_virtualized_path(
    input_path: &str,
    localappdata: &str,
    appdata: &str,
    family_name: &str,
) -> Option<String> {
    let localappdata = localappdata.trim_end_matches(['\\', '/']);
    let appdata = appdata.trim_end_matches(['\\', '/']);
    let input_path = input_path.trim_end_matches(['\\', '/']);

    if !localappdata.is_empty() {
        if let Some(remainder) = input_path.strip_prefix(localappdata) {
            let remainder = remainder.trim_start_matches(['\\', '/']);
            return Some(format!(
                "{localappdata}\\Packages\\{family_name}\\LocalCache\\Local\\{remainder}"
            ));
        }
    }
    if !appdata.is_empty() {
        if let Some(remainder) = input_path.strip_prefix(appdata) {
            let remainder = remainder.trim_start_matches(['\\', '/']);
            return Some(format!(
                "{localappdata}\\Packages\\{family_name}\\LocalCache\\Roaming\\{remainder}"
            ));
        }
    }
    None
}

#[cfg(windows)]
fn resolve_store_virtualized_path(path: &str) -> Option<String> {
    let exe_path = std::env::current_exe().ok()?;
    let full_name = extract_package_full_name(&exe_path.to_string_lossy())?;
    let family_name = derive_family_name(&full_name)?;
    let localappdata = std::env::var("LOCALAPPDATA").ok()?;
    let appdata = std::env::var("APPDATA").ok()?;
    let candidate = map_virtualized_path(path, &localappdata, &appdata, &family_name)?;
    Path::new(&candidate).exists().then_some(candidate)
}

#[tauri::command]
pub async fn resolve_explorer_path(path: String) -> String {
    #[cfg(not(windows))]
    {
        path
    }
    #[cfg(windows)]
    {
        if let Some(virtualized_path) = resolve_store_virtualized_path(&path) {
            return virtualized_path;
        }
        if let Ok(canonical) = std::fs::canonicalize(&path) {
            let canonical = canonical.to_string_lossy().into_owned();
            let stripped = canonical.strip_prefix(r"\\?\").unwrap_or(&canonical).to_string();
            if stripped != path && Path::new(&stripped).exists() {
                return stripped;
            }
        }
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_family_name_handles_double_underscore_full_name() {
        let family_name = derive_family_name(
            "InfiniteL8p.XtreamIPTVPlayerLiveTV_1.8.0.0_x64__2dv5prtgrhmr4",
        )
        .unwrap();
        assert_eq!(
            family_name,
            "InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4"
        );
    }

    #[test]
    fn extract_package_full_name_finds_component_after_windows_apps() {
        let full_name = extract_package_full_name(
            r"C:\Program Files\WindowsApps\InfiniteL8p.XtreamIPTVPlayerLiveTV_1.8.0.0_x64__2dv5prtgrhmr4\xtream.exe",
        )
        .unwrap();
        assert_eq!(
            full_name,
            "InfiniteL8p.XtreamIPTVPlayerLiveTV_1.8.0.0_x64__2dv5prtgrhmr4"
        );
    }

    #[test]
    fn map_virtualized_path_maps_local_appdata() {
        let mapped = map_virtualized_path(
            r"C:\Users\test\AppData\Local\com.infinitel8p.xtream\logs",
            r"C:\Users\test\AppData\Local",
            r"C:\Users\test\AppData\Roaming",
            "InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4",
        )
        .unwrap();
        assert_eq!(
            mapped,
            r"C:\Users\test\AppData\Local\Packages\InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4\LocalCache\Local\com.infinitel8p.xtream\logs"
        );
    }

    #[test]
    fn map_virtualized_path_maps_roaming_appdata() {
        let mapped = map_virtualized_path(
            r"C:\Users\test\AppData\Roaming\com.infinitel8p.xtream",
            r"C:\Users\test\AppData\Local",
            r"C:\Users\test\AppData\Roaming",
            "InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4",
        )
        .unwrap();
        assert_eq!(
            mapped,
            r"C:\Users\test\AppData\Local\Packages\InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4\LocalCache\Roaming\com.infinitel8p.xtream"
        );
    }

    #[test]
    fn map_virtualized_path_returns_none_outside_appdata_roots() {
        let mapped = map_virtualized_path(
            r"C:\Users\test\Downloads\somefile.txt",
            r"C:\Users\test\AppData\Local",
            r"C:\Users\test\AppData\Roaming",
            "InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4",
        );
        assert!(mapped.is_none());
    }

    #[test]
    fn map_virtualized_path_tolerates_trailing_slashes() {
        let mapped = map_virtualized_path(
            r"C:\Users\test\AppData\Local\com.infinitel8p.xtream\logs\",
            r"C:\Users\test\AppData\Local\",
            r"C:\Users\test\AppData\Roaming\",
            "InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4",
        )
        .unwrap();
        assert_eq!(
            mapped,
            r"C:\Users\test\AppData\Local\Packages\InfiniteL8p.XtreamIPTVPlayerLiveTV_2dv5prtgrhmr4\LocalCache\Local\com.infinitel8p.xtream\logs"
        );
    }
}
