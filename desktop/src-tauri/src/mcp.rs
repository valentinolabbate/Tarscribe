use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use serde_yaml_ng::{Mapping as YamlMap, Value as YamlValue};
use tauri::AppHandle;

use crate::sidecar;

const SERVER_KEY: &str = "tarscribe";
const MCP_MODULE: &str = "tarscribe_backend.mcp_server";

#[derive(Clone)]
struct HostTarget {
    id: &'static str,
    fmt: HostFormat,
    path: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HostFormat {
    Claude,
    Opencode,
    Codex,
    Hermes,
}

#[derive(Serialize)]
pub struct McpRegistrationResult {
    registered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    removed: Option<bool>,
    path: String,
    id: String,
}

#[derive(Serialize)]
struct LaunchCommand {
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Home-Verzeichnis nicht gefunden.".to_string())
}

fn host_targets() -> Result<Vec<HostTarget>, String> {
    let home = home_dir()?;
    #[cfg(target_os = "macos")]
    let claude_desktop = home.join("Library/Application Support/Claude/claude_desktop_config.json");
    #[cfg(target_os = "windows")]
    let claude_desktop = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"))
        .join("Claude/claude_desktop_config.json");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let claude_desktop = home.join(".config/Claude/claude_desktop_config.json");

    Ok(vec![
        HostTarget {
            id: "claude-desktop",
            fmt: HostFormat::Claude,
            path: claude_desktop,
        },
        HostTarget {
            id: "claude-code",
            fmt: HostFormat::Claude,
            path: home.join(".claude.json"),
        },
        HostTarget {
            id: "opencode",
            fmt: HostFormat::Opencode,
            path: home.join(".config/opencode/opencode.json"),
        },
        HostTarget {
            id: "codex",
            fmt: HostFormat::Codex,
            path: home.join(".codex/config.toml"),
        },
        HostTarget {
            id: "hermes",
            fmt: HostFormat::Hermes,
            path: home.join(".hermes/config.yaml"),
        },
    ])
}

fn get_target(target_id: &str) -> Result<HostTarget, String> {
    host_targets()?
        .into_iter()
        .find(|target| target.id == target_id)
        .ok_or_else(|| format!("Unbekannter Agent-Host: {target_id}"))
}

fn launch_command(app: &AppHandle) -> Result<LaunchCommand, String> {
    let python = sidecar::resolve_python(app)
        .ok_or_else(|| "Python-Laufzeit fuer MCP nicht gefunden.".to_string())?;
    let backend = sidecar::backend_source(app)
        .ok_or_else(|| "Backend-Quellen fuer MCP nicht gefunden.".to_string())?;
    let mut env = BTreeMap::new();
    env.insert(
        "PYTHONPATH".to_string(),
        backend.to_string_lossy().to_string(),
    );
    Ok(LaunchCommand {
        command: python.to_string_lossy().to_string(),
        args: vec!["-m".to_string(), MCP_MODULE.to_string()],
        env,
    })
}

fn json_entry(app: &AppHandle, fmt: HostFormat) -> Result<JsonValue, String> {
    let cmd = launch_command(app)?;
    if fmt == HostFormat::Opencode {
        let mut command = Vec::with_capacity(cmd.args.len() + 1);
        command.push(cmd.command);
        command.extend(cmd.args);
        Ok(json!({
            "type": "local",
            "command": command,
            "environment": cmd.env,
            "enabled": true,
        }))
    } else {
        Ok(json!({"command": cmd.command, "args": cmd.args, "env": cmd.env}))
    }
}

fn yaml_entry(app: &AppHandle) -> Result<YamlValue, String> {
    let cmd = launch_command(app)?;
    serde_yaml_ng::to_value(json!({
        "command": cmd.command,
        "args": cmd.args,
        "env": cmd.env,
        "enabled": true,
    }))
    .map_err(|e| e.to_string())
}

fn read_json_object(path: &PathBuf) -> JsonMap<String, JsonValue> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_json_object(path: &PathBuf, data: &JsonMap<String, JsonValue>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn register_json(app: &AppHandle, target: &HostTarget) -> Result<(), String> {
    let mut data = read_json_object(&target.path);
    let key = match target.fmt {
        HostFormat::Claude => "mcpServers",
        HostFormat::Opencode => "mcp",
        _ => return Err("Ungueltiges JSON-MCP-Format.".to_string()),
    };
    if target.fmt == HostFormat::Opencode {
        data.entry("$schema".to_string())
            .or_insert_with(|| json!("https://opencode.ai/config.json"));
    }
    let servers = data
        .entry(key.to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if !servers.is_object() {
        *servers = JsonValue::Object(JsonMap::new());
    }
    servers
        .as_object_mut()
        .expect("server container is object")
        .insert(SERVER_KEY.to_string(), json_entry(app, target.fmt)?);
    write_json_object(&target.path, &data)
}

fn unregister_json(target: &HostTarget) -> Result<bool, String> {
    let mut data = read_json_object(&target.path);
    let key = match target.fmt {
        HostFormat::Claude => "mcpServers",
        HostFormat::Opencode => "mcp",
        _ => return Err("Ungueltiges JSON-MCP-Format.".to_string()),
    };
    let removed = data
        .get_mut(key)
        .and_then(JsonValue::as_object_mut)
        .and_then(|servers| servers.remove(SERVER_KEY))
        .is_some();
    if removed {
        write_json_object(&target.path, &data)?;
    }
    Ok(removed)
}

fn read_yaml_mapping(path: &PathBuf) -> YamlMap {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_yaml_ng::from_str::<YamlValue>(&text).ok())
        .and_then(|value| value.as_mapping().cloned())
        .unwrap_or_default()
}

fn write_yaml_mapping(path: &PathBuf, data: &YamlMap) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_yaml_ng::to_string(data).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn register_yaml(app: &AppHandle, target: &HostTarget) -> Result<(), String> {
    let mut data = read_yaml_mapping(&target.path);
    let key = YamlValue::String("mcp_servers".to_string());
    if data.get(&key).and_then(YamlValue::as_mapping).is_none() {
        data.insert(key.clone(), YamlValue::Mapping(YamlMap::new()));
    }
    let servers = data
        .get_mut(&key)
        .and_then(YamlValue::as_mapping_mut)
        .expect("mcp_servers is mapping");
    servers.insert(YamlValue::String(SERVER_KEY.to_string()), yaml_entry(app)?);
    write_yaml_mapping(&target.path, &data)
}

fn unregister_yaml(target: &HostTarget) -> Result<bool, String> {
    let mut data = read_yaml_mapping(&target.path);
    let key = YamlValue::String("mcp_servers".to_string());
    let server_key = YamlValue::String(SERVER_KEY.to_string());
    let removed = data
        .get_mut(&key)
        .and_then(YamlValue::as_mapping_mut)
        .and_then(|servers| servers.remove(&server_key))
        .is_some();
    if removed {
        write_yaml_mapping(&target.path, &data)?;
    }
    Ok(removed)
}

fn escape_toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn codex_block(app: &AppHandle) -> Result<String, String> {
    let cmd = launch_command(app)?;
    let args = cmd
        .args
        .iter()
        .map(|arg| escape_toml_string(arg))
        .collect::<Vec<_>>()
        .join(", ");
    let env = cmd
        .env
        .iter()
        .map(|(key, value)| format!("{key} = {}", escape_toml_string(value)))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "[mcp_servers.{SERVER_KEY}]\ncommand = {}\nargs = [{args}]\nenv = {{ {env} }}\n",
        escape_toml_string(&cmd.command)
    ))
}

fn strip_codex_block(text: &str) -> (String, bool) {
    let mut lines = Vec::new();
    let mut skipping = false;
    let mut removed = false;
    let block_header = format!("[mcp_servers.{SERVER_KEY}]");
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed == block_header {
            skipping = true;
            removed = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            lines.push(line);
        }
    }
    let mut output = lines.join("\n").trim().to_string();
    if !output.is_empty() {
        output.push('\n');
    }
    (output, removed)
}

fn register_codex(app: &AppHandle, target: &HostTarget) -> Result<(), String> {
    let text = std::fs::read_to_string(&target.path).unwrap_or_default();
    let (mut stripped, _) = strip_codex_block(&text);
    if !stripped.is_empty() {
        stripped.push('\n');
    }
    stripped.push_str(&codex_block(app)?);
    if let Some(parent) = target.path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target.path, stripped).map_err(|e| e.to_string())
}

fn unregister_codex(target: &HostTarget) -> Result<bool, String> {
    let text = std::fs::read_to_string(&target.path).unwrap_or_default();
    let (stripped, removed) = strip_codex_block(&text);
    if removed {
        std::fs::write(&target.path, stripped).map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

#[tauri::command]
pub fn mcp_register_host(
    app: AppHandle,
    target_id: String,
) -> Result<McpRegistrationResult, String> {
    let target = get_target(&target_id)?;
    match target.fmt {
        HostFormat::Claude | HostFormat::Opencode => register_json(&app, &target)?,
        HostFormat::Codex => register_codex(&app, &target)?,
        HostFormat::Hermes => register_yaml(&app, &target)?,
    }
    Ok(McpRegistrationResult {
        registered: true,
        removed: None,
        path: target.path.to_string_lossy().to_string(),
        id: target.id.to_string(),
    })
}

#[tauri::command]
pub fn mcp_unregister_host(target_id: String) -> Result<McpRegistrationResult, String> {
    let target = get_target(&target_id)?;
    let removed = match target.fmt {
        HostFormat::Claude | HostFormat::Opencode => unregister_json(&target)?,
        HostFormat::Codex => unregister_codex(&target)?,
        HostFormat::Hermes => unregister_yaml(&target)?,
    };
    Ok(McpRegistrationResult {
        registered: false,
        removed: Some(removed),
        path: target.path.to_string_lossy().to_string(),
        id: target.id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::strip_codex_block;

    #[test]
    fn strip_codex_block_preserves_other_servers() {
        let text = "[mcp_servers.other]\ncommand = \"z\"\n\n[mcp_servers.tarscribe]\ncommand = \"x\"\nargs = []\n\n[ui]\ntheme = \"dark\"\n";
        let (stripped, removed) = strip_codex_block(text);
        assert!(removed);
        assert!(stripped.contains("[mcp_servers.other]"));
        assert!(stripped.contains("[ui]"));
        assert!(!stripped.contains("[mcp_servers.tarscribe]"));
    }
}
