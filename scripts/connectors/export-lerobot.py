#!/usr/bin/env python3
"""Convert a checked Chronograph Arrow handoff with the official LeRobot v3 writer. Local only."""
import argparse
import importlib.metadata
import json
import os
import pathlib

# This exporter never uploads or downloads a dataset, token or video.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
import numpy as np
import pyarrow.ipc as ipc
from lerobot.datasets.lerobot_dataset import LeRobotDataset


def export(input_path, output_path, repo_id="local/chronograph", task="Chronograph robotics replay", dtype="float64"):
    input_path, output_path = pathlib.Path(input_path), pathlib.Path(output_path)
    if output_path.exists():
        raise ValueError(f"Refusing to replace {output_path}")
    if not input_path.is_file() or input_path.is_symlink() or input_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Handoff must be a regular Arrow file no larger than 16 MiB")
    with input_path.open("rb") as stream:
        table = ipc.open_stream(stream).read_all()
    metadata = table.schema.metadata or {}
    if metadata.get(b"chronograph.connector") != b"lerobot-handoff-v1":
        raise ValueError("Wrong Arrow handoff version")
    mapping = json.loads(metadata[b"chronograph.mapping"])
    frames = [json.loads(row) for row in table.column("record_json").to_pylist()]
    if not 1 <= len(frames) <= 100_000:
        raise ValueError("Expected 1–100000 frames")
    fps = mapping["fps"]
    if not isinstance(fps, int) or not 1 <= fps <= 1000:
        raise ValueError("Invalid frame rate")
    names = frames[0]["joint_names"]
    if not 1 <= len(names) <= 4096 or len(set(names)) != len(names):
        raise ValueError("Invalid joint names")
    dtype = np.dtype(dtype)
    if dtype not in (np.dtype("float32"), np.dtype("float64")):
        raise ValueError("Expected float32 or float64")
    origin = frames[0]["timestamp_us"]
    for i, frame in enumerate(frames):
        if frame["timestamp_us"] != origin + i * 1_000_000 // fps or frame["joint_names"] != names:
            raise ValueError("Handoff must have a uniform grid and stable joint names/order")
        for role in ("observation", "action"):
            values = np.asarray(frame[role], dtype=dtype)
            if values.shape != (len(names),) or not np.isfinite(values).all():
                raise ValueError("Invalid/overflowing state or action vector")
            if not 0 <= frame[role + "_time_ns"] <= frame["timestamp_us"] * 1000:
                raise ValueError("Frame contains a future/invalid sensor timestamp")
        for video in frame["video"]:
            path = pathlib.PurePosixPath(video["path"])
            if path.is_absolute() or ".." in path.parts or "\\" in video["path"] or ":" in video["path"]:
                raise ValueError("Unsafe video reference")
            if len(video["sha256"]) != 64 or any(c not in "0123456789abcdefABCDEF" for c in video["sha256"]):
                raise ValueError("Invalid video checksum")
    features = {
        "observation.state": {"dtype": dtype.name, "shape": (len(names),), "names": names},
        "action": {"dtype": dtype.name, "shape": (len(names),), "names": names},
        "chronograph.timestamp_us": {"dtype": "int64", "shape": (1,), "names": None},
        "chronograph.observation_time_ns": {"dtype": "int64", "shape": (1,), "names": None},
        "chronograph.action_time_ns": {"dtype": "int64", "shape": (1,), "names": None},
        "chronograph.video_refs": {"dtype": "string", "shape": (1,), "names": None},
    }
    dataset = LeRobotDataset.create(repo_id=repo_id, root=output_path, fps=fps, features=features,
                                    robot_type="chronograph-joint-state", use_videos=False)
    for frame in frames:
        dataset.add_frame({
            "observation.state": np.asarray(frame["observation"], dtype=dtype),
            "action": np.asarray(frame["action"], dtype=dtype),
            "chronograph.timestamp_us": np.array([frame["timestamp_us"]], dtype=np.int64),
            "chronograph.observation_time_ns": np.array([frame["observation_time_ns"]], dtype=np.int64),
            "chronograph.action_time_ns": np.array([frame["action_time_ns"]], dtype=np.int64),
            "chronograph.video_refs": json.dumps(frame["video"], separators=(",", ":")),
            "task": task,
        })
    dataset.save_episode()
    dataset.finalize()
    provenance = {"format": "chronograph-lerobot-provenance-v1", "mapping": mapping,
                  "source_origin_us": origin, "vector_dtype": dtype.name,
                  "lerobot_version": importlib.metadata.version("lerobot"),
                  "video_policy": "external references with original path/time/checksum; no automatic decoding or copying",
                  "delta_timestamps": {"observation.state": [-1 / fps, 0.0], "action": [0.0, 1 / fps]}}
    (output_path / "meta" / "chronograph.json").write_text(json.dumps(provenance, indent=2) + "\n")
    # Reopen through the real reader and compare every numeric value and video reference.
    loaded = LeRobotDataset(repo_id, root=output_path, download_videos=False, token=False)
    if len(loaded) != len(frames):
        raise AssertionError("LeRobot frame count differs")
    for i, expected in enumerate(frames):
        actual = loaded[i]
        for feature, key in (("observation.state", "observation"), ("action", "action")):
            np.testing.assert_array_equal(actual[feature].numpy().reshape(-1), np.asarray(expected[key], dtype=dtype))
        for key in ("timestamp_us", "observation_time_ns", "action_time_ns"):
            if actual["chronograph." + key].item() != expected[key]:
                raise AssertionError("Timestamp lost precision")
        if json.loads(actual["chronograph.video_refs"]) != expected["video"]:
            raise AssertionError("Video reference changed")
    temporal = LeRobotDataset(repo_id, root=output_path, download_videos=False, token=False,
                              delta_timestamps=provenance["delta_timestamps"])
    for i, expected in enumerate(frames):
        row = temporal[i]
        np.testing.assert_array_equal(row["observation.state"].numpy().reshape(2, -1),
            np.asarray([frames[max(0, i - 1)]["observation"], expected["observation"]], dtype=dtype))
        np.testing.assert_array_equal(row["action"].numpy().reshape(2, -1),
            np.asarray([expected["action"], frames[min(len(frames) - 1, i + 1)]["action"]], dtype=dtype))
        if bool(row["observation.state_is_pad"][0]) != (i == 0) or bool(row["action_is_pad"][1]) != (i == len(frames)-1):
            raise AssertionError("Unexpected temporal boundary padding")
    return {"frames": len(frames), "features": list(features), "dtype": dtype.name,
            "reader_roundtrip": "passed", "delta_timestamps": "passed", "output": str(output_path)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--repo-id", default="local/chronograph")
    parser.add_argument("--task", default="Chronograph robotics replay")
    parser.add_argument("--dtype", choices=("float32", "float64"), default="float64")
    args = parser.parse_args()
    print(json.dumps(export(args.input, args.output, args.repo_id, args.task, args.dtype), indent=2))
