import io.chronograph.Client;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HexFormat;
public class Conformance {
 public static void main(String[] args) throws Exception {var input=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));String line;while((line=input.readLine())!=null){var r=new JsonObject();try{var q=JsonParser.parseString(line).getAsJsonObject();var c=new Client(q.get("url").getAsString(),q.get("token").getAsString(),Duration.ofMillis(q.has("timeout")?q.get("timeout").getAsLong():30000),q.has("limit")?q.get("limit").getAsInt():4194304);JsonElement v;if(q.has("construct"))v=new JsonPrimitive(true);else if(q.has("method"))v=new JsonPrimitive(HexFormat.of().formatHex(c.request(q.get("path").getAsString(),q.get("method").getAsString(),q.has("body")?q.getAsJsonObject("body"):null)));else v=c.call(q.get("op").getAsString(),q.has("body")?q.getAsJsonObject("body"):null);r.addProperty("ok",true);r.add("value",v);}catch(Client.ApiException e){r.addProperty("ok",false);r.addProperty("status",e.status);r.addProperty("code",e.code);r.addProperty("retry",e.retryAfter);}catch(Exception e){r.addProperty("ok",false);r.addProperty("local",true);r.addProperty("type",e.getClass().getSimpleName());}System.out.println(r);}}
}
