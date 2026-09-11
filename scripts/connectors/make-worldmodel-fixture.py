#!/usr/bin/env python3
"""Generate source records through an independent Gymnasium environment."""
import json
import pathlib
import sys
from gridworld_env import GridWorld

path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("examples/datasets/worldmodel/steps.json")
if path.exists():
    raise SystemExit(f"Refusing to overwrite {path}")
steps = []
for episode, seed in enumerate((42, 137)):
    env = GridWorld(size=4, horizon=16)
    observation, info = env.reset(seed=seed)
    steps.append(dict(episode=episode, index=0, timestamp_us=episode * 10_000_000, observation=observation.tolist(),
                      action=None, reward=0.0, terminated=False, truncated=False, state=info["state"]))
    for i in range(1, 17):
        action = (0 if env.snapshot()["x"] < 3 else 1) if episode == 0 else 2
        observation, reward, terminated, truncated, info = env.step(action)
        steps.append(dict(episode=episode, index=i, timestamp_us=episode * 10_000_000 + i * 50_000,
                          observation=observation.tolist(), action=action, reward=reward, terminated=terminated,
                          truncated=truncated, state=info["state"]))
        if terminated or truncated:
            break
    env.close()
path.parent.mkdir(parents=True, exist_ok=True)
with path.open("x") as output:
    json.dump(steps, output, indent=2)
    output.write("\n")
print(f"Created {len(steps)} Gymnasium reset/step records across two complete episodes at {path}")
