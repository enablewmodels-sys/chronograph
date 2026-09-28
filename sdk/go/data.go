package chronograph

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
)

const assetChunk = 1024 * 1024

// Asset contains unchanged metadata and exact bytes (including nonfinite tensor bits).
type Asset struct {
	Metadata Object
	Data     []byte
}

// UploadAsset chunks up to 16 MiB. Failed uploads may leave immutable orphan chunks;
// retrying the same bytes is safe, but record ingestion remains explicitly sequenced.
func (c *Client) UploadAsset(ctx context.Context, data []byte, metadata Object) (string, error) {
	if len(data) < 1 || len(data) > 16*assetChunk {
		return "", fmt.Errorf("asset requires 1 byte to 16 MiB")
	}
	var result Object
	var err error
	if len(data) <= assetChunk {
		result, err = c.Call(ctx, "asset_put", Object{"metadata": metadata, "data_hex": hex.EncodeToString(data)})
	} else {
		chunks := []string{}
		for offset := 0; offset < len(data); offset += assetChunk {
			end := offset + assetChunk
			if end > len(data) {
				end = len(data)
			}
			id, e := c.UploadAsset(ctx, data[offset:end], Object{"version": 1, "kind": "opaque", "encoding": "chunk_v1"})
			if e != nil {
				return "", e
			}
			chunks = append(chunks, id)
		}
		result, err = c.Call(ctx, "asset_compose", Object{"metadata": metadata, "chunks": chunks})
	}
	if err != nil {
		return "", err
	}
	id, ok := result["asset"].(string)
	if !ok || id == "" {
		return "", fmt.Errorf("invalid asset response")
	}
	return id, nil
}
func integer(value any) (int64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	v, e := n.Int64()
	return v, e == nil
}
func (c *Client) ReadAsset(ctx context.Context, id string) (Asset, error) {
	out := Asset{}
	expected := int64(-1)
	for page := 0; page < 16; page++ {
		r, e := c.Call(ctx, "asset_get", Object{"asset": id, "content": true, "offset": len(out.Data)})
		if e != nil {
			return Asset{}, e
		}
		size, ok := integer(r["bytes"])
		offset, offOK := integer(r["offset"])
		encoded, hexOK := r["data_hex"].(string)
		meta, metaOK := r["metadata"].(map[string]any)
		if !ok || !offOK || !hexOK || !metaOK || r["asset"] != id || offset != int64(len(out.Data)) || size < 1 || size > 16*assetChunk || (expected != -1 && expected != size) || len(encoded) == 0 || len(encoded) > 2*assetChunk || (out.Metadata != nil && !reflect.DeepEqual(out.Metadata, Object(meta))) {
			return Asset{}, fmt.Errorf("invalid asset page")
		}
		data, e := hex.DecodeString(encoded)
		if e != nil {
			return Asset{}, fmt.Errorf("invalid asset hex")
		}
		expected = size
		out.Metadata = Object(meta)
		out.Data = append(out.Data, data...)
		next, present := r["next_offset"]
		if !present || int64(len(out.Data)) > size {
			return Asset{}, fmt.Errorf("invalid asset length/cursor")
		}
		if next == nil {
			if int64(len(out.Data)) != size {
				return Asset{}, fmt.Errorf("truncated asset")
			}
			return out, nil
		}
		n, ok := integer(next)
		if !ok || n != int64(len(out.Data)) || n >= size {
			return Asset{}, fmt.Errorf("non-progressing asset cursor")
		}
	}
	return Asset{}, fmt.Errorf("asset page limit exceeded")
}

// Pages delivers one validated page at a time. Returning false stops without a
// further request. Graph and BCI cursors are opaque and never converted to float.
func (c *Client) Pages(ctx context.Context, op string, args Object, maxPages int, visit func(Object) bool) error {
	if maxPages < 1 || maxPages > 10000 || visit == nil {
		return fmt.Errorf("invalid page limit/visitor")
	}
	bci := op == "bci_sessions" || op == "bci_records"
	if !bci && op != "as_of" && op != "between" && op != "history" && op != "neighbors" {
		return fmt.Errorf("invalid paginated operation")
	}
	input := Object{}
	for k, v := range args {
		input[k] = v
	}
	key := "cursor"
	if bci {
		key = "after"
	}
	seen := map[string]bool{}
	if s, ok := input[key].(string); ok {
		seen[s] = true
	}
	for page := 0; page < maxPages; page++ {
		r, e := c.Call(ctx, op, input)
		if e != nil {
			return e
		}
		cursor, present := r["next_cursor"]
		done := cursor == nil
		if op == "bci_records" {
			more, ok := r["has_more"].(bool)
			if !ok {
				return fmt.Errorf("invalid BCI page")
			}
			cursor, present = r["cursor"]
			done = !more
		}
		if !present {
			return fmt.Errorf("missing pagination cursor")
		}
		if bci {
			field := "sessions"
			if op == "bci_records" {
				field = "records"
			}
			if _, ok := r[field].([]any); !ok {
				return fmt.Errorf("invalid BCI rows")
			}
		}
		if !done {
			s, ok := cursor.(string)
			if !ok || s == "" || seen[s] {
				return fmt.Errorf("non-progressing pagination cursor")
			}
			seen[s] = true
			input[key] = s
		}
		if !visit(r) || done {
			return nil
		}
	}
	return fmt.Errorf("pagination limit reached")
}
func (c *Client) BCISessions(ctx context.Context, instance string) (Object, error) {
	return c.Call(ctx, "bci_sessions", Object{"instance": instance})
}
func (c *Client) BCISession(ctx context.Context, instance, session string) (Object, error) {
	return c.Call(ctx, "bci_session", Object{"instance": instance, "session": session})
}
func (c *Client) BCIWindow(ctx context.Context, instance, session, stream, start, end string, channels []int) (Object, error) {
	if channels == nil {
		channels = []int{}
	}
	return c.Call(ctx, "bci_window", Object{"instance": instance, "session": session, "stream": stream, "start": start, "end": end, "channels": channels})
}
func (c *Client) BCIManifest(ctx context.Context, instance string, sessions []string, stream string) (Object, error) {
	return c.Call(ctx, "bci_manifest", Object{"instance": instance, "sessions": sessions, "stream": stream})
}
