//! Versioned deterministic gridworld, including an explicitly serialized xorshift64 RNG.
use crate::{Error, Result, StateCodec, Step};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub size: u32,
    pub x: u32,
    pub y: u32,
    pub goal_x: u32,
    pub goal_y: u32,
    pub rng_state: u64,
    pub steps: u64,
    pub horizon: u64,
}
impl State {
    pub fn observation(&self) -> Vec<f64> {
        vec![
            self.x as f64,
            self.y as f64,
            self.goal_x as f64,
            self.goal_y as f64,
        ]
    }
    pub fn terminated(&self) -> bool {
        self.x == self.goal_x && self.y == self.goal_y
    }
    pub fn truncated(&self) -> bool {
        self.steps >= self.horizon && !self.terminated()
    }
    fn validate(&self) -> Result<()> {
        if !(2..=1024).contains(&self.size)
            || [self.x, self.y, self.goal_x, self.goal_y]
                .iter()
                .any(|v| *v >= self.size)
            || self.rng_state == 0
            || !(1..=99_999).contains(&self.horizon)
            || self.steps > self.horizon
        {
            return Err(Error::Invalid(
                "invalid gridworld state, RNG or horizon".into(),
            ));
        }
        Ok(())
    }
}
pub struct Codec;
impl StateCodec for Codec {
    const ID: &'static str = "chronograph-gridworld-xorshift64-v1";
    type State = State;
    fn validate(step: &Step<Self::State>) -> Result<()> {
        step.state.validate()?;
        let reward = if step.index == 0 {
            0.0
        } else if step.state.terminated() {
            1.0
        } else {
            -0.01
        };
        if step.index != step.state.steps
            || step.observation != step.state.observation()
            || step.terminated != step.state.terminated()
            || step.truncated != step.state.truncated()
            || step.reward != reward
            || step.action.is_some_and(|v| v >= 4)
        {
            return Err(Error::Invalid(
                "gridworld snapshot does not match observation, reward, action or step flags"
                    .into(),
            ));
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Environment {
    state: State,
}
impl Environment {
    pub fn new(size: u32, seed: u64, horizon: u64) -> Result<Self> {
        Self::from_state(State {
            size,
            x: 0,
            y: 0,
            goal_x: size.saturating_sub(1),
            goal_y: size.saturating_sub(1),
            rng_state: seed,
            steps: 0,
            horizon,
        })
    }
    pub fn from_state(state: State) -> Result<Self> {
        state.validate()?;
        Ok(Self { state })
    }
    pub fn state(&self) -> &State {
        &self.state
    }
    pub fn reset_record(&self, episode: u64, timestamp_us: i64) -> Result<Step<State>> {
        if self.state.steps != 0 {
            return Err(Error::Invalid(
                "reset record requires a new environment".into(),
            ));
        }
        Ok(Step {
            episode,
            index: 0,
            timestamp_us,
            observation: self.state.observation(),
            action: None,
            reward: 0.0,
            terminated: false,
            truncated: false,
            state: self.state.clone(),
        })
    }
    /// Four actions: right, down, left, up. One quarter of steps slip to an RNG-selected direction.
    /// This is a reproducible simulator, not a cryptographic generator or a physics engine.
    pub fn step(&mut self, action: u32, episode: u64, timestamp_us: i64) -> Result<Step<State>> {
        if action >= 4
            || self.state.terminated()
            || self.state.truncated()
            || timestamp_us == i64::MAX
        {
            return Err(Error::Invalid(
                "invalid action/time or finished environment".into(),
            ));
        }
        let mut x = self.state.rng_state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state.rng_state = x;
        let direction = if x & 3 == 0 {
            ((x >> 2) & 3) as u32
        } else {
            action
        };
        match direction {
            0 => self.state.x = (self.state.x + 1).min(self.state.size - 1),
            1 => self.state.y = (self.state.y + 1).min(self.state.size - 1),
            2 => self.state.x = self.state.x.saturating_sub(1),
            _ => self.state.y = self.state.y.saturating_sub(1),
        }
        self.state.steps += 1;
        Ok(Step {
            episode,
            index: self.state.steps,
            timestamp_us,
            observation: self.state.observation(),
            action: Some(action),
            reward: if self.state.terminated() { 1.0 } else { -0.01 },
            terminated: self.state.terminated(),
            truncated: self.state.truncated(),
            state: self.state.clone(),
        })
    }
}
