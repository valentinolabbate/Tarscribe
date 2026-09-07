from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REVISION = "49b2befec6fc19256931517a5f7b526f485286f5"


def main():
    parser = argparse.ArgumentParser(description="Lokale BitNet-CPU-Laufzeit bauen")
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args()
    if args.destination is None:
        from tarscribe_backend.ml.asr.bitnet_backend import bitnet_binary

        args.destination = bitnet_binary()
    args.destination = args.destination.resolve()
    cmake = shutil.which("cmake")
    if not cmake:
        raise SystemExit("CMake fehlt. Installiere cmake in der Backend-Entwicklungsumgebung.")
    if args.destination.exists():
        raise SystemExit("Ziel existiert bereits; bitte einen neuen --destination-Pfad wählen.")
    with tempfile.TemporaryDirectory(prefix="tarscribe-bitnet-build-") as temp:
        source = Path(temp) / "source"
        subprocess.run(
            [
                "git",
                "clone",
                "https://github.com/microsoft/VibeASR.cpp.git",
                str(source),
            ],
            check=True,
        )
        subprocess.run(["git", "-C", str(source), "checkout", "--detach", REVISION], check=True)
        subprocess.run(
            ["git", "-C", str(source), "submodule", "update", "--init", "--recursive"],
            check=True,
        )
        build = source / "build"
        subprocess.run(
            [
                cmake,
                "-S",
                str(source),
                "-B",
                str(build),
                "-DCMAKE_BUILD_TYPE=Release",
                "-DBUILD_SHARED_LIBS=OFF",
                "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
                "-DGGML_NATIVE=OFF",
                "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0",
            ],
            check=True,
        )
        subprocess.run(
            [
                cmake,
                "--build",
                str(build),
                "--target",
                "asr_stream_server",
                "--parallel",
                "4",
            ],
            check=True,
        )
        args.destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(build / "bin" / "asr_stream_server", args.destination)
        notices = args.destination.parent / "licenses"
        notices.mkdir(exist_ok=True)
        for name, directory in (("vibeasr", source), ("llama", source / "3rdparty/llama.cpp")):
            shutil.copy2(directory / "LICENSE", notices / (name + "-LICENSE"))
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(directory),
                    "archive",
                    "--format=tar.gz",
                    "--output=" + str(notices / (name + "-source.tar.gz")),
                    "HEAD",
                ],
                check=True,
            )
        if sys.platform == "darwin":
            subprocess.run(
                ["codesign", "--force", "--sign", "-", str(args.destination)], check=True
            )
        print(f"BitNet bereit: {args.destination}")


if __name__ == "__main__":
    main()
