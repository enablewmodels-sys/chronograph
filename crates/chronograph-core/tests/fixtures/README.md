# Checked migration fixture

`v1.cgraph` is the 242-byte synthetic version-1 journal used by the engine migration tests. It contains the minimal node/relationship history asserted in `src/tests.rs`; it is not a user workspace. Keep the bytes unchanged so format compatibility remains testable.

Only this exact fixture path is exempt from the runtime journal exclusion in Git and source packaging. Newly generated graph files and real workspace journals remain excluded.
