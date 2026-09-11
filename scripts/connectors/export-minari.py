#!/usr/bin/env python3
"""Write and verify a real local Minari dataset from complete Chronograph Arrow episodes."""
import argparse
import importlib.metadata
import json
import os
import pathlib
import re
import numpy as np
import pyarrow.ipc as ipc


def export(source, output, dataset_id="chronograph-gridworld-v0"):
    source, output = pathlib.Path(source), pathlib.Path(output)
    if output.exists() or not re.fullmatch(r"[a-zA-Z0-9_-]+-v[0-9]+", dataset_id):
        raise ValueError("Use a new output directory and a simple versioned dataset ID")
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Expected a regular Arrow handoff no larger than 16 MiB")
    with source.open("rb") as file:
        table = ipc.open_stream(file).read_all()
    metadata = table.schema.metadata or {}
    if metadata.get(b"chronograph.connector") != b"worldmodel-v1":
        raise ValueError("Wrong Arrow connector format")
    mapping = json.loads(metadata[b"chronograph.mapping"])
    records = [json.loads(row) for row in table.column("record_json").to_pylist()]
    if not 2 <= len(records) <= 100_000:
        raise ValueError("Expected 2–100000 reset/step records")
    if not 1 <= mapping["observation_dim"] <= 4096 or not 1 <= mapping["action_count"] <= 1_000_000:
        raise ValueError("Invalid observation/action space")
    groups = {}
    for row in records:
        groups.setdefault(row["episode"], []).append(row)
    for episode, steps in groups.items():
        if not 0 <= episode < mapping["max_episodes"] or len(steps) < 2:
            raise ValueError("Invalid or incomplete episode")
        for index, step in enumerate(steps):
            if step["index"] != index or (index and step["timestamp_us"] <= steps[index-1]["timestamp_us"]):
                raise ValueError("Steps must be contiguous and chronological")
            obs = np.asarray(step["observation"], dtype=np.float64)
            if obs.shape != (mapping["observation_dim"],) or not np.isfinite(obs).all() or not np.isfinite(step["reward"]):
                raise ValueError("Invalid observation/reward")
            if not -(2**63) <= step["timestamp_us"] < 2**63-1:
                raise ValueError("Invalid timestamp")
            if index == 0:
                if step["action"] is not None or step["reward"] != 0 or step["terminated"] or step["truncated"]:
                    raise ValueError("Invalid reset record")
            elif type(step["action"]) is not int or not 0 <= step["action"] < mapping["action_count"]:
                raise ValueError("Invalid discrete action")
            if index < len(steps)-1 and (step["terminated"] or step["truncated"]):
                raise ValueError("Episode continued after completion")
        if not (steps[-1]["terminated"] or steps[-1]["truncated"]):
            raise ValueError("Minari export requires a complete episode")

    output.mkdir(parents=True, exist_ok=False)
    os.environ["MINARI_DATASETS_PATH"] = str(output.resolve())
    import gymnasium as gym
    import minari
    from minari.data_collector import EpisodeBuffer
    environment = None
    if mapping["state_codec"] == "chronograph-gridworld-xorshift64-v1":
        import gridworld_env  # Registers this explicit, committed environment; no dynamic source imports.
        initial = records[0]["state"]
        if mapping["environment_id"] != "ChronographGridWorld-v1" or mapping["action_count"] != 4 or mapping["observation_dim"] != 4:
            raise ValueError("Gridworld codec/mapping mismatch")
        environment = gym.make("ChronographGridWorld-v1", size=initial["size"], horizon=initial["horizon"])
        for row in records:
            obs = environment.unwrapped.restore(row["state"])
            np.testing.assert_array_equal(obs, row["observation"])
    buffers = []
    episode_order = sorted(groups)
    for episode in episode_order:
        steps = groups[episode]
        buffers.append(EpisodeBuffer(
            observations=np.asarray([s["observation"] for s in steps], dtype=np.float64),
            actions=np.asarray([s["action"] for s in steps[1:]], dtype=np.int64),
            rewards=np.asarray([s["reward"] for s in steps[1:]], dtype=np.float64),
            terminations=np.asarray([s["terminated"] for s in steps[1:]], dtype=np.bool_),
            truncations=np.asarray([s["truncated"] for s in steps[1:]], dtype=np.bool_),
            infos={"chronograph_timestamp_us": np.asarray([s["timestamp_us"] for s in steps], dtype=np.int64),
                   "chronograph_state_json": [json.dumps(s["state"], separators=(",", ":")) for s in steps]},
            options={"chronograph_episode": episode},
        ))
    minari.create_dataset_from_buffers(dataset_id, buffers, env=environment,
        observation_space=environment.observation_space if environment else gym.spaces.Box(-np.inf, np.inf, (mapping["observation_dim"],), dtype=np.float64),
        action_space=gym.spaces.Discrete(mapping["action_count"]), data_format="hdf5",
        algorithm_name="chronograph recorded actions", description="Local Chronograph episodes with complete versioned state snapshots",
        requirements=["gymnasium==" + importlib.metadata.version("gymnasium")])
    if environment:
        environment.close()
    loaded = minari.load_dataset(dataset_id, download=False)
    restored = []
    resumed_transitions = 0
    for ordinal, actual in enumerate(loaded.iterate_episodes()):
        original_episode = episode_order[ordinal]
        expected = groups[original_episode]
        np.testing.assert_array_equal(actual.observations, [s["observation"] for s in expected])
        for key, values in (("actions", [s["action"] for s in expected[1:]]), ("rewards", [s["reward"] for s in expected[1:]]),
                            ("terminations", [s["terminated"] for s in expected[1:]]), ("truncations", [s["truncated"] for s in expected[1:]])):
            np.testing.assert_array_equal(getattr(actual, key), values)
        if len(actual.infos["chronograph_state_json"]) != len(expected):
            raise AssertionError("Missing reset/state snapshots")
        for i in range(len(expected)):
            state = json.loads(actual.infos["chronograph_state_json"][i])
            timestamp = int(actual.infos["chronograph_timestamp_us"][i])
            if state != expected[i]["state"] or timestamp != expected[i]["timestamp_us"]:
                raise AssertionError("Minari lost state or timestamp precision")
            restored.append(dict(episode=original_episode, index=i, timestamp_us=timestamp, state=state,
                observation=actual.observations[i].tolist(), action=None if i == 0 else int(actual.actions[i-1]),
                reward=0.0 if i == 0 else float(actual.rewards[i-1]),
                terminated=False if i == 0 else bool(actual.terminations[i-1]),
                truncated=False if i == 0 else bool(actual.truncations[i-1])))
        if environment:
            recovered = loaded.recover_environment()
            for i in range(len(expected)-1):
                recovered.unwrapped.restore(restored[-len(expected)+i]["state"])
                obs, reward, term, trunc, info = recovered.unwrapped.step(int(actual.actions[i]))
                np.testing.assert_array_equal(obs, actual.observations[i+1])
                if (reward, term, trunc, info["state"]) != (float(actual.rewards[i]), bool(actual.terminations[i]), bool(actual.truncations[i]), expected[i+1]["state"]):
                    raise AssertionError("Recovered environment dynamics/RNG differs")
                resumed_transitions += 1
            recovered.close()
    if restored != sorted(records, key=lambda s: (s["episode"], s["index"])):
        raise AssertionError("Full source/Minari comparison differs")
    (output / "roundtrip-steps.json").write_text(json.dumps(restored, indent=2) + "\n")
    report = {"dataset_id": dataset_id, "mapping": mapping, "original_episode_ids": episode_order,
              "episodes": len(groups), "reset_and_step_records": len(records), "transitions": len(records)-len(groups),
              "resumed_transitions": resumed_transitions, "reader_roundtrip": "passed", "minari_version": importlib.metadata.version("minari")}
    (output / "chronograph.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--dataset-id", default="chronograph-gridworld-v0")
    args = parser.parse_args()
    print(json.dumps(export(args.input, args.output, args.dataset_id), indent=2))
