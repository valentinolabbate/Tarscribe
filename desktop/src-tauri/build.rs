fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .cpp(true)
            .flag("-std=c++17")
            .flag("-fobjc-arc")
            .file("native/system_audio_capture.mm")
            .compile("tarscribe_system_audio_capture");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rerun-if-changed=native/system_audio_capture.mm");
    }
    tauri_build::build()
}
