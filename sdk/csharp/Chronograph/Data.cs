using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
namespace Chronograph;

public sealed record Asset(JsonObject Metadata, byte[] Data);
public sealed partial class Client
{
    private const int Chunk = 1024 * 1024;
    public async Task<string> UploadAssetAsync(byte[] data, JsonObject metadata, CancellationToken cancellationToken = default)
    {
        if (data.Length < 1 || data.Length > 16 * Chunk) throw new ArgumentException("Asset requires 1 byte to 16 MiB");
        var args = new JsonObject { ["metadata"] = metadata.DeepClone() }; string op = "asset_put";
        if (data.Length <= Chunk) args["data_hex"] = Convert.ToHexString(data).ToLowerInvariant();
        else { var chunks = new JsonArray(); for (int offset = 0; offset < data.Length; offset += Chunk) chunks.Add(await UploadAssetAsync(data[offset..Math.Min(offset + Chunk, data.Length)], new JsonObject { ["version"] = 1, ["kind"] = "opaque", ["encoding"] = "chunk_v1" }, cancellationToken).ConfigureAwait(false)); args["chunks"] = chunks; op = "asset_compose"; }
        var result = await CallAsync(op, args, cancellationToken).ConfigureAwait(false);
        var id = result["asset"]?.GetValue<string>(); if (string.IsNullOrEmpty(id)) throw new IOException("Invalid asset response"); return id;
    }
    public async Task<Asset> ReadAssetAsync(string id, CancellationToken cancellationToken = default)
    {
        using var output = new MemoryStream(); long expected = -1; JsonObject? metadata = null;
        for (int page = 0; page < 16; page++)
        {
            var r = await CallAsync("asset_get", new JsonObject { ["asset"] = id, ["content"] = true, ["offset"] = output.Length }, cancellationToken).ConfigureAwait(false);
            long size = r["bytes"]?.GetValue<long>() ?? -1, offset = r["offset"]?.GetValue<long>() ?? -1;
            var encoded = r["data_hex"]?.GetValue<string>(); var meta = r["metadata"] as JsonObject;
            if (r["asset"]?.GetValue<string>() != id || offset != output.Length || size < 1 || size > 16 * Chunk || (expected != -1 && expected != size) || encoded is null || encoded.Length == 0 || encoded.Length > 2 * Chunk || meta is null || (metadata is not null && !JsonNode.DeepEquals(metadata, meta))) throw new IOException("Invalid asset page");
            var bytes = Convert.FromHexString(encoded); output.Write(bytes); expected = size; metadata = meta;
            if (output.Length > size || !r.ContainsKey("next_offset")) throw new IOException("Invalid asset length/cursor");
            if (r["next_offset"] is null) { if (output.Length != size) throw new IOException("Truncated asset"); return new Asset(metadata.DeepClone().AsObject(), output.ToArray()); }
            if (r["next_offset"]!.GetValue<long>() != output.Length || output.Length >= size) throw new IOException("Non-progressing asset cursor");
        }
        throw new IOException("Asset page limit exceeded");
    }
    /// <summary>Incremental graph/BCI pages. Stop enumeration to stop requesting; no read/write retries.</summary>
    public async IAsyncEnumerable<JsonObject> PagesAsync(string op, JsonObject? arguments = null, int maxPages = 1000, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (maxPages < 1 || maxPages > 10000 || !(op is "as_of" or "between" or "history" or "neighbors" or "bci_sessions" or "bci_records")) throw new ArgumentException("Invalid pagination options");
        bool bci = op.StartsWith("bci_"); string key = bci ? "after" : "cursor"; var args = arguments?.DeepClone().AsObject() ?? new JsonObject(); var seen = new HashSet<string>(); if (args[key] is not null) seen.Add(args[key]!.GetValue<string>());
        for (int page = 0; page < maxPages; page++)
        {
            var r = await CallAsync(op, args, cancellationToken).ConfigureAwait(false); string cursorKey = op == "bci_records" ? "cursor" : "next_cursor";
            if (!r.ContainsKey(cursorKey)) throw new IOException("Missing pagination cursor"); var cursor = r[cursorKey]; bool done = cursor is null;
            if (op == "bci_records") done = !(r["has_more"]?.GetValue<bool>() ?? throw new IOException("Invalid BCI page"));
            if (bci && r[op == "bci_records" ? "records" : "sessions"] is not JsonArray) throw new IOException("Invalid BCI rows");
            if (!done) { var value = cursor?.GetValue<string>(); if (string.IsNullOrEmpty(value) || !seen.Add(value)) throw new IOException("Non-progressing pagination cursor"); args[key] = value; }
            yield return r; if (done) yield break;
        }
        throw new IOException("Pagination limit reached");
    }
    public Task<JsonObject> BCISessionsAsync(string instance, CancellationToken cancellationToken = default) => CallAsync("bci_sessions", new JsonObject { ["instance"] = instance }, cancellationToken);
    public Task<JsonObject> BCISessionAsync(string instance, string session, CancellationToken cancellationToken = default) => CallAsync("bci_session", new JsonObject { ["instance"] = instance, ["session"] = session }, cancellationToken);
    public Task<JsonObject> BCIWindowAsync(string instance, string session, string stream, string start, string end, JsonArray? channels = null, CancellationToken cancellationToken = default) => CallAsync("bci_window", new JsonObject { ["instance"] = instance, ["session"] = session, ["stream"] = stream, ["start"] = start, ["end"] = end, ["channels"] = channels?.DeepClone() ?? new JsonArray() }, cancellationToken);
    public Task<JsonObject> BCIManifestAsync(string instance, JsonArray sessions, string stream = "eeg", CancellationToken cancellationToken = default) => CallAsync("bci_manifest", new JsonObject { ["instance"] = instance, ["sessions"] = sessions.DeepClone(), ["stream"] = stream }, cancellationToken);
}
