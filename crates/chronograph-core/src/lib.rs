//! An embedded graph database with half-open edge validity intervals.
//!
//! ```
//! use chronograph_db::{EdgeKind, Graph, NodeId, Result, SampleStrategy};
//! # fn main() -> Result<()> {
//! let path = std::env::temp_dir()
//!     .join(format!("chronograph-doc-{}.cgraph", std::process::id()));
//! let mut graph = Graph::open(&path)?;
//! let first = graph.add_edge(NodeId(1), NodeId(2), EdgeKind(7), 1_000, [0; 16])?;
//! graph.add_edge(NodeId(1), NodeId(2), EdgeKind(7), 3_000, [3; 16])?;
//! graph.add_edge(NodeId(1), NodeId(2), EdgeKind(7), 2_000, [2; 16])?;
//! graph.sync()?;
//! assert_eq!(graph.edge(first).unwrap().valid_to, 2_000);
//! assert_eq!(graph.as_of(2_500).edges().count(), 1);
//! let sampled = graph.sample_neighbors(&[NodeId(1)], 10, 2_500, SampleStrategy::LatestFirst);
//! assert_eq!(sampled[0].len(), 1);
//! assert_eq!(graph.between(1_500, 2_500).count(), 2);
//! assert_eq!(graph.export_arrow(2_500)?.num_rows(), 1);
//! graph.close()?;
//! std::fs::remove_file(path)?;
//! # Ok(())
//! # }
//! ```
#![deny(missing_docs)]

mod branch;
mod graph;
mod index;
mod ingestion;
mod model;
mod storage;

pub use branch::ForkView;
pub use graph::{Graph, GraphView, Neighbors};
pub use ingestion::{IngestCursor, IngestReceipt};
pub use model::*;

#[cfg(test)]
mod tests;
