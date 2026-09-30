//! Offline CSV import for graph edge versions.
//!
//! This is a command-line path for loading a user's own data into a workspace
//! without an HTTP client. It reads one CSV file and appends bounded edge
//! versions to the workspace journal using the same embedded API an application
//! would use.
//!
//! The format is deliberately small and matches the engine's data model exactly:
//!
//! ```text
//! src,dst,kind,valid_from,valid_to,payload
//! 1001,1002,1,1000000,2000000,0102030405060708090a0b0c0d0e0f10
//! 1001,1003,2,1500000,,
//! ```
//!
//! * `src`, `dst`: decimal node identifiers.
//! * `kind`: decimal relationship type in `0..=65535`.
//! * `valid_from`: inclusive start in microseconds since the Unix epoch.
//! * `valid_to`: optional exclusive end. Empty means the open end.
//! * `payload`: optional hex, an even number of digits up to 32 (16 bytes),
//!   left-aligned and zero-padded on the right; empty means sixteen zero bytes.
//!   Odd-length, over-long and non-hex values are rejected. Values are not
//!   interpreted by the database.
//!
//! An optional first row whose first field is `src` (case-insensitive) is
//! treated as a header. Blank and whitespace-only lines are ignored, as are
//! lines whose very first character is `#`. Fields may be double-quoted, and a
//! doubled quote inside a quoted field is one literal quote. Lines end with LF,
//! CRLF or a bare CR.
//!
//! Every row is parsed and validated before the journal is opened, so a file
//! rejected by validation writes nothing at all and leaves an existing journal
//! byte-identical. Rows are applied in sorted order by
//! `(src, dst, kind, valid_from)` so the resulting intervals do not depend on
//! the order of lines in the file.
//!
//! The workspace journal is opened for exclusive writing, exactly like
//! `restore` and `migrate-*`. Stop the service first: a running server holds
//! the journal lock and the import fails with a lock error rather than
//! competing for the writer.

use crate::{ApiError, AppResult};
use chronograph_db::{BoundedEdgeInput, EdgeInput, EdgeKind, Graph, NodeId};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path, time::Instant};

/// Edge versions appended per atomic journal frame.
const BATCH: usize = 10_000;
/// Inline payload size in bytes, fixed by the storage format.
const PAYLOAD_BYTES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Row {
    src: u64,
    dst: u64,
    kind: u16,
    valid_from: i64,
    valid_to: i64,
    payload: [u8; PAYLOAD_BYTES],
}

/// Import every row of `source` into the workspace under `data`.
///
/// Returns a JSON summary on success. Any rejected row aborts the whole import
/// before the first write.
pub fn import_csv(data: &Path, source: &Path) -> AppResult<Value> {
    let bytes = fs::read(source)
        .map_err(|e| ApiError::bad(format!("Cannot read {}: {e}", source.display())))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| ApiError::bad(format!("{} is not valid UTF-8", source.display())))?;

    let raw = parse_records(&text)?;
    let rows = parse_rows(&raw)?;
    if rows.is_empty() {
        return Err(ApiError::bad(format!(
            "{} contains no data rows",
            source.display()
        )));
    }

    let distinct_nodes: BTreeSet<u64> = rows.iter().flat_map(|r| [r.src, r.dst]).collect();
    let nodes = distinct_nodes.len();

    let mut sorted = rows;
    sorted.sort_by_key(|r| (r.src, r.dst, r.kind, r.valid_from));

    fs::create_dir_all(data)
        .map_err(|e| ApiError::bad(format!("Cannot create {}: {e}", data.display())))?;
    let journal = data.join("graph.cgraph");
    let started = Instant::now();
    let mut graph = Graph::open(&journal).map_err(to_api)?;

    let mut imported = 0usize;
    for chunk in sorted.chunks(BATCH) {
        let batch: Vec<BoundedEdgeInput> = chunk
            .iter()
            .map(|r| BoundedEdgeInput {
                edge: EdgeInput {
                    src: NodeId(r.src),
                    dst: NodeId(r.dst),
                    kind: EdgeKind(r.kind),
                    valid_from: r.valid_from,
                    payload: r.payload,
                },
                valid_to: r.valid_to,
            })
            .collect();
        graph.add_edges_bounded(&batch).map_err(|e| {
            ApiError::bad(format!(
                "Rejected a batch starting after {imported} imported rows: {e}"
            ))
        })?;
        imported += chunk.len();
    }

    graph.sync().map_err(to_api)?;
    let revision = graph.revision();
    let stored = graph.stats();
    graph.close().map_err(to_api)?;

    Ok(json!({
        "imported": imported.to_string(),
        "input_nodes": nodes.to_string(),
        "workspace_nodes": stored.nodes.to_string(),
        "workspace_edge_versions": stored.edge_versions.to_string(),
        "revision": revision.to_string(),
        "journal": journal.display().to_string(),
        "duration_ms": started.elapsed().as_millis() as u64,
    }))
}

fn to_api(error: chronograph_db::Error) -> ApiError {
    ApiError::bad(error.to_string())
}

/// One raw record with the 1-based line number it started on.
fn parse_records(text: &str) -> AppResult<Vec<(usize, Vec<String>)>> {
    let mut records: Vec<(usize, Vec<String>)> = Vec::new();
    let mut fields: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut closed_quote = false;
    let mut line = 1usize;
    let mut record_line = 1usize;
    let mut has_content = false;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        field.push('"');
                    } else {
                        quoted = false;
                        closed_quote = true;
                    }
                }
                '\n' => {
                    line += 1;
                    field.push(c);
                }
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() && !closed_quote => {
                quoted = true;
                has_content = true;
            }
            ',' => {
                fields.push(std::mem::take(&mut field));
                closed_quote = false;
                has_content = true;
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                fields.push(std::mem::take(&mut field));
                flush(&mut records, &mut fields, record_line);
                line += 1;
                record_line = line;
                closed_quote = false;
                has_content = false;
            }
            '\n' => {
                fields.push(std::mem::take(&mut field));
                flush(&mut records, &mut fields, record_line);
                line += 1;
                record_line = line;
                closed_quote = false;
                has_content = false;
            }
            '#' if fields.is_empty() && field.is_empty() => {
                // Comment line: discard through the next line ending. A bare CR
                // terminates a line here too, so a CR-only file must not swallow
                // the rows that follow a comment.
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                    if next == '\r' {
                        if chars.peek() == Some(&'\n') {
                            chars.next();
                        }
                        break;
                    }
                }
                line += 1;
                record_line = line;
                has_content = false;
            }
            _ => {
                field.push(c);
                has_content = true;
            }
        }
    }
    if quoted {
        return Err(ApiError::bad(format!(
            "Unterminated quoted field starting on line {record_line}"
        )));
    }
    if has_content || !field.is_empty() || !fields.is_empty() {
        fields.push(field);
        flush(&mut records, &mut fields, record_line);
    }
    Ok(records)
}

fn flush(records: &mut Vec<(usize, Vec<String>)>, fields: &mut Vec<String>, record_line: usize) {
    let record = std::mem::take(fields);
    // Whitespace-only and empty lines are not records.
    if record.iter().all(|f| f.trim().is_empty()) {
        return;
    }
    records.push((record_line, record));
}

/// Validate the parsed records into rows, skipping an optional header.
fn parse_rows(records: &[(usize, Vec<String>)]) -> AppResult<Vec<Row>> {
    let mut rows = Vec::new();
    for (index, (line, fields)) in records.iter().enumerate() {
        if index == 0
            && fields
                .first()
                .is_some_and(|f| f.trim().eq_ignore_ascii_case("src"))
        {
            continue;
        }
        rows.push(parse_row(*line, fields)?);
    }
    Ok(rows)
}

fn parse_row(line: usize, fields: &[String]) -> AppResult<Row> {
    let fail = |reason: &str| ApiError::bad(format!("Line {line}: {reason}"));
    if fields.len() < 4 || fields.len() > 6 {
        return Err(fail(
            "expected 4 to 6 columns: src,dst,kind,valid_from[,valid_to][,payload]",
        ));
    }
    let src = parse_u64(fields[0].trim()).ok_or_else(|| fail("src must be a decimal node id"))?;
    let dst = parse_u64(fields[1].trim()).ok_or_else(|| fail("dst must be a decimal node id"))?;
    let kind = fields[2]
        .trim()
        .parse::<u16>()
        .map_err(|_| fail("kind must be a decimal relationship type in 0..=65535"))?;
    let valid_from = fields[3]
        .trim()
        .parse::<i64>()
        .map_err(|_| fail("valid_from must be microseconds as a signed integer"))?;
    if valid_from == i64::MAX {
        return Err(fail("valid_from must be below i64::MAX"));
    }
    let valid_to = match fields.get(4).map(|f| f.trim()).filter(|f| !f.is_empty()) {
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|_| fail("valid_to must be empty or signed microseconds"))?,
        None => i64::MAX,
    };
    if valid_to < valid_from {
        return Err(fail("valid_to must not be earlier than valid_from"));
    }
    let payload = match fields.get(5).map(|f| f.trim()).filter(|f| !f.is_empty()) {
        Some(hex) => parse_payload(hex).ok_or_else(|| {
            fail("payload must be an even number of hex digits, at most 32 (16 bytes)")
        })?,
        None => [0u8; PAYLOAD_BYTES],
    };
    Ok(Row {
        src,
        dst,
        kind,
        valid_from,
        valid_to,
        payload,
    })
}

fn parse_u64(raw: &str) -> Option<u64> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

fn parse_payload(hex: &str) -> Option<[u8; PAYLOAD_BYTES]> {
    if !hex.len().is_multiple_of(2) || hex.len() > PAYLOAD_BYTES * 2 {
        return None;
    }
    let mut out = [0u8; PAYLOAD_BYTES];
    for (index, pair) in hex.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(pair).ok()?;
        out[index] = u8::from_str_radix(text, 16).ok()?;
    }
    Some(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    use chronograph_db::Graph;

    fn row(src: u64, dst: u64, kind: u16, from: i64, to: Option<i64>) -> String {
        match to {
            Some(end) => format!("{src},{dst},{kind},{from},{end},"),
            None => format!("{src},{dst},{kind},{from},,"),
        }
    }

    fn write_csv(text: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.csv");
        std::fs::write(&path, text).unwrap();
        (dir, path)
    }

    #[test]
    fn imports_bounded_and_open_intervals_then_replays() {
        let (dir, csv) = write_csv(&format!(
            "src,dst,kind,valid_from,valid_to,payload\n{}\n{}\n{}\n",
            row(1, 2, 7, 1_000, Some(3_000)),
            row(1, 2, 7, 3_000, None),
            row(1, 5, 9, 500, Some(1_500)),
        ));
        let data = dir.path().join("data");
        let summary = import_csv(&data, &csv).unwrap();
        assert_eq!(summary["imported"], "3");
        assert_eq!(summary["input_nodes"], "3");
        assert_eq!(summary["workspace_edge_versions"], "3");

        // The journal is durable: reopening must reproduce the same intervals.
        let graph = Graph::open(data.join("graph.cgraph")).unwrap();
        assert_eq!(graph.stats().edge_versions, 3);
        assert_eq!(graph.as_of(2_000).edges().count(), 1);
        assert_eq!(graph.as_of(100).edges().count(), 0);
        assert!(graph.as_of(4_000).edges().any(|e| e.dst == NodeId(2)));
        // An exclusive end is honoured.
        assert!(!graph.as_of(3_000).edges().any(|e| e.dst == NodeId(5)));
        graph.close().unwrap();
    }

    #[test]
    fn row_order_does_not_change_intervals_and_header_is_optional() {
        let (dir_a, csv_a) = write_csv(&format!(
            "src,dst,kind,valid_from,valid_to,payload\n{}\n{}\n",
            row(1, 2, 1, 1_000, Some(2_000)),
            row(1, 2, 1, 2_000, Some(3_000)),
        ));
        let out_a = import_csv(&dir_a.path().join("d"), &csv_a).unwrap();

        // Same data, reversed order, no header, CRLF endings.
        let (dir_b, csv_b) = write_csv(&format!(
            "{}\r\n{}\r\n",
            row(1, 2, 1, 2_000, Some(3_000)),
            row(1, 2, 1, 1_000, Some(2_000)),
        ));
        let out_b = import_csv(&dir_b.path().join("d"), &csv_b).unwrap();
        assert_eq!(out_a["imported"], out_b["imported"]);
        assert_eq!(out_a["workspace_edge_versions"], "2");
        assert_eq!(out_b["workspace_edge_versions"], "2");
    }

    #[test]
    fn accepts_quoted_fields_comments_and_blank_lines() {
        let (dir, csv) = write_csv("# a comment\n\n\"1\",\"2\",\"7\",\"1000\",,\n   \n");
        let summary = import_csv(&dir.path().join("d"), &csv).unwrap();
        assert_eq!(summary["imported"], "1");
    }

    #[test]
    fn a_comment_line_ends_at_a_bare_carriage_return() {
        // A CR-only file must not swallow the rows after a comment.
        let (dir, csv) = write_csv("1,2,7,1000,,\r# comment\r3,4,7,2000,,\r");
        let summary = import_csv(&dir.path().join("d"), &csv).unwrap();
        assert_eq!(summary["imported"], "2");
    }

    #[test]
    fn cr_only_line_endings_are_accepted() {
        let (dir, csv) = write_csv("1,2,7,1000,,\r3,4,7,2000,,\r");
        let summary = import_csv(&dir.path().join("d"), &csv).unwrap();
        assert_eq!(summary["imported"], "2");
    }

    #[test]
    fn an_indented_hash_is_a_data_row_not_a_comment() {
        let (dir, csv) = write_csv("  # not a comment\n1,2,7,1000,,\n");
        let error = import_csv(&dir.path().join("d"), &csv).unwrap_err();
        assert!(error.1.contains("Line 1"), "{:?}", error.1);
    }

    #[test]
    fn a_comment_after_data_is_still_ignored() {
        let (dir, csv) = write_csv(&format!(
            "{}\n# trailing comment\n{}\n",
            row(1, 2, 7, 1_000, None),
            row(3, 4, 7, 2_000, None)
        ));
        let summary = import_csv(&dir.path().join("d"), &csv).unwrap();
        assert_eq!(summary["imported"], "2");
    }

    #[test]
    fn payload_hex_is_decoded_and_padded() {
        let (dir, csv) = write_csv("1,2,7,1000,,0f0f\n1,3,7,1000,,\n");
        import_csv(&dir.path().join("d"), &csv).unwrap();
        let graph = Graph::open(dir.path().join("d/graph.cgraph")).unwrap();
        let mut payloads: Vec<[u8; 16]> = graph.as_of(1_000).edges().map(|e| e.payload).collect();
        payloads.sort();
        assert_eq!(payloads[0], [0u8; 16]);
        assert_eq!(payloads[1][0], 0x0f);
        assert_eq!(payloads[1][1], 0x0f);
        assert_eq!(payloads[1][15], 0x00);
        graph.close().unwrap();
    }

    #[test]
    fn rejects_invalid_rows_with_the_line_number_and_writes_nothing() {
        let cases = [
            ("1,2,7,1000,,\n1,2,notanumber,,,\n", "Line 2"),
            ("1,2,7,1000,,\n1,2,70000,1000,,\n", "Line 2"),
            ("1,2,7,1000,,\n1,2,7,3000,2000,\n", "Line 2"),
            ("1,2,7,1000,,\n1,2,7,1000,,abc\n", "Line 2"),
            ("1,2,7,1000,,\n1,2,7\n", "Line 2"),
            ("1,2,7,1000,,\n1,2,7,\n", "Line 2"),
            ("1,2,7,1000,,\n1,2,7,9223372036854775807,,\n", "Line 2"),
        ];
        for (text, expected) in cases {
            let (dir, csv) = write_csv(text);
            let data = dir.path().join("d");
            let error = import_csv(&data, &csv).unwrap_err();
            assert!(
                error.1.contains(expected),
                "expected {expected:?} in {:?} for input {text:?}",
                error.1
            );
            assert!(!data.join("graph.cgraph").exists());
        }
    }

    #[test]
    fn payload_parser_rejects_odd_and_overlong_values() {
        assert_eq!(parse_payload("abc"), None);
        assert_eq!(parse_payload(&"ab".repeat(17)), None);
        assert_eq!(parse_payload("zz"), None);
        assert_eq!(parse_payload(""), Some([0u8; PAYLOAD_BYTES]));
        assert_eq!(parse_payload("ff").unwrap()[0], 0xff);
    }

    #[test]
    fn rejects_a_file_with_no_data_rows() {
        let (dir, csv) = write_csv("src,dst,kind,valid_from,valid_to,payload\n\n");
        let error = import_csv(&dir.path().join("d"), &csv).unwrap_err();
        assert!(error.1.contains("no data rows"), "{:?}", error.1);
    }

    #[test]
    fn reports_an_unterminated_quote() {
        let (dir, csv) = write_csv("1,2,7,1000,,\"unterminated\n");
        let error = import_csv(&dir.path().join("d"), &csv).unwrap_err();
        assert!(error.1.contains("Unterminated"), "{:?}", error.1);
    }

    #[test]
    fn appends_to_an_existing_workspace() {
        let (dir, csv_a) = write_csv(&format!("{}\n", row(1, 2, 7, 1_000, None)));
        let data = dir.path().join("d");
        import_csv(&data, &csv_a).unwrap();
        // Keep the tempdir alive: dropping it deletes the CSV.
        let (_dir_b, csv_b) = write_csv(&format!("{}\n", row(3, 4, 7, 2_000, None)));
        let summary = import_csv(&data, &csv_b).unwrap();
        assert_eq!(summary["imported"], "1");
        assert_eq!(summary["workspace_edge_versions"], "2");
    }
}
