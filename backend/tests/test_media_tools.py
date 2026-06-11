from __future__ import annotations


from tarscribe_backend import media_tools


def _make_executable(path):
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | 0o111)
    return path


def test_media_tool_path_uses_explicit_env(monkeypatch, tmp_path):
    ffmpeg = _make_executable(tmp_path / "custom-ffmpeg")
    monkeypatch.setenv("TARSCRIBE_FFMPEG_PATH", str(ffmpeg))
    monkeypatch.setenv("PATH", "")

    assert media_tools.media_tool_path("ffmpeg") == str(ffmpeg)


def test_media_tool_path_checks_common_dirs_when_path_is_empty(monkeypatch, tmp_path):
    bin_dir = tmp_path / "homebrew-bin"
    bin_dir.mkdir()
    ffprobe = _make_executable(bin_dir / "ffprobe")
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(media_tools, "COMMON_TOOL_DIRS", (str(bin_dir),))

    assert media_tools.media_tool_path("ffprobe") == str(ffprobe)


def test_media_tool_path_returns_none_for_missing_tool(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", "")
    monkeypatch.delenv("TARSCRIBE_FFMPEG_PATH", raising=False)
    monkeypatch.delenv("TARSCRIBE_FFMPEG", raising=False)
    monkeypatch.setattr(media_tools, "COMMON_TOOL_DIRS", (str(tmp_path),))

    assert media_tools.media_tool_path("ffmpeg") is None
