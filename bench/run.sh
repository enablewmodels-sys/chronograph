#!/bin/sh
set -eu
# Run from the workspace root. Existing datasets are never silently overwritten.
cargo build --release --workspace --bins --examples
cargo run --release -p chronograph-db --example world_model
cargo run --release -p chronograph-db --example bci_stream
cargo run --release -p chronograph-bench --bin measure -- --export
cargo bench --workspace --bench engine
# Additional independent runs; set CHRONOGRAPH_BENCH_DB to preserve each dataset.
CHRONOGRAPH_BENCH_DB=bench/data/single-ordered.cgraph cargo run --release -p chronograph-bench --bin measure -- --single --ingest-only
CHRONOGRAPH_BENCH_DB=bench/data/batch-shuffled.cgraph cargo run --release -p chronograph-bench --bin measure -- --shuffled --ingest-only
CHRONOGRAPH_BENCH_DB=bench/data/single-shuffled.cgraph cargo run --release -p chronograph-bench --bin measure -- --single --shuffled --ingest-only
