# Chronograph log format v3

All integer fields use little-endian encoding. There is no native Rust struct
casting, pointer serialization, architecture-dependent `usize`, or zero-copy
deserialization. The legacy version-1 decoder is checked against an independently encoded fixture
at `crates/chronograph-core/tests/fixtures/v1.cgraph`; tests migrate it to a new
version-3 file and verify the original bytes are unchanged.

## File header

| Bytes | Field |
|---|---|
| 8 | ASCII `CHROGRPH` |
| 4 | File format version (`3`, `u32`) |

## Frames

| Bytes | Field |
|---|---|
| 4 | `length: u32`, body plus trailing checksum, excluding these first eight bytes |
| 4 | Bitwise complement of `length`, to detect damaged lengths before trusting them |
| 2 | Record schema version (`3`, `u16`) |
| 2 | Explicit record tag (`u16`, table below) |
| 4 | Reserved flags (`0`, `u32`) |
| variable | Explicit fixed-width payload |
| 4 | CRC-32/IEEE over record version, tag, flags and payload |

`length` must be between 12 and 67,108,864 inclusive. The checksum and length
complement detect accidental damage; they are not cryptographic authentication.
The complement prevents a corrupted interior length from swallowing later valid
records and being mistaken for a torn trailing append.

Payloads use a checked, explicit little-endian codec. No Bincode dependency is
required. Counts are validated against remaining bytes before allocation; invalid
option tags, unknown flags/versions and trailing bytes are rejected. Frame tags
select the record type. Version 1 uses the same documented primitive field layout,
but is accepted only through explicit source-preserving migration, never ordinary
open. The new version reserves independent evolution of the checked codec.

| Tag | Payload |
|---|---|
| 1 | Explicit node registration: `NodeId(u64)` |
| 2 | One `Insert` |
| 3 | `EdgeId(u64), valid_to(i64)` |
| 4 | Count (`u64`) followed by that many `Insert` values |
| 5 | Fork creation: ID (`u64`), parent revision (`u64`), snapshot time (`i64`), UTF-8 name byte count (`u32`) and bytes (1–80) |
| 6 | Fork ID (`u64`), new isolated node ID (`u64`) |
| 7 | Fork ID (`u64`), count (`u64`), branch-local `Insert` values |
| 8 | Fork ID (`u64`), branch-local edge ID (`u64`), shortened end (`i64`) |
| 9 | Discard: fork ID (`u64`) |
| 10 | Atomic merge: fork ID (`u64`), node-map count (`u64`), `(branch u64, parent u64)` pairs, insert count (`u64`), parent `Insert` values, invalidation count (`u64`), `(parent edge u64, end i64)` pairs |

An `Insert` contains, in order:

1. `id: u64`, `src: u64`, `dst: u64`, `kind: u16`.
2. `valid_from: i64`, `valid_to: i64`, `payload: [u8; 16]`.
3. Optional predecessor: one byte (`0` or `1`), followed by `u64` when present.

An edge is 58 serialized bytes; an insert is 59 or 67. The frame supplies its ID
and final end at the moment of insertion. A predecessor is shortened to the new
start as part of the same operation. Endpoints are registered implicitly. Later
invalidation records can shorten that end further. A batch is one recovery unit;
its IDs and predecessor references follow input order.

`Graph::add_edges_bounded` uses the same tag-4 representation: the explicit end
is already present in every `Insert`. It is committed with the start in one
frame, avoiding an open interval between an insert and a later invalidation.
The end is the minimum of the requested bound and the next relationship start.
Batch preparation tracks these bounds so a later insertion never extends a
predecessor across an existing gap. No format change is needed for this API.

## Recovery and compatibility

Opening acquires an exclusive standard-library file lock, validates and replays
through a read-only mmap, drops the mmap, then repairs any recognized torn tail.
No mapping survives into the write phase. OS file locks can be advisory; callers
must not edit, truncate, or otherwise modify a database file externally while open.

Recovery truncates an incomplete final frame prefix or payload, or a final frame
whose checksum fails, to the previous valid boundary. A partial initial header is
reinitialized only if it is a prefix of the expected header. A final checksum
failure cannot distinguish a torn write from bit damage in that last frame;
`GraphStats::recovered_tail_bytes` reports what was discarded.

Bad magic, inconsistent lengths, invalid interior checksums, invalid decoded
records, and unsupported versions/tags/flags return errors without truncation.
The reader never skips unknown state-changing records. New versions must retain
old decoders or explicitly migrate to a new file; old readers reject new formats.
The offset table points to enclosing frames, including for edges inside batches.

Buffered commits may still be in process memory. `sync()` flushes the buffer and
calls `File::sync_all`; file creation also synchronizes the parent directory on
Unix. `Fsync` performs that checkpoint after each operation or batch.
Failure disables further writes because the on-disk outcome may be ambiguous.
Fully appended but unacknowledged records may be recovered after reopening.
Process-kill tests exercise append recovery; they do not simulate storage hardware
or power failures. No compaction or history retention policy exists in this release checkpoint.

## Backup index snapshot

Community archives also carry `index.snapshot`, a disposable logical index cache.
It starts with eight bytes `CGIX0001`, then u64 revision, node count and edge count,
then u64 node IDs and 58-byte edge records in the field order above. The manifest
binds its size/checksum to the journal revision. Restore replays the journal and
validates snapshot metadata; it does not trust the cache as authoritative state
or claim faster startup from it. Archive format 1 and journal format 3 are separate
version numbers. The snapshot contains parent nodes/edges; the revision is the global operation revision including branches. Branch bases, deltas and retained lifecycle/merge metadata are reconstructed from journal tags 5–10, which remain authoritative.

Version-1 migration accepts only tags 1–4. Tags 5–10 extend format 2 with checked branch records; earlier format-2 readers reject them without modifying the file. Fork creation captures an active-at-time base at its recorded parent revision. Replay verifies monotonic fork IDs and every branch edit against its then-current timeline. A merge recomputes its deterministic plan and compares the stored remappings, inserts and invalidations before applying it. See [branch semantics](BRANCHES.md).


## Format 3 ingestion receipts

Tag 11 stores one checkpoint and graph batch in the same frame. Fields in order:
source length (u8), source UTF-8 bytes (1–96); partition length (u8), partition UTF-8 bytes (1–96); sequence (u64); request SHA-256 (32 bytes); first edge ID (u64); edge count (u64); global commit revision (u64); insert count (u64); checked `Insert` values. Source and partition accept ASCII letters, digits, underscore, dash and dot.

Replay checks contiguous sequence, first ID, count and commit revision before accepting the record. At most 4096 partition checkpoints are retained. Ingestion always synchronizes before acknowledgment. Format-2 journals require explicit separate-destination upgrade; tags 1–10 retain their existing meanings under record version 3. See [connector transport](CONNECTOR_PLATFORM.md) and [upgrade instructions](UPGRADE_0_4.md).

Binary assets use `CGAS0001`, full SHA-256 of the body (32 bytes), then metadata length (u32), metadata JSON and raw bytes. Names are the first 16 digest bytes as hex plus `.asset`. The full digest is checked against the body and address. The body is bounded to 16 MiB content plus 16 KiB metadata. This namespace is separate from existing `CGAR0001` Arrow sidecars.
