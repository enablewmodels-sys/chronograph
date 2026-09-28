using System.Text.Json.Nodes;
using Chronograph;
string? line;
while ((line = Console.ReadLine()) is not null)
{
    JsonObject result;
    try
    {
        var q = JsonNode.Parse(line)!.AsObject();
        using var client = new Client(q["url"]!.GetValue<string>(), q["token"]!.GetValue<string>(), TimeSpan.FromMilliseconds(q["timeout"]?.GetValue<int>() ?? 30000), q["limit"]?.GetValue<int>() ?? 4194304);
        JsonNode? value;
        if (q.ContainsKey("helper")) value = await Helper(client, q);
        else if (q["construct"]?.GetValue<bool>() == true) value = JsonValue.Create(true);
        else if (q.ContainsKey("method")) value = JsonValue.Create(Convert.ToHexString(await client.RequestAsync(q["path"]!.GetValue<string>(), new HttpMethod(q["method"]!.GetValue<string>()), q["body"]?.AsObject())).ToLowerInvariant());
        else value = await client.CallAsync(q["op"]!.GetValue<string>(), q["body"]?.AsObject());
        result = new JsonObject { ["ok"] = true, ["value"] = value };
    }
    catch (ApiException e) { result = new JsonObject { ["ok"] = false, ["status"] = e.Status, ["code"] = e.Code, ["retry"] = e.RetryAfter }; }
    catch (Exception e) { result = new JsonObject { ["ok"] = false, ["local"] = true, ["type"] = e.GetType().Name }; }
    Console.WriteLine(result.ToJsonString());
}

static async Task<JsonNode?> Helper(Client c, JsonObject q)
{
    var b = q["body"]!.AsObject(); string h = q["helper"]!.GetValue<string>();
    if(h=="parallel"){var results=await Task.WhenAll(Enumerable.Range(0,12).Select(_=>c.CallAsync("stats")));if(!results.All(r=>r.ContainsKey("revision")))throw new IOException("Concurrent response mismatch");return JsonValue.Create(results.Length);}
    if (h == "upload") return JsonValue.Create(await c.UploadAssetAsync(Convert.FromHexString(b["data_hex"]!.GetValue<string>()), b["metadata"]!.AsObject()));
    if (h == "read") { var a = await c.ReadAssetAsync(b["asset"]!.GetValue<string>()); return new JsonObject { ["metadata"] = a.Metadata, ["data_hex"] = Convert.ToHexString(a.Data).ToLowerInvariant() }; }
    if (h == "pages") { var r = new JsonArray(); await foreach (var page in c.PagesAsync(q["op"]!.GetValue<string>(), b, q["max_pages"]?.GetValue<int>() ?? 1000)) { r.Add(page); if (r.Count == q["stop_after"]?.GetValue<int>()) break; } return r; }
    string instance = b["instance"]!.GetValue<string>(), op = q["op"]!.GetValue<string>();
    if (op == "bci_sessions") return await c.BCISessionsAsync(instance);
    if (op == "bci_session") return await c.BCISessionAsync(instance, b["session"]!.GetValue<string>());
    if (op == "bci_manifest") return await c.BCIManifestAsync(instance, b["sessions"]!.AsArray(), b["stream"]!.GetValue<string>());
    return await c.BCIWindowAsync(instance, b["session"]!.GetValue<string>(), b["stream"]!.GetValue<string>(), b["start"]!.GetValue<string>(), b["end"]!.GetValue<string>(), b["channels"]?.AsArray());
}
