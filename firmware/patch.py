"""Piko's changes to the stock xiaozhi-esp32 firmware, applied before the build.

Usage: python3 patch.py <path to a xiaozhi-esp32 checkout>
Every change is a plain text replacement; if the upstream code moved, the
script stops with an error instead of building something half patched.
"""

import json
import sys
from pathlib import Path

root = Path(sys.argv[1])


def replace(path, old, new):
    file = root / path
    text = file.read_text(encoding="utf-8")
    if text.count(old) != 1:
        sys.exit(f"patch failed: expected exactly one match in {path} for:\n{old}")
    file.write_text(text.replace(old, new), encoding="utf-8")
    print(f"patched {path}")


# 1. Start a conversation as soon as the robot is ready. On the 1.85C-BOX neither
#    side button is wired to BOOT, and the wake word is Chinese, so without this
#    nothing starts a conversation.
replace(
    "main/application.cc",
    """void Application::HandleActivationDoneEvent() {
    ESP_LOGI(TAG, "Activation done");

    SystemInfo::PrintHeapStats();
    SetDeviceState(kDeviceStateIdle);
""",
    """void Application::HandleActivationDoneEvent() {
    ESP_LOGI(TAG, "Activation done");

    SystemInfo::PrintHeapStats();
    SetDeviceState(kDeviceStateIdle);
    // Piko: open the conversation right away instead of waiting for a button or wake word.
    ToggleChatState();
""",
)

# 2. English screen text instead of Chinese.
board = root / "main/boards/waveshare/esp32-s3-touch-lcd-1.85c/config.json"
config = json.loads(board.read_text(encoding="utf-8"))
for build in config["builds"]:
    build["sdkconfig_append"] = [*build.get("sdkconfig_append", []), "CONFIG_LANGUAGE_EN_US=y"]
board.write_text(json.dumps(config, indent=4), encoding="utf-8")
print(f"patched {board.relative_to(root)}")
