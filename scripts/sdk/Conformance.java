import io.chronograph.Client;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HexFormat;
public class Conformance {
 public static void main(String[] args) throws Exception {System.setOut(new PrintStream(System.out,true,StandardCharsets.UTF_8));var input=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));String line;while((line=input.readLine())!=null){var r=new JsonObject();try{var q=JsonParser.parseString(line).getAsJsonObject();var c=new Client(q.get("url").getAsString(),q.get("token").getAsString(),Duration.ofMillis(q.has("timeout")?q.get("timeout").getAsLong():30000),q.has("limit")?q.get("limit").getAsInt():4194304);JsonElement v;if(q.has("helper"))v=helper(c,q);else if(q.has("construct"))v=new JsonPrimitive(true);else if(q.has("method"))v=new JsonPrimitive(HexFormat.of().formatHex(c.request(q.get("path").getAsString(),q.get("method").getAsString(),q.has("body")?q.getAsJsonObject("body"):null)));else v=c.call(q.get("op").getAsString(),q.has("body")?q.getAsJsonObject("body"):null);r.addProperty("ok",true);r.add("value",v);}catch(Client.ApiException e){r.addProperty("ok",false);r.addProperty("status",e.status);r.addProperty("code",e.code);r.addProperty("retry",e.retryAfter);}catch(Exception e){r.addProperty("ok",false);r.addProperty("local",true);r.addProperty("type",e.getClass().getSimpleName());}System.out.println(r);}}

 static JsonElement helper(Client c,JsonObject q)throws Exception{
  String h=q.get("helper").getAsString();var b=q.getAsJsonObject("body");
  if(h.equals("parallel")){var pool=java.util.concurrent.Executors.newFixedThreadPool(4);try{var pending=new java.util.ArrayList<java.util.concurrent.Future<JsonObject>>();for(int i=0;i<12;i++)pending.add(pool.submit(()->c.call("stats",null)));for(var value:pending)if(!value.get().has("revision"))throw new IOException("Concurrent response mismatch");return new JsonPrimitive(pending.size());}finally{pool.shutdownNow();}}
  if(h.equals("upload"))return new JsonPrimitive(c.uploadAsset(HexFormat.of().parseHex(b.get("data_hex").getAsString()),b.getAsJsonObject("metadata")));
  if(h.equals("read")){var a=c.readAsset(b.get("asset").getAsString());var r=new JsonObject();r.add("metadata",a.metadata());r.addProperty("data_hex",HexFormat.of().formatHex(a.data()));return r;}
  if(h.equals("pages")){var r=new JsonArray();c.pages(q.get("op").getAsString(),b,q.has("max_pages")?q.get("max_pages").getAsInt():1000,page->{r.add(page);return !q.has("stop_after") || r.size()!=q.get("stop_after").getAsInt();});return r;}
  String instance=b.get("instance").getAsString(),op=q.get("op").getAsString();
  if(op.equals("bci_sessions"))return c.bciSessions(instance);
  if(op.equals("bci_session"))return c.bciSession(instance,b.get("session").getAsString());
  if(op.equals("bci_manifest"))return c.bciManifest(instance,b.getAsJsonArray("sessions"),b.get("stream").getAsString());
  return c.bciWindow(instance,b.get("session").getAsString(),b.get("stream").getAsString(),b.get("start").getAsString(),b.get("end").getAsString(),b.getAsJsonArray("channels"));
 }
}
