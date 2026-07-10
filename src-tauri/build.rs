use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-env-changed=LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64");
    println!("cargo:rerun-if-changed=../.env.voice");
    let key = env::var("LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(read_voice_env);
    if let Some(key) = key {
        println!("cargo:rustc-env=LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64={}", key.trim());
    } else {
        println!("cargo:warning=Voice manifest public key is not configured; local STT/TTS installation will stay disabled.");
    }
    tauri_build::build()
}

fn read_voice_env() -> Option<String> {
    let path = Path::new("../.env.voice");
    let content = fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        line.trim().strip_prefix("LUCZOR_VOICE_MANIFEST_PUBLIC_KEY_B64=")
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
    })
}
