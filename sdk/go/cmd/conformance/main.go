// Internal test driver: JSON lines on stdin, no credential output.
package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	cg "github.com/enablewmodels-sys/chronograph/sdk/go"
	"os"
	"time"
)

func main() {
	s := bufio.NewScanner(os.Stdin)
	s.Buffer(make([]byte, 4096), 10*1024*1024)
	for s.Scan() {
		func() {
			var q struct {
				URL, Token, Op, Path, Method string
				Body                         cg.Object
				Timeout                      int64
				Limit                        int64
				Construct                    bool
			}
			if err := json.Unmarshal(s.Bytes(), &q); err != nil {
				panic(err)
			}
			if q.Timeout == 0 {
				q.Timeout = 30000
			}
			c, err := cg.New(q.URL, q.Token, cg.Options{Timeout: time.Duration(q.Timeout) * time.Millisecond, MaxResponseBytes: q.Limit})
			var value any
			if err == nil {
				defer c.Close()
				if q.Construct {
					value = true
				} else if q.Method != "" {
					var raw []byte
					raw, err = c.Request(context.Background(), q.Path, q.Method, q.Body)
					value = hex.EncodeToString(raw)
				} else {
					value, err = c.Call(context.Background(), q.Op, q.Body)
				}
			}
			r := map[string]any{"ok": err == nil, "value": value}
			if err != nil {
				var api *cg.APIError
				if errors.As(err, &api) {
					r["status"] = api.Status
					r["code"] = api.Code
					r["retry"] = api.RetryAfter
				} else {
					r["local"] = true
				}
			}
			data, e := json.Marshal(r)
			if e != nil {
				panic(e)
			}
			fmt.Println(string(data))
		}()
	}
	if s.Err() != nil {
		panic(s.Err())
	}
}
