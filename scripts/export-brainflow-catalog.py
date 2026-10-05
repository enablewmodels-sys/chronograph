#!/usr/bin/env python3
"""Write the console board catalogue from the installed BrainFlow driver.

The console must show exactly what the acquisition agent can record, so this file is
generated from the same catalog the Python source registry uses. Regenerate it after a
BrainFlow upgrade:

    .work/connector-v04-python/bin/python scripts/export-brainflow-catalog.py
"""
import json
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from chronograph_connectors import brainflow_catalog as catalog  # noqa: E402

OUTPUT = ROOT / "ui" / "src" / "brainflow-boards.json"


def main():
    data = catalog.catalog()
    boards = []
    for entry in data["boards"].values():
        board_id = entry["board_id"]
        tries = catalog.presets(board_id) or [entry]
        presets = [
            {
                "preset": item["preset"],
                "name": item["preset_name"],
                "device": item["device_name"],
                "rate": item["sampling_rate"],
                "channels": len(item["primary_rows"]),
                "modality": item["modality"],
            }
            for item in tries
        ]
        boards.append(
            {
                "id": board_id,
                "name": entry["board_name"],
                "device": entry["device_name"],
                "vendor": entry["vendor"],
                "rate": entry["sampling_rate"],
                "channels": len(entry["primary_rows"]),
                "modality": entry["modality"],
                "describable": entry.get("describable", True),
                "channel_names": [str(name) for name in entry["channel_names"]][:24],
                "presets": presets,
            }
        )
    boards.sort(key=lambda board: (board["vendor"], board["name"]))
    document = {
        "generated_by": "scripts/export-brainflow-catalog.py",
        "brainflow_version": data["brainflow_version"],
        "counts": data["counts"],
        "vendors": data["vendors"],
        "transports": sorted(data["transports"]),
        "unavailable_vendors": data["unavailable_vendors"],
        "undocumented": sorted(data["undocumented_boards"]),
        "boards": boards,
    }
    OUTPUT.write_text(json.dumps(document, separators=(",", ":")) + "\n")
    print(
        json.dumps(
            {
                "written": str(OUTPUT.relative_to(ROOT)),
                "bytes": OUTPUT.stat().st_size,
                "brainflow_version": document["brainflow_version"],
                "boards": len(boards),
                "vendors": len(document["vendors"]),
                "transports": len(document["transports"]),
                "unavailable": sorted(document["unavailable_vendors"]),
                "presets": sum(len(board["presets"]) for board in boards),
            }
        )
    )


if __name__ == "__main__":
    main()
