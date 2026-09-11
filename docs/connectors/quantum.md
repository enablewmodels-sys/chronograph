# Quantum circuit and calibration mapping — EXPLORATORY

`chronograph-conn-quantum` maps a documented static OpenQASM 3 subset to a circuit dependency graph and stores time-bounded calibration records. It does not simulate amplitudes, transpile circuits, choose hardware gates, estimate quantum fidelity or execute a QPU job.

## Accepted source subset

The adapter uses the [Qiskit project's OpenQASM lexer and AST](https://github.com/Qiskit/openqasm3_parser), then lowers only these forms:

- An explicit `OPENQASM 3.0;` header.
- Optional `include "stdgates.inc";` before the qubit declaration. This recognizes the [standard gate library](https://openqasm.com/language/standard_library.html); it never opens an include path.
- One `qubit q;` or `qubit[N] q;` declaration, with 1–64 qubits and an ASCII name that does not shadow a supported gate or mathematical constant.
- `h`, `x`, `y`, `z`, `s`, `sdg`, `t`, `tdg`, `rx`, `ry`, `rz`, `cx`, `cz`, `swap` after the standard include; built-in `U` also works without it.
- Static single-qubit indices; scalar registers can be used without an index. Operands within one gate must be distinct. Gate arity and parameter counts are checked.
- Finite signed numeric parameters, `pi`, and `pi/n` for a finite nonzero numeric divisor. Parameters are radians represented as f64; symbolic expressions are not evaluated generally.

Sources are limited to 256 KiB, 4096 operations, 128 tokens per statement and 16 levels of delimiters. Comments and whitespace are retained in the source. The source is lexed and bounded before AST parsing. Unsupported measurements, classical variables/logic, control flow, custom gates, defcal blocks, modifiers, register broadcasting, barriers, timing instructions and additional includes return explicit errors. This is a unitary circuit preparation subset, not general OpenQASM compliance.

## Circuit graph

Use `examples/datasets/quantum/mapping.toml` and reserve its circuit/operation namespace. Qubit and device nodes can be shared with calibration data. Six distinct relationship kinds are configured:

| Relationship | Meaning |
| --- | --- |
| MANIFEST: circuit → device | References the source and lowered circuit in an immutable Arrow sidecar |
| USES: circuit → declared qubit | Preserves every declared qubit, including unused ones |
| CONTAINS: circuit → operation | Operation order is encoded by `operation_base + index` |
| ACTS_ON: operation → qubit | Operand membership; ordered operands and parameters live in the sidecar |
| PRECEDES: prior operation → operation | One dependency per distinct immediately previous operation on a shared qubit |
| COUPLED_TO: qubit → qubit | Directed calibration window, described below |

The dependency edges always point from a lower operation index to a higher index. Independent operations are not artificially serialized. The entire static graph is ingested atomically at one timestamp through `Graph::add_edges`; its edges are open-ended. The complete typed circuit, original source and normalized parameters are in an Arrow sidecar under `data/sidecars/quantum/`. See the [shared sidecar format](robotics.md#arrow-sidecars-and-durability). Ingestion verifies the supplied `Circuit` against a fresh parse of its source, and rejects occupied circuit/operation nodes. Use a new mapping for another circuit.

`export_circuit` verifies the sidecar and every expected topology relationship, including validity and payload references, before returning the original source and circuit. `export_arrow` emits a standard Arrow IPC-compatible record batch. The committed example has three qubits, five operations and twenty graph edges; its operation predecessor lists are `[], [], [0], [2], [1,3]`.

## Calibration drift

`Calibration` contains source/target qubit indices, a half-open `[valid_from,valid_to)` window in the mapping's explicit microsecond clock, error probability in `[0,1]`, and positive gate duration in nanoseconds. The inline payload contains two little-endian f64 values: error probability and duration. This is supplied calibration data, not a fitted prediction of drift.

`ingest_calibrations` validates up to 10,000 windows, then calls the public `Graph::add_edges_bounded` API. That API commits each end with its start in the same atomic batch; a crash cannot leave a calibration open merely because a separate invalidation was not reached. It reuses the checked v2 journal representation and requires no format migration. Call `graph.sync()` or use `Durability::Fsync` for durable acknowledgement.

Uncalibrated gaps are real gaps in `as_of`/`neighbors`: a `[100,200)` window is absent at `200`. Late arrivals use the engine's truncation rule; an overlapping later acquisition shortens the earlier window, and a future window bounds the new one. A shortened version never resumes after the newer window ends. `export_calibrations` preserves effective historical intervals, including empty equal-time corrections. It does not reconstruct an overwritten window's original requested end. If acquisition provenance for that original bound is needed, retain the source calibration dataset alongside the graph.

## Run and verify

```sh
cargo run --locked -p chronograph-conn-quantum --example quantum_connector
cargo test --locked -p chronograph-conn-quantum
```

The fixture is in `examples/datasets/quantum/`: TOML mapping, source OpenQASM and calibration JSON. Tests check the expected circuit dependencies, source → graph → reopen → Arrow comparison, graph tampering, real calibration gaps, atomic invalid-input rejection, exact payloads and late-window shortening. Negative tests cover unsupported programs, wrong arities, duplicate/out-of-range qubits, include paths, nonfinite parameters and deep nesting. The core also property-tests bounded insertion batches against a brute-force temporal model.

PENDING: broader OpenQASM semantics, measurement/classical dependency graphs, pulse programs, live calibration providers, physical-qubit assignment and QPU execution. No hardware or quantum-runtime interoperability claim follows from these mapping tests.
