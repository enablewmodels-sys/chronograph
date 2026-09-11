//! Durable per-partition ingestion cursors. The receipt and edges share a journal frame.
use std::collections::BTreeMap;

use crate::{
    BoundedEdgeInput, EdgeId, Error, Graph, Result,
    storage::{Insert, Record},
};
use serde::{Deserialize, Serialize};

/// Identity of an ordered batch. Sequence numbers start at zero for each partition.
/// The producer must bind `digest` to the complete normalized batch and its configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestCursor {
    /// Stable connector instance identity (1–96 ASCII letters, digits, `_`, `-`, `.`).
    pub source: String,
    /// Stable producer partition identity, with the same restrictions as `source`.
    pub partition: String,
    /// Contiguous transport sequence, independent of observation timestamps.
    pub sequence: u64,
    /// SHA-256 digest of the normalized request, computed by the producer or service.
    pub digest: [u8; 32],
}
/// Durable acknowledgment. Only the latest receipt per partition is retained in memory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestReceipt {
    /// Acknowledged batch identity.
    pub cursor: IngestCursor,
    /// First inserted edge. Together with `edge_count`, identifies the contiguous ID range.
    pub first_edge: EdgeId,
    /// Number of inserted versions.
    pub edge_count: u64,
    /// Graph revision at the original commit, unchanged by retries.
    pub revision: u64,
}

#[derive(Default)]
pub(crate) struct Checkpoints(BTreeMap<(String, String), IngestReceipt>);
impl Checkpoints {
    pub fn check(&self, cursor: &IngestCursor) -> Result<Option<IngestReceipt>> {
        let valid = |s: &str| {
            !s.is_empty()
                && s.len() <= 96
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        };
        if !valid(&cursor.source) || !valid(&cursor.partition) {
            return Err(Error::InvalidIngest(
                "source/partition must contain 1–96 ASCII identifier characters".into(),
            ));
        }
        match self.get(&cursor.source, &cursor.partition) {
            Some(previous)
                if previous.cursor.sequence == cursor.sequence
                    && previous.cursor.digest == cursor.digest =>
            {
                Ok(Some(previous.clone()))
            }
            Some(previous) if previous.cursor.sequence.checked_add(1) == Some(cursor.sequence) => {
                Ok(None)
            }
            Some(_) => Err(Error::IngestConflict(
                "expected the next sequence or an identical retry of the latest batch".into(),
            )),
            None if cursor.sequence != 0 => Err(Error::IngestConflict(
                "a new partition must start at sequence 0".into(),
            )),
            None if self.0.len() >= 4096 => Err(Error::InvalidIngest(
                "workspace checkpoint limit of 4096 partitions reached".into(),
            )),
            None => Ok(None),
        }
    }
    pub fn get(&self, source: &str, partition: &str) -> Option<&IngestReceipt> {
        self.0.get(&(source.to_owned(), partition.to_owned()))
    }
    pub fn insert(&mut self, receipt: IngestReceipt) {
        self.0.insert(
            (
                receipt.cursor.source.clone(),
                receipt.cursor.partition.clone(),
            ),
            receipt,
        );
    }
    pub fn replay(
        &mut self,
        receipt: &IngestReceipt,
        inserts: &[Insert],
        revision: u64,
        first: u64,
    ) -> Result<()> {
        if self.check(&receipt.cursor)?.is_some()
            || inserts.is_empty()
            || receipt.edge_count != inserts.len() as u64
            || receipt.first_edge.0 != first
            || receipt.revision != revision
        {
            return Err(Error::IngestConflict("invalid journal receipt".into()));
        }
        Ok(())
    }
}

impl Graph {
    /// Atomically commit versions and the partition cursor, synchronizing before acknowledgment.
    /// A byte-identical latest retry returns the original receipt without inserting anything.
    /// Ambiguous I/O errors poison the writer; reopen and retry the same batch to reconcile.
    pub fn ingest(
        &mut self,
        cursor: IngestCursor,
        inputs: &[BoundedEdgeInput],
    ) -> Result<IngestReceipt> {
        self.journal.ensure_writable()?;
        if let Some(receipt) = self.checkpoints.check(&cursor)? {
            return Ok(receipt);
        }
        if inputs.is_empty() {
            return Err(Error::InvalidIngest(
                "ingestion batches cannot be empty".into(),
            ));
        }
        let edges: Vec<_> = inputs.iter().map(|i| i.edge).collect();
        let ends: Vec<_> = inputs.iter().map(|i| i.valid_to).collect();
        let inserts = self.prepare_edges(&edges, Some(&ends))?;
        let receipt = IngestReceipt {
            cursor,
            first_edge: EdgeId(self.index.edges.len() as u64),
            edge_count: inserts.len() as u64,
            revision: self.revision() + 1,
        };
        let record = Record::Ingest(receipt.clone(), inserts);
        let offset = self.journal.append(&record)?;
        self.journal.sync()?;
        if let Record::Ingest(_, inserts) = record {
            for insert in inserts {
                self.index.apply_insert(insert, offset, true);
            }
        }
        self.index.revision += 1;
        self.checkpoints.insert(receipt.clone());
        Ok(receipt)
    }
    /// Read the last durably acknowledged batch for this source and partition.
    pub fn checkpoint(&self, source: &str, partition: &str) -> Option<&IngestReceipt> {
        self.checkpoints.get(source, partition)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EdgeInput, EdgeKind, NodeId,
        storage::{Record, encode_record},
    };
    fn cursor(sequence: u64) -> IngestCursor {
        IngestCursor {
            source: "camera".into(),
            partition: "left".into(),
            sequence,
            digest: [sequence as u8; 32],
        }
    }
    fn input(t: i64) -> BoundedEdgeInput {
        BoundedEdgeInput {
            edge: EdgeInput {
                src: NodeId(1),
                dst: NodeId(2),
                kind: EdgeKind(7),
                valid_from: t,
                payload: [5; 16],
            },
            valid_to: i64::MAX,
        }
    }
    #[test]
    fn receipts_survive_restart_and_reject_conflicting_retries() {
        let dir = std::env::temp_dir().join(format!(
            "cg-ingest-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("graph");
        let mut g = Graph::open(&path).unwrap();
        let first = g.ingest(cursor(0), &[input(10), input(30)]).unwrap();
        assert_eq!(g.ingest(cursor(0), &[input(10), input(30)]).unwrap(), first);
        assert_eq!(g.history().len(), 2);
        let mut conflict = cursor(0);
        conflict.digest = [9; 32];
        assert!(matches!(
            g.ingest(conflict, &[input(20)]),
            Err(Error::IngestConflict(_))
        ));
        assert!(g.ingest(cursor(2), &[input(20)]).is_err());
        assert!(g.ingest(cursor(1), &[]).is_err());
        g.close().unwrap();
        let mut g = Graph::open(&path).unwrap();
        assert_eq!(g.checkpoint("camera", "left"), Some(&first));
        let second = g.ingest(cursor(1), &[input(20)]).unwrap(); // late observation, next transport sequence
        assert_eq!(g.edge(EdgeId(0)).unwrap().valid_to, 20);
        assert_eq!(g.edge(EdgeId(2)).unwrap().valid_to, 30);
        assert!(g.ingest(cursor(0), &[input(10)]).is_err());
        g.close().unwrap();
        let g = Graph::open(&path).unwrap();
        assert_eq!(g.checkpoint("camera", "left"), Some(&second));
        g.close().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn every_torn_ingest_frame_recovers_without_half_checkpoint() {
        let dir = std::env::temp_dir().join(format!(
            "cg-torn-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("graph");
        let mut g = Graph::open(&path).unwrap();
        g.ingest(cursor(0), &[input(0)]).unwrap();
        g.close().unwrap();
        let baseline = std::fs::read(&path).unwrap();
        let mut g = Graph::open(&path).unwrap();
        g.ingest(cursor(1), &[input(1)]).unwrap();
        g.close().unwrap();
        let full = std::fs::read(&path).unwrap();
        for end in baseline.len()..full.len() {
            std::fs::write(&path, &full[..end]).unwrap();
            let mut g = Graph::open(&path).unwrap();
            assert_eq!(g.history().len(), 1, "cut {end}");
            assert_eq!(g.checkpoint("camera", "left").unwrap().cursor.sequence, 0);
            g.ingest(cursor(1), &[input(1)]).unwrap();
            assert_eq!(g.history().len(), 2);
            g.close().unwrap();
        }
        std::fs::write(&path, &baseline).unwrap();
        let mut g = Graph::open(&path).unwrap();
        g.journal.fault_sync = true;
        assert!(g.ingest(cursor(1), &[input(1)]).is_err());
        assert_eq!(g.history().len(), 1);
        assert!(matches!(
            g.ingest(cursor(1), &[input(1)]),
            Err(Error::WriterFailed)
        ));
        drop(g);
        let mut g = Graph::open(&path).unwrap();
        let receipt = g.ingest(cursor(1), &[input(1)]).unwrap();
        assert_eq!(receipt.edge_count, 1);
        assert_eq!(g.history().len(), 2);
        g.close().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn explicit_v2_upgrade_preserves_source_and_forks() {
        let dir = std::env::temp_dir().join(format!(
            "cg-upgrade-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&dir).unwrap();
        let old = dir.join("v2");
        let new = dir.join("v3");
        let mut bytes = b"CHROGRPH\x02\0\0\0".to_vec();
        for r in [
            Record::Node(NodeId(1)),
            Record::ForkCreate {
                id: crate::ForkId(1),
                parent_revision: 1,
                timestamp: 0,
                name: "old-fork".into(),
            },
        ] {
            let mut frame = vec![];
            encode_record(&r, &mut frame).unwrap();
            frame[8..10].copy_from_slice(&2u16.to_le_bytes());
            let end = frame.len() - 4;
            let checksum = crc32fast::hash(&frame[8..end]);
            frame[end..].copy_from_slice(&checksum.to_le_bytes());
            bytes.extend(frame);
        }
        std::fs::write(&old, &bytes).unwrap();
        assert!(matches!(Graph::open(&old), Err(Error::MigrationRequired)));
        Graph::migrate_v2(&old, &new).unwrap();
        assert_eq!(std::fs::read(&old).unwrap(), bytes);
        let g = Graph::open(&new).unwrap();
        assert_eq!(g.forks().count(), 1);
        assert_eq!(g.revision(), 2);
        g.close().unwrap();
        assert!(Graph::migrate_v2(&old, &new).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
