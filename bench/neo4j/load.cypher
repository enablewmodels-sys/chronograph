// Use a fresh comparison database. run.py refuses to load a nonempty database.
CREATE CONSTRAINT model_node_id IF NOT EXISTS FOR (n:ModelNode) REQUIRE n.id IS UNIQUE;

LOAD CSV WITH HEADERS FROM 'file:///nodes.csv' AS row
CALL (row) {
  CREATE (:ModelNode {id: toInteger(row.id)})
} IN TRANSACTIONS OF 10000 ROWS;

LOAD CSV WITH HEADERS FROM 'file:///edges.csv' AS row
CALL (row) {
  MATCH (s:ModelNode {id: toInteger(row.src)})
  MATCH (d:ModelNode {id: toInteger(row.dst)})
  CREATE (s)-[:REL {
    edge_id: toInteger(row.edge_id),
    src: toInteger(row.src), dst: toInteger(row.dst), kind: toInteger(row.kind),
    valid_from: toInteger(row.valid_from), valid_to: toInteger(row.valid_to),
    payload: row.payload
  }]->(d)
} IN TRANSACTIONS OF 10000 ROWS;

CREATE RANGE INDEX relation_start IF NOT EXISTS FOR ()-[e:REL]-() ON (e.valid_from);
CREATE RANGE INDEX relation_end IF NOT EXISTS FOR ()-[e:REL]-() ON (e.valid_to);
CALL db.awaitIndexes(300);
