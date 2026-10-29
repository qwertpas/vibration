"""Build the firmware and package USB and BLE installation images."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
core = Path.home() / ".platformio/penv/bin"
packages = Path.home() / ".platformio/packages"
subprocess.run([str(core / "pio"), "run", "-d", str(root / "firmware")], check=True)
build = root / "firmware/.pio/build/supermini"
destination = root / "docs/firmware"
destination.mkdir(exist_ok=True)
shutil.copyfile(build / "firmware.bin", destination / "app.bin")
subprocess.run([
    str(core / "python"), str(packages / "tool-esptoolpy/esptool.py"),
    "--chip", "esp32s3", "merge-bin", "-o", str(destination / "vibration.bin"),
    "--flash-mode", "dio", "--flash-freq", "80m", "--flash-size", "4MB",
    "0x0", str(build / "bootloader.bin"), "0x8000", str(build / "partitions.bin"),
    "0xe000", str(packages / "framework-arduinoespressif32/tools/partitions/boot_app0.bin"),
    "0x10000", str(build / "firmware.bin"),
], check=True)
data = (destination / "app.bin").read_bytes()
manifest = {
    "name": "Motor Control", "version": hashlib.sha256(data).hexdigest()[:8], "new_install_prompt_erase": False,
    "md5": hashlib.md5(data).hexdigest(), "sha256": hashlib.sha256(data).hexdigest(),
    "builds": [{"chipFamily": "ESP32-S3", "parts": [{"path": "vibration.bin", "offset": 0}]}],
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
