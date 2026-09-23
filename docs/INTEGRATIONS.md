# Platform integration recipes

ChronoDB stores temporal relationships and immutable binary assets. Producers own acquisition, model inference, simulators and quantum execution. Connector presets describe validated ingestion contracts; selecting a preset does not install a driver, load a checkpoint or authenticate to an upstream cloud service.

Use the [SDK guide](SDK.md) to connect and [schema migrations](SCHEMA.md) to configure a binding. The live catalog supplies 36 presets across 18 connectors. Raw HTTP and MCP consumers can implement any of these contracts without Python.

## Support matrix

| Ecosystem | Local producer / contract | Verification and boundary |
| --- | --- | --- |
| I-JEPA, V-JEPA, JEPA-WMs | `jepa()` uploads latent/extra tensors, checkpoint and optional action | Existing NumPy/PyTorch output fixtures; checkpoint loading and upstream model quality are outside scope |
| Hierarchical JEPA | `hierarchical_jepa()` with levels, parents and prediction horizons | Generic hierarchy contract; does not assume a particular H-JEPA architecture |
| NumPy, PyTorch, ONNX outputs | `model_outputs()` → `model-output/tensors-v1` | Named tensor/endian fixtures; run ONNX or other inference locally and pass its numeric outputs |
| Gymnasium, Minari | `transition()`; existing Gridworld/Minari converter | Existing runtime fixtures; arbitrary simulator restoration needs a complete state and RNG codec |
| Physical AI, Isaac, MuJoCo | `transition()` → `physical-ai/transition-v1` | Normalized transition fixture only; no Isaac/MuJoCo runtime or hardware control certification |
| BrainFlow / OpenBCI | `brainflow()` converts an already acquired board matrix | BrainFlow 5.22.2 synthetic board tested; physical board drivers and transports remain the caller's responsibility |
| Lab Streaming Layer | `lsl_chunk()` converts `pull_chunk()` output | pylsl 1.18.2/liblsl 1.17.7 local stream fixture; explicit local timestamps, no automatic Unix conversion |
| MNE, EDF/BDF/FIF | `eeg()` / `eeg_file()` | Existing MNE 1.13 fixtures; recorded data, not clinical interpretation |
| ROS 2 / MCAP | `ros_message()` for decoded dictionaries and media | Decoded-image fixture; native Rust bag reader remains JointState-only |
| LeRobot 2.1 / 3 | `lerobot()` on an opened official dataset | Existing LeRobot 0.6.1/PyTorch fixture, including decoded image tensors; no dataset MP4 writer |
| Qiskit / OpenQASM | `qiskit_circuit()`, `qiskit_result()` | Existing Qiskit 2.5.2 circuit/result fixtures; `qiskit_result` accepts the legacy `Result` interface |
| Cirq | `cirq_circuit()`, `cirq_result()` | Existing Cirq 1.6.1 local circuit/measurement fixtures |
| Q# / QDK / QIR | Python host, `qsharp_result()`, `quantum_source()` | QDK 1.32.3 local Bell simulation; source/QIR are opaque artifacts, not server execution |
| PennyLane / Braket / other quantum hosts | `quantum_counts()` or `quantum_observables()` → `quantum-results` | Portable result contract tested; upstream provider sessions, SDK result extraction and QPU execution are not implemented |
| Other runtimes | `record()` → `custom/record-v1` plus named assets | Versioned extension contract; supply your own local converter and tests |

## World models and physical AI

```python
from chronograph_connectors.adapters import model_outputs, transition

# Caller ran inference. `outputs` is a dictionary of NumPy/PyTorch tensors.
observation = model_outputs(client, outputs, model="my-world-model",
    checkpoint="sha256:my-checkpoint-digest", src="1", dst="2", timestamp_us="0")
client.ingest("model_observations", "run_1", "0", [observation])

# Caller stepped an environment. `obs` is an array or a dict of arrays.
step = transition(client, obs, action, reward, terminated, truncated,
    src="2", dst="3", timestamp_us="20000", episode="episode_1")
client.ingest("robot_transitions", "episode_1", "0", [step])
```

Create separate bindings for `model-output/tensors-v1` and `physical-ai/transition-v1`. Time is simulation microseconds in this example. Named model outputs use stable `output_N` asset keys and retain original dotted names in `fields.output_names`. Do not infer physical causality or executable simulator state from an observation tensor alone. To support replay, pass `state` bytes and a versioned `state_codec` that includes every simulator/RNG component needed to resume.

## BCI streams and clocks

```python
from chronograph_connectors.adapters import lsl_chunk

# inlet is owned by your acquisition process; configure its stream explicitly.
samples, timestamps = inlet.pull_chunk(timeout=1.0, max_samples=1024)
if timestamps:
    record = lsl_chunk(client, samples, timestamps,
        channels=["C3", "C4"], units=["uV", "uV"], src="10", dst="11",
        source_id="your-stable-source-id")
    # Enqueue with Spool for durable retries rather than restarting sequence 0.
    spool.enqueue([record])
    spool.drain(client)
```

Configure the `lsl/signal-v1` binding with `clock_domain: "lsl_local_us"` and the exact channel names and units. The adapter transposes sample-major input into `[channels, samples]`, preserves all floating-point source timestamps as a separate tensor, and indexes the record at the first timestamp in microseconds. It rejects non-monotonic/non-finite timestamps, mismatched dimensions and oversized chunks. It does not correct clocks, resample, filter artifacts or guess physical units. Apply an explicit calibrated clock transformation before combining streams in another domain.

For BrainFlow, pass the already acquired `board.get_board_data()` matrix to `brainflow()`, including `board_id`, channel names and units. Default row selection uses BrainFlow's EEG rows for the default preset; provide `channel_indices` for another signal type. Timestamps use BrainFlow's Unix-seconds convention. For physical boards, validate timestamp semantics, calibration, channel ordering and loss handling with that board's driver before use. Emit separate `lsl/gap-v1` records when acquisition detects missing samples; never manufacture samples to hide a gap.

The database does not provide clinical device control or a patient-facing diagnostic function. See [BCI acquisition details](connectors/bci.md).

## ROS messages and media

```python
from chronograph_connectors.adapters import ros_message

record = ros_message(client,
    {"height": height, "width": width, "step": step,
     "encoding": encoding, "is_bigendian": is_bigendian,
     "header": {"frame_id": frame_id}},
    message_type="sensor_msgs/msg/Image", topic="/camera/image",
    binary={"pixels": image_bytes}, src="20", dst="21", timestamp_us=stamp_us)
```

The message mapping must already be decoded locally; use your ROS or rosbags runtime to produce it. Keep coordinate frames, dimensions, strides, encoding and source timestamps. Store large binary fields in named assets instead of JSON integer arrays. The database retains these fields without pretending to decode CDR, MCAP or every ROS message. See [robotics native readers](connectors/robotics.md) for the narrower file-import path.

## Quantum hosts

Run the included Q# example from a virtual environment with the Python SDK and QDK installed:

```sh
python -m pip install ./sdk/python qdk==1.32.3
# Set CHRONOGRAPH_URL and CHRONOGRAPH_TOKEN through your normal secret mechanism.
# Create a qsharp/result-v1 binding with simulation_us clock first.
export CHRONOGRAPH_INSTANCE=qsharp_results
export CHRONOGRAPH_SPOOL=/private/qsharp-producer-state
python sdk/qsharp/host.py
```

The trusted local `Bell.qs` entry point returns `Int[]` bits. The Python host runs it with QDK, converts simulated shot arrays into exact counts, then persists a normalized record using the durable spool. Q# does not open a network connection. The simulator backend and bit ordering are recorded. Upload source separately through `quantum_source()` with `encoding="qsharp"`, or pass caller-compiled QIR bytes with an explicit encoding and provenance. No uploaded source is executed.

Portable counts from another runtime:

```python
from chronograph_connectors.adapters import quantum_counts

# Extract counts in your provider process. Values must be integer frequencies.
record = quantum_counts({"00": 512, "11": 488},
    basis="Z; bit order q0,q1 left-to-right", runtime="external-provider",
    backend="your-backend-id", job_id="your-job-id",
    src="30", dst="31", timestamp_us="0")
client.ingest("quantum_counts", "experiment_1", "0", [record])
```

Use `quantum-results/counts-v1` for integer frequencies and `observables-v1` for named finite expectation values. Quasi-probabilities, negative weights and probabilities are not shot counts. Preserve their type and normalization explicitly in a custom contract instead. No quantum SDK credentials belong in graph fields, asset provenance or migration `secret_refs`; only reference secret **names**, resolved by the external producer.

## Add a producer

A new producer needs a deterministic record mapping, declared clock and units, bounded asset conversion, durable sequence ownership and a fixture that roundtrips the original values. Start with the custom preset, then add a dedicated server validator only when the format's invariants are known. Add its descriptor to the Rust registry so migration dropdowns and MCP discover it automatically. Update the generated OpenAPI contract, support matrix and `scripts/sdk` tests together.

## TypeSafe Jev

Use the [Jev integration guide](JEV.md) for Python/TypeScript decision bindings,
Choice/Score/Noul validation, an explicit input-attachment option and runnable
examples. The migration dropdown exposes `jev` / `decisions-v1` under Decision
models. JEPA tensor integrations are separate.
