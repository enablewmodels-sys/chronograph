package io.chronograph;

import com.google.gson.*;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.Flow;

/** Thread-safe authenticated v1 transport. Exact IDs/timestamps are JSON strings. */
public final class Client {
    public static final int MAX_REQUEST_BYTES = 4 * 1024 * 1024;
    public static final class ApiException extends IOException {
        public final int status;
        public final String code, retryAfter;
        public ApiException(int status, String code, String message, String retryAfter) {
            super("HTTP " + status + " " + code + ": " + message);
            this.status = status; this.code = code; this.retryAfter = retryAfter;
        }
    }
    private final URI origin;
    private final String token;
    private final Duration timeout;
    private final int maxResponseBytes;
    private final HttpClient http;
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().setStrictness(Strictness.STRICT).create();
    public Client(String origin, String token) { this(origin, token, Duration.ofSeconds(30), MAX_REQUEST_BYTES); }
    public Client(String origin, String token, Duration timeout, int maxResponseBytes) {
        this.origin = URI.create(origin);
        if (!Set.of("http","https").contains(this.origin.getScheme()) || this.origin.getHost() == null || this.origin.getUserInfo() != null || this.origin.getQuery() != null || this.origin.getFragment() != null || !Set.of("","/").contains(this.origin.getPath())) throw new IllegalArgumentException("Use an HTTP(S) origin without credentials or path");
        if (this.origin.getScheme().equals("http") && !Set.of("localhost","127.0.0.1","[::1]").contains(this.origin.getHost())) throw new IllegalArgumentException("Remote endpoints require HTTPS");
        if (token == null || token.isEmpty() || token.chars().anyMatch(c -> c <= 32 || c == 127)) throw new IllegalArgumentException("Invalid bearer token");
        if (timeout == null || timeout.isNegative() || timeout.toMillis() < 1 || maxResponseBytes < 1 || maxResponseBytes > 256*1024*1024) throw new IllegalArgumentException("Invalid client bounds");
        this.token=token; this.timeout=timeout; this.maxResponseBytes=maxResponseBytes;
        this.http=HttpClient.newBuilder().connectTimeout(timeout).followRedirects(HttpClient.Redirect.NEVER).build();
    }
    private static void finite(JsonElement value) {
        if (value == null || value.isJsonNull()) return;
        if (value.isJsonObject()) value.getAsJsonObject().entrySet().forEach(e -> finite(e.getValue()));
        else if (value.isJsonArray()) value.getAsJsonArray().forEach(Client::finite);
        else if (value.getAsJsonPrimitive().isNumber() && !Double.isFinite(value.getAsDouble())) throw new IllegalArgumentException("Non-finite JSON number");
    }
    /** Bounded bytes for JSON, Arrow and backup endpoints; no application retries. */
    public byte[] request(String path, String method, JsonObject body) throws IOException, InterruptedException {
        if (!path.matches("^/v1/[a-z_]+(/[A-Za-z0-9_-]+)?$") || !Set.of("GET","POST","DELETE").contains(method)) throw new IllegalArgumentException("Invalid API path/method");
        finite(body);
        byte[] bytes = body == null ? new byte[0] : JSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_REQUEST_BYTES) throw new IllegalArgumentException("Request exceeds 4 MiB");
        var builder=HttpRequest.newBuilder(origin.resolve(path)).timeout(timeout).header("Authorization","Bearer "+token);
        if(body != null) builder.header("Content-Type","application/json");
        var req=builder.method(method,body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
        var subscriber=new LimitedBody(maxResponseBytes);
        var future=http.sendAsync(req, info -> { subscriber.status=info.statusCode(); return subscriber; });
        HttpResponse<byte[]> response;
        try { response=future.get(timeout.toMillis(),TimeUnit.MILLISECONDS); }
        catch(TimeoutException e) { throw new HttpTimeoutException("Request deadline exceeded"); }
        catch(ExecutionException e) { if(e.getCause() instanceof IOException io) throw io; throw new IOException("HTTP request failed",e.getCause()); }
        finally { subscriber.cancel(); future.cancel(true); }
        if(response.statusCode() < 200 || response.statusCode() >= 300) {
            String code="HTTP_ERROR", message="Request rejected";
            try { var error=JsonParser.parseString(new String(response.body(),StandardCharsets.UTF_8)).getAsJsonObject().getAsJsonObject("error"); if(error.has("code")) code=error.get("code").getAsString(); if(error.has("message")) message=error.get("message").getAsString(); } catch(RuntimeException ignored) { }
            throw new ApiException(response.statusCode(),code,message.substring(0,Math.min(message.length(),1000)),response.headers().firstValue("retry-after").orElse(null));
        }
        return response.body();
    }
    public JsonObject call(String operation, JsonObject arguments) throws IOException, InterruptedException {
        if(!operation.matches("^[a-z_]+$")) throw new IllegalArgumentException("Invalid operation");
        byte[] raw=request("/v1/"+operation,"POST",arguments == null ? new JsonObject() : arguments);
        try { var text=StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(raw)).toString(); var result=JSON.fromJson(text,JsonObject.class); if(result == null) throw new JsonParseException("null object"); return result; }
        catch(RuntimeException | java.nio.charset.CharacterCodingException e) { throw new ApiException(200,"INVALID_JSON","Expected JSON object response",null); }
    }
    public JsonObject ingest(String instance,String partition,String sequence,JsonArray records) throws IOException, InterruptedException {
        var args=new JsonObject(); args.addProperty("instance",instance); args.addProperty("partition",partition); args.addProperty("sequence",sequence); args.add("records",records); return call("connector_ingest",args);
    }
    public JsonObject checkpoint(String instance,String partition) throws IOException, InterruptedException {
        var args=new JsonObject(); args.addProperty("instance",instance); args.addProperty("partition",partition); return call("connector_checkpoint",args);
    }
    public record Asset(JsonObject metadata, byte[] data) {}
    private static final int CHUNK = 1024*1024;
    /** Upload immutable bytes in at most 16 chunks; does not retry ingestion. */
    public String uploadAsset(byte[] data, JsonObject metadata) throws IOException, InterruptedException {
        if(data.length < 1 || data.length > 16*CHUNK) throw new IllegalArgumentException("Asset requires 1 byte to 16 MiB");
        var args=new JsonObject(); args.add("metadata",metadata.deepCopy());
        String op="asset_put";
        if(data.length<=CHUNK) args.addProperty("data_hex",java.util.HexFormat.of().formatHex(data));
        else { var chunks=new JsonArray(); var chunkMeta=new JsonObject(); chunkMeta.addProperty("version",1);chunkMeta.addProperty("kind","opaque");chunkMeta.addProperty("encoding","chunk_v1");
            for(int offset=0;offset<data.length;offset+=CHUNK) chunks.add(uploadAsset(java.util.Arrays.copyOfRange(data,offset,Math.min(offset+CHUNK,data.length)),chunkMeta));
            args.add("chunks",chunks);op="asset_compose";
        }
        var id=call(op,args).get("asset"); if(id==null || !id.isJsonPrimitive() || !id.getAsJsonPrimitive().isString() || id.getAsString().isEmpty()) throw new IOException("Invalid asset response");return id.getAsString();
    }
    private static long exactInteger(JsonElement value) throws IOException {
        if(value==null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber() || !value.getAsString().matches("-?[0-9]+")) throw new IOException("Expected integer");
        try{return Long.parseLong(value.getAsString());}catch(NumberFormatException e){throw new IOException("Invalid integer",e);}
    }
    public Asset readAsset(String id) throws IOException, InterruptedException {
        var bytes=new ByteArrayOutputStream();long expected=-1;JsonObject metadata=null;
        for(int page=0;page<16;page++) {
            var args=new JsonObject();args.addProperty("asset",id);args.addProperty("content",true);args.addProperty("offset",bytes.size());var r=call("asset_get",args);
            long size=exactInteger(r.get("bytes")),offset=exactInteger(r.get("offset"));
            if(!r.has("asset") || !r.get("asset").isJsonPrimitive() || !r.get("asset").getAsJsonPrimitive().isString() || !id.equals(r.get("asset").getAsString()) || offset!=bytes.size() || size<1 || size>16*CHUNK || (expected!=-1 && expected!=size) || !r.has("metadata") || !r.get("metadata").isJsonObject() || !r.has("data_hex") || !r.get("data_hex").isJsonPrimitive() || !r.get("data_hex").getAsJsonPrimitive().isString()) throw new IOException("Invalid asset page");
            String encoded=r.get("data_hex").getAsString();if(encoded.isEmpty() || encoded.length()>2*CHUNK || (encoded.length()&1)!=0)throw new IOException("Invalid asset hex");
            if(metadata!=null && !metadata.equals(r.get("metadata")))throw new IOException("Asset metadata changed");metadata=r.getAsJsonObject("metadata");expected=size;
            try{bytes.writeBytes(java.util.HexFormat.of().parseHex(encoded));}catch(IllegalArgumentException e){throw new IOException("Invalid asset hex",e);}
            if(bytes.size()>size || !r.has("next_offset"))throw new IOException("Invalid asset length/cursor");
            if(r.get("next_offset").isJsonNull()){if(bytes.size()!=size)throw new IOException("Truncated asset");return new Asset(metadata,bytes.toByteArray());}
            if(exactInteger(r.get("next_offset"))!=bytes.size() || bytes.size()>=size)throw new IOException("Non-progressing asset cursor");
        }
        throw new IOException("Asset page limit exceeded");
    }
    /** Callback returns false to stop. Pages are delivered incrementally, with a bounded budget. */
    public void pages(String op,JsonObject arguments,int maxPages,java.util.function.Predicate<JsonObject> visitor) throws IOException,InterruptedException {
        if(maxPages<1 || maxPages>10000 || visitor==null || !Set.of("as_of","between","history","neighbors","bci_sessions","bci_records").contains(op))throw new IllegalArgumentException("Invalid pagination options");
        boolean bci=op.startsWith("bci_");String key=bci?"after":"cursor";var args=arguments==null?new JsonObject():arguments.deepCopy();var seen=new java.util.HashSet<String>();if(args.has(key))seen.add(args.get(key).getAsString());
        for(int page=0;page<maxPages;page++){
            var r=call(op,args);String cursorKey=op.equals("bci_records")?"cursor":"next_cursor";
            if(!r.has(cursorKey))throw new IOException("Missing pagination cursor");var cursor=r.get(cursorKey);boolean done=cursor.isJsonNull();
            if(op.equals("bci_records")){var more=r.get("has_more");if(more==null || !more.isJsonPrimitive() || !more.getAsJsonPrimitive().isBoolean())throw new IOException("Invalid BCI page");done=!more.getAsBoolean();}
            if(bci){String rows=op.equals("bci_records")?"records":"sessions";if(!r.has(rows)||!r.get(rows).isJsonArray())throw new IOException("Invalid BCI rows");}
            if(!done){if(!cursor.isJsonPrimitive() || !cursor.getAsJsonPrimitive().isString() || cursor.getAsString().isEmpty() || !seen.add(cursor.getAsString()))throw new IOException("Non-progressing pagination cursor");args.addProperty(key,cursor.getAsString());}
            if(!visitor.test(r) || done)return;
        }
        throw new IOException("Pagination limit reached");
    }
    public JsonObject bciSessions(String instance) throws IOException,InterruptedException {var a=new JsonObject();a.addProperty("instance",instance);return call("bci_sessions",a);}
    public JsonObject bciSession(String instance,String session) throws IOException,InterruptedException {var a=new JsonObject();a.addProperty("instance",instance);a.addProperty("session",session);return call("bci_session",a);}
    public JsonObject bciWindow(String instance,String session,String stream,String start,String end,JsonArray channels) throws IOException,InterruptedException {var a=new JsonObject();a.addProperty("instance",instance);a.addProperty("session",session);a.addProperty("stream",stream);a.addProperty("start",start);a.addProperty("end",end);a.add("channels",channels==null?new JsonArray():channels);return call("bci_window",a);}
    public JsonObject bciManifest(String instance,JsonArray sessions,String stream) throws IOException,InterruptedException {var a=new JsonObject();a.addProperty("instance",instance);a.add("sessions",sessions);a.addProperty("stream",stream);return call("bci_manifest",a);}

    private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        final int max; volatile int status; boolean cancelled; Flow.Subscription subscription;
        final ByteArrayOutputStream bytes=new ByteArrayOutputStream(); final CompletableFuture<byte[]> done=new CompletableFuture<>();
        LimitedBody(int max) { this.max=max; }
        public CompletionStage<byte[]> getBody() { return done; }
        public synchronized void onSubscribe(Flow.Subscription sub) { if(cancelled || subscription != null) sub.cancel(); else { subscription=sub; sub.request(1); } }
        public synchronized void onNext(List<ByteBuffer> chunks) {
            if(cancelled) return;
            for(var chunk:chunks) { if((long)bytes.size()+chunk.remaining()>max) { cancel(); done.completeExceptionally(new ApiException(status,"RESPONSE_LIMIT","Response exceeds configured limit",null)); return; } byte[] b=new byte[chunk.remaining()]; chunk.get(b); bytes.writeBytes(b); }
            subscription.request(1);
        }
        public void onError(Throwable error) { done.completeExceptionally(error); }
        public void onComplete() { done.complete(bytes.toByteArray()); }
        synchronized void cancel() { cancelled=true; if(subscription != null) subscription.cancel(); }
    }
}
