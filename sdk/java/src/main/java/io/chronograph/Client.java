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
