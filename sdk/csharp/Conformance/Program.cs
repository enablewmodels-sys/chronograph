using System.Text.Json.Nodes;
using Chronograph;
string? line;
while((line=Console.ReadLine()) is not null) {
 JsonObject result;
 try {
  var q=JsonNode.Parse(line)!.AsObject();
  using var client=new Client(q["url"]!.GetValue<string>(),q["token"]!.GetValue<string>(),TimeSpan.FromMilliseconds(q["timeout"]?.GetValue<int>()??30000),q["limit"]?.GetValue<int>()??4194304);
  JsonNode? value;
  if(q["construct"]?.GetValue<bool>()==true)value=JsonValue.Create(true);
  else if(q.ContainsKey("method"))value=JsonValue.Create(Convert.ToHexString(await client.RequestAsync(q["path"]!.GetValue<string>(),new HttpMethod(q["method"]!.GetValue<string>()),q["body"]?.AsObject())).ToLowerInvariant());
  else value=await client.CallAsync(q["op"]!.GetValue<string>(),q["body"]?.AsObject());
  result=new JsonObject {["ok"]=true,["value"]=value};
 } catch(ApiException e) { result=new JsonObject {["ok"]=false,["status"]=e.Status,["code"]=e.Code,["retry"]=e.RetryAfter}; }
 catch(Exception e) { result=new JsonObject {["ok"]=false,["local"]=true,["type"]=e.GetType().Name}; }
 Console.WriteLine(result.ToJsonString());
}
