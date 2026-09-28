package main

import (
	"context"
	"encoding/hex"
	"fmt"
	cg "github.com/enablewmodels-sys/chronograph/sdk/go"
)

func helper(c *cg.Client, h, op string, b cg.Object, maxPages, stop int) (any, error) {
	ctx := context.Background()
	if h == "parallel" {
		results := make(chan error, 12)
		for i := 0; i < 12; i++ {
			go func() {
				r, e := c.Call(ctx, "stats", nil)
				if e == nil && r["revision"] == nil {
					e = fmt.Errorf("concurrent response mismatch")
				}
				results <- e
			}()
		}
		var failure error
		for i := 0; i < 12; i++ {
			if e := <-results; e != nil {
				failure = e
			}
		}
		return 12, failure
	}
	if h == "upload" {
		raw, e := hex.DecodeString(b["data_hex"].(string))
		if e != nil {
			return nil, e
		}
		return c.UploadAsset(ctx, raw, cg.Object(b["metadata"].(map[string]any)))
	}
	if h == "read" {
		a, e := c.ReadAsset(ctx, b["asset"].(string))
		return cg.Object{"metadata": a.Metadata, "data_hex": hex.EncodeToString(a.Data)}, e
	}
	if h == "pages" {
		if maxPages == 0 {
			maxPages = 1000
		}
		r := []cg.Object{}
		e := c.Pages(ctx, op, b, maxPages, func(page cg.Object) bool { r = append(r, page); return len(r) != stop })
		return r, e
	}
	instance := b["instance"].(string)
	if op == "bci_sessions" {
		return c.BCISessions(ctx, instance)
	}
	if op == "bci_session" {
		return c.BCISession(ctx, instance, b["session"].(string))
	}
	if op == "bci_manifest" {
		sessions := []string{}
		for _, s := range b["sessions"].([]any) {
			sessions = append(sessions, s.(string))
		}
		return c.BCIManifest(ctx, instance, sessions, b["stream"].(string))
	}
	channels := []int{}
	if b["channels"] != nil {
		for _, v := range b["channels"].([]any) {
			channels = append(channels, int(v.(float64)))
		}
	}
	return c.BCIWindow(ctx, instance, b["session"].(string), b["stream"].(string), b["start"].(string), b["end"].(string), channels)
}
