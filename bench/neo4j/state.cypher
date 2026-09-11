// Bind $t and $max (9223372036854775807) through the Query API.
MATCH ()-[e:REL]->()
WHERE e.valid_from <= $t AND (e.valid_to = $max OR e.valid_to > $t)
RETURN e.edge_id, e.src, e.dst, e.kind, e.valid_from, e.valid_to, e.payload;
