using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Chronograph;

public sealed class ApiException(int status, string code, string message, string? retryAfter = null)
    : Exception($"HTTP {status} {code}: {message}")
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public string? RetryAfter { get; } = retryAfter;
}

/// <summary>Scoped v1 transport. Owns its connection pool. No redirects or application retries.</summary>
public sealed class Client : IDisposable
{
    public const int MaxRequestBytes = 4 * 1024 * 1024;
    private readonly HttpClient http;
    private readonly Uri origin;
    private readonly string token;
    private readonly TimeSpan timeout;
    private readonly int maxResponseBytes;
    public Client(string origin, string token, TimeSpan? timeout = null, int maxResponseBytes = MaxRequestBytes)
    {
        this.origin = new Uri(origin, UriKind.Absolute);
        if (!(this.origin.Scheme is "http" or "https") || this.origin.Host.Length == 0 || this.origin.UserInfo.Length > 0 || this.origin.Query.Length > 0 || this.origin.Fragment.Length > 0 || this.origin.AbsolutePath != "/") throw new ArgumentException("Use an HTTP(S) origin without credentials or path");
        if (this.origin.Scheme == "http" && !(this.origin.Host is "localhost" or "127.0.0.1" or "[::1]")) throw new ArgumentException("Remote endpoints require HTTPS");
        if (string.IsNullOrEmpty(token) || token.Any(c => c <= 32 || c == 127)) throw new ArgumentException("Invalid bearer token");
        this.timeout = timeout ?? TimeSpan.FromSeconds(30);
        if (this.timeout <= TimeSpan.Zero || maxResponseBytes < 1 || maxResponseBytes > 256*1024*1024) throw new ArgumentException("Invalid client bounds");
        this.token = token; this.maxResponseBytes = maxResponseBytes;
        http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, AutomaticDecompression = DecompressionMethods.None }) { Timeout = Timeout.InfiniteTimeSpan };
    }
    public void Dispose() => http.Dispose();
    public async Task<byte[]> RequestAsync(string path, HttpMethod method, JsonObject? body = null, CancellationToken cancellationToken = default)
    {
        if (!Regex.IsMatch(path, @"^/v1/[a-z_]+(/[A-Za-z0-9_-]+)?$") || !(method == HttpMethod.Get || method == HttpMethod.Post || method == HttpMethod.Delete)) throw new ArgumentException("Invalid API path/method");
        var payload = body is null ? null : JsonSerializer.SerializeToUtf8Bytes(body);
        if (payload?.Length > MaxRequestBytes) throw new ArgumentException("Request exceeds 4 MiB");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(timeout);
        using var req = new HttpRequestMessage(method, new Uri(origin, path));
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (payload is not null) { req.Content = new ByteArrayContent(payload); req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json"); }
        using var res = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
        await using var stream = await res.Content.ReadAsStreamAsync(deadline.Token).ConfigureAwait(false);
        using var output = new MemoryStream(); var buffer = new byte[16384];
        int n; while ((n = await stream.ReadAsync(buffer, deadline.Token).ConfigureAwait(false)) > 0) {
            if (output.Length + n > maxResponseBytes) throw new ApiException((int)res.StatusCode,"RESPONSE_LIMIT","Response exceeds configured limit");
            output.Write(buffer,0,n);
        }
        var raw = output.ToArray();
        if (!res.IsSuccessStatusCode) {
            string code = "HTTP_ERROR", message = "Request rejected";
            try { var error = JsonNode.Parse(raw)?["error"]; code = error?["code"]?.GetValue<string>() ?? code; message = error?["message"]?.GetValue<string>() ?? message; } catch (Exception e) when (e is JsonException or InvalidOperationException) { }
            throw new ApiException((int)res.StatusCode,code,message[..Math.Min(message.Length,1000)],res.Headers.TryGetValues("Retry-After", out var values) ? string.Join(",",values) : null);
        }
        return raw;
    }
    public async Task<JsonObject> CallAsync(string operation, JsonObject? arguments = null, CancellationToken cancellationToken = default) {
        if (!Regex.IsMatch(operation,@"^[a-z_]+$")) throw new ArgumentException("Invalid operation");
        var raw = await RequestAsync("/v1/"+operation,HttpMethod.Post,arguments ?? new JsonObject(),cancellationToken).ConfigureAwait(false);
        try { return JsonNode.Parse(raw) as JsonObject ?? throw new JsonException(); } catch (JsonException) { throw new ApiException(200,"INVALID_JSON","Expected JSON object response"); }
    }
    public Task<JsonObject> IngestAsync(string instance, string partition, string sequence, JsonArray records, CancellationToken cancellationToken = default) => CallAsync("connector_ingest",new JsonObject { ["instance"]=instance,["partition"]=partition,["sequence"]=sequence,["records"]=records.DeepClone() },cancellationToken);
    public Task<JsonObject> CheckpointAsync(string instance, string partition, CancellationToken cancellationToken = default) => CallAsync("connector_checkpoint",new JsonObject { ["instance"]=instance,["partition"]=partition },cancellationToken);
}
