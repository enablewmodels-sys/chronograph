// Package chronograph provides bounded, authenticated access to the Community v1 API.
package chronograph

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const MaxRequestBytes = 4 * 1024 * 1024

var apiPath = regexp.MustCompile(`^/v1/[a-z_]+(/[A-Za-z0-9_-]+)?$`)
var operationName = regexp.MustCompile(`^[a-z_]+$`)

type Object map[string]any
type Record struct {
	Src         string            `json:"src"`
	Dst         string            `json:"dst"`
	TimestampUS string            `json:"timestamp_us"`
	ValidTo     *string           `json:"valid_to,omitempty"`
	Episode     *string           `json:"episode,omitempty"`
	Assets      map[string]string `json:"assets"`
	Fields      Object            `json:"fields"`
}
type APIError struct {
	Status                    int
	Code, Message, RetryAfter string
}

func (e *APIError) Error() string { return fmt.Sprintf("HTTP %d %s: %s", e.Status, e.Code, e.Message) }

type Options struct {
	Timeout          time.Duration
	MaxResponseBytes int64
}
type Client struct {
	origin, token string
	http          *http.Client
	maxResponse   int64
}

func New(origin, token string, options Options) (*Client, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("use an HTTP(S) origin without credentials or path")
	}
	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return nil, fmt.Errorf("remote endpoints require HTTPS")
	}
	if token == "" || strings.IndexFunc(token, func(r rune) bool { return r <= 32 || r == 127 }) >= 0 {
		return nil, fmt.Errorf("invalid bearer token")
	}
	if options.Timeout == 0 {
		options.Timeout = 30 * time.Second
	}
	if options.MaxResponseBytes == 0 {
		options.MaxResponseBytes = MaxRequestBytes
	}
	if options.Timeout < 0 || options.MaxResponseBytes < 1 || options.MaxResponseBytes > 256*1024*1024 {
		return nil, fmt.Errorf("invalid client bounds")
	}
	// A private pool avoids mutating the process-wide default transport.
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: options.Timeout, KeepAlive: 30 * time.Second}).DialContext, ForceAttemptHTTP2: true, MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: options.Timeout, ExpectContinueTimeout: time.Second}
	transport.DisableCompression = true
	h := &http.Client{Transport: transport, Timeout: options.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &Client{origin: strings.TrimSuffix(origin, "/"), token: token, http: h, maxResponse: options.MaxResponseBytes}, nil
}
func (c *Client) Close() { c.http.CloseIdleConnections() }

// Request returns bounded bytes, including Arrow exports and backup archives.
// No application retries are performed. Context cancellation covers reads too.
func (c *Client) Request(ctx context.Context, path, method string, body any) ([]byte, error) {
	if !apiPath.MatchString(path) || (method != "GET" && method != "POST" && method != "DELETE") {
		return nil, fmt.Errorf("invalid API path/method")
	}
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	if len(data) > MaxRequestBytes {
		return nil, fmt.Errorf("request exceeds 4 MiB")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, c.maxResponse+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > c.maxResponse {
		return nil, &APIError{Status: res.StatusCode, Code: "RESPONSE_LIMIT", Message: "response exceeds configured limit"}
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		e := &APIError{Status: res.StatusCode, Code: "HTTP_ERROR", Message: "request rejected", RetryAfter: res.Header.Get("Retry-After")}
		var v struct {
			Error struct{ Code, Message string }
		}
		if json.Unmarshal(raw, &v) == nil {
			if v.Error.Code != "" {
				e.Code = v.Error.Code
			}
			if v.Error.Message != "" {
				e.Message = v.Error.Message
			}
		}
		if len(e.Message) > 1000 {
			e.Message = e.Message[:1000]
		}
		return nil, e
	}
	return raw, nil
}
func (c *Client) Call(ctx context.Context, operation string, arguments Object) (Object, error) {
	if !operationName.MatchString(operation) {
		return nil, fmt.Errorf("invalid operation")
	}
	if arguments == nil {
		arguments = Object{}
	}
	raw, err := c.Request(ctx, "/v1/"+operation, "POST", arguments)
	if err != nil {
		return nil, err
	}
	var result Object
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err = decoder.Decode(&result); err != nil {
		return nil, &APIError{Status: 200, Code: "INVALID_JSON", Message: "expected JSON response"}
	}
	if decoder.Decode(new(any)) != io.EOF || result == nil {
		return nil, &APIError{Status: 200, Code: "INVALID_JSON", Message: "expected one JSON object"}
	}
	return result, nil
}
func (c *Client) Ingest(ctx context.Context, instance, partition, sequence string, records []Record) (Object, error) {
	return c.Call(ctx, "connector_ingest", Object{"instance": instance, "partition": partition, "sequence": sequence, "records": records})
}
func (c *Client) Checkpoint(ctx context.Context, instance, partition string) (Object, error) {
	return c.Call(ctx, "connector_checkpoint", Object{"instance": instance, "partition": partition})
}
