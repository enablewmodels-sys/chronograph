"""Explicit Gymnasium environment matching the versioned Rust demonstration codec."""
import copy
import gymnasium as gym
import numpy as np


class GridWorld(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, size=4, horizon=16):
        if not 2 <= size <= 1024 or not 1 <= horizon <= 99_999:
            raise ValueError("Invalid size or horizon")
        self.size, self.horizon = size, horizon
        self.action_space = gym.spaces.Discrete(4)
        self.observation_space = gym.spaces.Box(0, size - 1, (4,), dtype=np.float64)
        self._state = None

    def observation(self):
        s = self._state
        return np.array([s["x"], s["y"], s["goal_x"], s["goal_y"]], dtype=np.float64)

    def snapshot(self):
        return copy.deepcopy(self._state)

    def restore(self, snapshot):
        expected = {"size", "x", "y", "goal_x", "goal_y", "rng_state", "steps", "horizon"}
        s = copy.deepcopy(snapshot)
        if set(s) != expected or any(type(v) is not int for v in s.values()):
            raise ValueError("Wrong state codec")
        if s["size"] != self.size or s["horizon"] != self.horizon or not 0 <= s["steps"] <= self.horizon:
            raise ValueError("State/environment mismatch")
        if not 0 < s["rng_state"] < 2**64 or any(not 0 <= s[k] < self.size for k in ("x", "y", "goal_x", "goal_y")):
            raise ValueError("Invalid coordinates or RNG")
        self._state = s
        return self.observation()

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if seed is None:
            seed = 42
        if not 0 < seed < 2**64:
            raise ValueError("This reproducible codec requires a nonzero u64 seed")
        self._state = {"size": self.size, "x": 0, "y": 0, "goal_x": self.size-1, "goal_y": self.size-1,
                       "rng_state": int(seed), "steps": 0, "horizon": self.horizon}
        return self.observation(), {"state": self.snapshot()}

    def step(self, action):
        s = self._state
        if s is None or not self.action_space.contains(action) or s["steps"] >= self.horizon or (s["x"], s["y"]) == (s["goal_x"], s["goal_y"]):
            raise ValueError("Invalid action or finished/uninitialized environment")
        x = s["rng_state"]
        x ^= (x << 13) & (2**64-1)
        x ^= x >> 7
        x ^= (x << 17) & (2**64-1)
        s["rng_state"] = x
        direction = ((x >> 2) & 3) if x & 3 == 0 else int(action)
        if direction == 0:
            s["x"] = min(s["x"]+1, self.size-1)
        elif direction == 1:
            s["y"] = min(s["y"]+1, self.size-1)
        elif direction == 2:
            s["x"] = max(0, s["x"]-1)
        else:
            s["y"] = max(0, s["y"]-1)
        s["steps"] += 1
        terminated = (s["x"], s["y"]) == (s["goal_x"], s["goal_y"])
        truncated = s["steps"] >= self.horizon and not terminated
        return self.observation(), 1.0 if terminated else -0.01, terminated, truncated, {"state": self.snapshot()}


gym.register("ChronographGridWorld-v1", entry_point="gridworld_env:GridWorld")
