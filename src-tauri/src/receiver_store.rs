// Persistence for TV receiver mode's paired devices, at `{app_config_dir}/receiver.json`.

use std::path::Path;

use serde::{Deserialize, Serialize};

const STORE_FILE_NAME: &str = "receiver.json";
pub const MAX_PAIRED_DEVICES: usize = 16;
pub const MAX_DEVICE_NAME_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub key: String,
    pub device_name: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    v: u32,
    devices: Vec<PairedDevice>,
}

fn is_valid_key(key: &str) -> bool {
    key.len() == 32 && key.chars().all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn is_valid_device(device: &PairedDevice) -> bool {
    // Pairing bounds by chars(); count chars here too, not bytes, or multi-byte names get dropped.
    is_valid_key(&device.key) && device.device_name.chars().count() <= MAX_DEVICE_NAME_LEN
}

/// Tolerant parse: corrupt JSON or an unknown schema version yields an empty list.
pub fn parse_devices(contents: &str) -> Vec<PairedDevice> {
    match serde_json::from_str::<StoreFile>(contents) {
        Ok(file) if file.v == 1 => file.devices.into_iter().filter(is_valid_device).collect(),
        _ => Vec::new(),
    }
}

pub fn load(config_dir: &Path) -> Vec<PairedDevice> {
    match std::fs::read_to_string(config_dir.join(STORE_FILE_NAME)) {
        Ok(contents) => parse_devices(&contents),
        Err(_) => Vec::new(),
    }
}

pub fn save(config_dir: &Path, devices: &[PairedDevice]) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let file = StoreFile { v: 1, devices: devices.to_vec() };
    let contents = serde_json::to_string(&file).unwrap_or_else(|_| r#"{"v":1,"devices":[]}"#.to_string());
    std::fs::write(config_dir.join(STORE_FILE_NAME), contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(key: &str, name: &str) -> PairedDevice {
        PairedDevice {
            key: key.to_string(),
            device_name: name.to_string(),
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn save_and_load_round_trips_devices() {
        let dir = std::env::temp_dir().join(format!("xt-receiver-store-test-{}", std::process::id()));
        let devices = vec![device("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "Ludo's phone")];
        save(&dir, &devices).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded, devices);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_devices_returns_empty_for_corrupt_json() {
        assert_eq!(parse_devices("not json"), Vec::new());
    }

    #[test]
    fn parse_devices_returns_empty_for_wrong_version() {
        let contents = r#"{"v":2,"devices":[{"key":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4","deviceName":"Phone","createdAt":"2026-01-01T00:00:00+00:00"}]}"#;
        assert_eq!(parse_devices(contents), Vec::new());
    }

    #[test]
    fn parse_devices_drops_entries_with_an_invalid_key() {
        let contents = r#"{"v":1,"devices":[{"key":"not-hex","deviceName":"Phone","createdAt":"2026-01-01T00:00:00+00:00"},{"key":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4","deviceName":"Phone","createdAt":"2026-01-01T00:00:00+00:00"}]}"#;
        let devices = parse_devices(contents);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].key, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
    }

    #[test]
    fn parse_devices_keeps_a_multibyte_name_at_the_char_limit() {
        let name: String = "\u{00fc}".repeat(MAX_DEVICE_NAME_LEN);
        assert_eq!(name.chars().count(), MAX_DEVICE_NAME_LEN);
        assert!(name.len() > MAX_DEVICE_NAME_LEN);
        let contents = format!(
            r#"{{"v":1,"devices":[{{"key":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4","deviceName":"{name}","createdAt":"2026-01-01T00:00:00+00:00"}}]}}"#
        );
        let devices = parse_devices(&contents);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_name, name);
    }

    #[test]
    fn parse_devices_drops_entries_with_an_oversized_name() {
        let oversized_name = "x".repeat(MAX_DEVICE_NAME_LEN + 1);
        let contents = format!(
            r#"{{"v":1,"devices":[{{"key":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4","deviceName":"{oversized_name}","createdAt":"2026-01-01T00:00:00+00:00"}}]}}"#
        );
        assert_eq!(parse_devices(&contents), Vec::new());
    }
}
