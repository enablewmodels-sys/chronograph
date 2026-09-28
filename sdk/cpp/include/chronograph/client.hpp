#pragma once
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cmath>
#include <memory>
#include <functional>
#include <set>
#include <regex>
#include <stdexcept>
#include <string>

namespace chronograph {
using json = nlohmann::json;
struct api_error : std::runtime_error {
  long status;
  std::string code, retry_after;
  api_error(long status, std::string code, const std::string& message, std::string retry = {})
      : std::runtime_error("HTTP " + std::to_string(status) + " " + code + ": " + message), status(status), code(std::move(code)), retry_after(std::move(retry)) {}
};
/// Each call owns a curl handle. Safe for concurrent calls on an immutable client.
class client {
  static constexpr std::size_t max_request = 4 * 1024 * 1024;
  std::string origin_, token_;
  long timeout_ms_;
  std::size_t max_response_;
  struct transfer { std::string bytes, retry; std::size_t limit; bool overflow = false, failed = false; };
  static std::size_t write(char* ptr, std::size_t size, std::size_t count, void* userdata) noexcept {
    auto& t = *static_cast<transfer*>(userdata);
    if (size && count > SIZE_MAX / size) { t.overflow = true; return 0; }
    auto n = size * count;
    if (n > t.limit - t.bytes.size()) { t.overflow = true; return 0; }
    try { t.bytes.append(ptr, n); return n; } catch (...) { t.failed = true; return 0; }
  }
  static std::size_t header(char* ptr, std::size_t size, std::size_t count, void* userdata) noexcept {
    auto& t = *static_cast<transfer*>(userdata);
    if (size && count > SIZE_MAX / size) return 0;
    auto n = size * count;
    try {
      std::string line(ptr,n);
      if (line.size() >= 12) { auto prefix = line.substr(0,12); for(auto& c:prefix) c=static_cast<char>(std::tolower(static_cast<unsigned char>(c))); if(prefix == "retry-after:") { auto start=line.find_first_not_of(" \t",12), end=line.find_last_not_of("\r\n \t"); if(start != std::string::npos && end >= start) t.retry=line.substr(start,end-start+1); } }
      return n;
    } catch (...) { t.failed=true; return 0; }
  }
  static void finite(const json& value) {
    if(value.is_number_float() && !std::isfinite(value.get<double>())) throw std::invalid_argument("Non-finite JSON number");
    if(value.is_structured()) for(const auto& item:value) finite(item);
  }
public:
  explicit client(std::string origin, std::string token, long timeout_ms = 30000, std::size_t max_response = max_request)
      : origin_(std::move(origin)), token_(std::move(token)), timeout_ms_(timeout_ms), max_response_(max_response) {
    static const auto initialized = curl_global_init(CURL_GLOBAL_DEFAULT);
    if(initialized != CURLE_OK) throw std::runtime_error("curl initialization failed");
    std::unique_ptr<CURLU,decltype(&curl_url_cleanup)> u(curl_url(),curl_url_cleanup);
    if(!u || curl_url_set(u.get(),CURLUPART_URL,origin_.c_str(),0) != CURLUE_OK) throw std::invalid_argument("Invalid origin");
    auto part = [&](CURLUPart p) { char* raw=nullptr; auto result=curl_url_get(u.get(),p,&raw,0); std::string value=result==CURLUE_OK ? raw : ""; curl_free(raw); return value; };
    auto scheme=part(CURLUPART_SCHEME), host=part(CURLUPART_HOST), path=part(CURLUPART_PATH);
    if((scheme != "http" && scheme != "https") || host.empty() || !part(CURLUPART_USER).empty() || !part(CURLUPART_PASSWORD).empty() || origin_.find('?') != std::string::npos || origin_.find('#') != std::string::npos || origin_.find('@') != std::string::npos || (path != "" && path != "/")) throw std::invalid_argument("Use an HTTP(S) origin without credentials or path");
    if(scheme == "http" && host != "localhost" && host != "127.0.0.1" && host != "[::1]") throw std::invalid_argument("Remote endpoints require HTTPS");
    if(token_.empty() || std::any_of(token_.begin(),token_.end(),[](unsigned char c){return c <= 32 || c == 127;})) throw std::invalid_argument("Invalid bearer token");
    if(timeout_ms_ < 1 || max_response_ < 1 || max_response_ > 256*1024*1024) throw std::invalid_argument("Invalid client bounds");
    if(origin_.back() == '/') origin_.pop_back();
  }
  /// Returns bounded raw bytes, including binary Arrow exports. Redirects fail closed.
  std::string request(const std::string& path, const std::string& method = "POST", const json& body = nullptr) const {
    if(!std::regex_match(path,std::regex("/v1/[a-z_]+(/[A-Za-z0-9_-]+)?")) || (method != "GET" && method != "POST" && method != "DELETE")) throw std::invalid_argument("Invalid API path/method");
    finite(body); auto payload=body.is_null() ? std::string() : body.dump();
    if(payload.size() > max_request) throw std::invalid_argument("Request exceeds 4 MiB");
    std::unique_ptr<CURL,decltype(&curl_easy_cleanup)> curl(curl_easy_init(),curl_easy_cleanup);
    if(!curl) throw std::runtime_error("curl allocation failed");
    curl_slist* list=nullptr;
    auto add = [&](const char* line) { auto next=curl_slist_append(list,line); if(!next) {curl_slist_free_all(list); throw std::bad_alloc();} list=next; };
    add(("Authorization: Bearer "+token_).c_str()); if(!body.is_null()) add("Content-Type: application/json"); add("Expect:");
    std::unique_ptr<curl_slist,decltype(&curl_slist_free_all)> headers(list,curl_slist_free_all);
    auto url=origin_+path; transfer t{{},{},max_response_};
    curl_easy_setopt(curl.get(),CURLOPT_URL,url.c_str());
    curl_easy_setopt(curl.get(),CURLOPT_CUSTOMREQUEST,method.c_str());
    curl_easy_setopt(curl.get(),CURLOPT_HTTPHEADER,headers.get());
    curl_easy_setopt(curl.get(),CURLOPT_FOLLOWLOCATION,0L);
    curl_easy_setopt(curl.get(),CURLOPT_TIMEOUT_MS,timeout_ms_);
    curl_easy_setopt(curl.get(),CURLOPT_NOSIGNAL,1L);
    curl_easy_setopt(curl.get(),CURLOPT_WRITEFUNCTION,&write); curl_easy_setopt(curl.get(),CURLOPT_WRITEDATA,&t);
    curl_easy_setopt(curl.get(),CURLOPT_HEADERFUNCTION,&header); curl_easy_setopt(curl.get(),CURLOPT_HEADERDATA,&t);
    if(!body.is_null()) { curl_easy_setopt(curl.get(),CURLOPT_POSTFIELDS,payload.data()); curl_easy_setopt(curl.get(),CURLOPT_POSTFIELDSIZE_LARGE,static_cast<curl_off_t>(payload.size())); }
    auto result=curl_easy_perform(curl.get()); long status=0; curl_easy_getinfo(curl.get(),CURLINFO_RESPONSE_CODE,&status);
    if(t.overflow) throw api_error(status,"RESPONSE_LIMIT","Response exceeds configured limit");
    if(result != CURLE_OK || t.failed) throw std::runtime_error("HTTP transport failed: "+std::string(curl_easy_strerror(result)));
    if(status < 200 || status >= 300) {
      std::string code="HTTP_ERROR", message="Request rejected";
      try { auto error=json::parse(t.bytes).at("error"); code=error.value("code",code); message=error.value("message",message); } catch(const json::exception&) {}
      throw api_error(status,code,message.substr(0,1000),t.retry);
    }
    return t.bytes;
  }
  json call(const std::string& operation, const json& arguments = json::object()) const {
    if(!std::regex_match(operation,std::regex("[a-z_]+"))) throw std::invalid_argument("Invalid operation");
    auto raw=request("/v1/"+operation,"POST",arguments);
    try { auto result=json::parse(raw); if(!result.is_object()) throw api_error(200,"INVALID_JSON","Expected JSON object response"); return result; }
    catch(const json::exception&) { throw api_error(200,"INVALID_JSON","Expected JSON object response"); }
  }
  json ingest(const std::string& instance,const std::string& partition,const std::string& sequence,const json& records) const { return call("connector_ingest",{{"instance",instance},{"partition",partition},{"sequence",sequence},{"records",records}}); }
  json checkpoint(const std::string& instance,const std::string& partition) const { return call("connector_checkpoint",{{"instance",instance},{"partition",partition}}); }
  struct asset { json metadata; std::string data; };
  static std::string encode_hex(const std::string& bytes) {const char* h="0123456789abcdef";std::string s;s.reserve(bytes.size()*2);for(unsigned char b:bytes){s+=h[b>>4];s+=h[b&15];}return s;}
  std::string upload_asset(const std::string& bytes,const json& metadata) const {
    constexpr std::size_t chunk=1024*1024;
    if(bytes.empty() || bytes.size()>16*chunk)throw std::invalid_argument("Asset requires 1 byte to 16 MiB");
    json result;
    if(bytes.size()<=chunk)result=call("asset_put",{{"metadata",metadata},{"data_hex",encode_hex(bytes)}});
    else {auto chunks=json::array();for(std::size_t offset=0;offset<bytes.size();offset+=chunk)chunks.push_back(upload_asset(bytes.substr(offset,chunk),{{"version",1},{"kind","opaque"},{"encoding","chunk_v1"}}));result=call("asset_compose",{{"metadata",metadata},{"chunks",chunks}});}
    if(!result.contains("asset") || !result["asset"].is_string() || result["asset"].get<std::string>().empty())throw std::runtime_error("Invalid asset response");
    return result["asset"].get<std::string>();
  }
  asset read_asset(const std::string& id) const {
    constexpr std::size_t chunk=1024*1024;asset out;std::size_t expected=0;
    for(int page=0;page<16;page++) {
      auto r=call("asset_get",{{"asset",id},{"content",true},{"offset",out.data.size()}});
      if(!r.contains("bytes") || !r["bytes"].is_number_unsigned() || !r.contains("offset") || !r["offset"].is_number_unsigned() || r.value("asset",std::string())!=id || r["offset"].get<std::size_t>()!=out.data.size() || !r.contains("metadata") || !r["metadata"].is_object() || !r.contains("data_hex") || !r["data_hex"].is_string())throw std::runtime_error("Invalid asset page");
      auto size=r["bytes"].get<std::uint64_t>();auto encoded=r["data_hex"].get<std::string>();
      if(size<1 || size>16*chunk || (expected && expected!=size) || encoded.empty() || encoded.size()>2*chunk || encoded.size()%2 || (!out.metadata.is_null() && out.metadata!=r["metadata"]))throw std::runtime_error("Invalid asset length/metadata");
      expected=static_cast<std::size_t>(size);out.metadata=r["metadata"];
      auto digit=[](char c)->int{if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;throw std::runtime_error("Invalid asset hex");};
      for(std::size_t i=0;i<encoded.size();i+=2)out.data+=static_cast<char>((digit(encoded[i])<<4)|digit(encoded[i+1]));
      if(out.data.size()>expected || !r.contains("next_offset"))throw std::runtime_error("Invalid asset length/cursor");
      if(r["next_offset"].is_null()){if(out.data.size()!=expected)throw std::runtime_error("Truncated asset");return out;}
      if(!r["next_offset"].is_number_unsigned() || r["next_offset"].get<std::uint64_t>()!=out.data.size() || out.data.size()>=expected)throw std::runtime_error("Non-progressing asset cursor");
    }
    throw std::runtime_error("Asset page limit exceeded");
  }
  /// Visitor returns false to stop without fetching another page.
  void pages(const std::string& op,json args,int max_pages,const std::function<bool(const json&)>& visit) const {
    const std::set<std::string> allowed={"as_of","between","history","neighbors","bci_sessions","bci_records"};
    if(max_pages<1 || max_pages>10000 || !allowed.count(op) || !args.is_object() || !visit)throw std::invalid_argument("Invalid pagination options");
    bool bci=op.rfind("bci_",0)==0;std::string key=bci?"after":"cursor";std::set<std::string> seen;if(args.contains(key) && args[key].is_string())seen.insert(args[key]);
    for(int page=0;page<max_pages;page++){
      auto r=call(op,args);std::string cursor_key=op=="bci_records"?"cursor":"next_cursor";
      if(!r.contains(cursor_key))throw std::runtime_error("Missing pagination cursor");
      auto cursor=r[cursor_key];bool done=cursor.is_null();
      if(op=="bci_records"){if(!r.contains("has_more") || !r["has_more"].is_boolean())throw std::runtime_error("Invalid BCI page");done=!r["has_more"].get<bool>();}
      if(bci){std::string rows=op=="bci_records"?"records":"sessions";if(!r.contains(rows)||!r[rows].is_array())throw std::runtime_error("Invalid BCI rows");}
      if(!done){if(!cursor.is_string() || cursor.get<std::string>().empty() || !seen.insert(cursor.get<std::string>()).second)throw std::runtime_error("Non-progressing pagination cursor");args[key]=cursor;}
      if(!visit(r) || done)return;
    }
    throw std::runtime_error("Pagination limit reached");
  }
  json bci_sessions(const std::string& instance) const {return call("bci_sessions",{{"instance",instance}});}
  json bci_session(const std::string& instance,const std::string& session) const {return call("bci_session",{{"instance",instance},{"session",session}});}
  json bci_window(const std::string& instance,const std::string& session,const std::string& stream,const std::string& start,const std::string& end,const json& channels=json::array()) const {return call("bci_window",{{"instance",instance},{"session",session},{"stream",stream},{"start",start},{"end",end},{"channels",channels}});}
  json bci_manifest(const std::string& instance,const json& sessions,const std::string& stream="eeg") const {return call("bci_manifest",{{"instance",instance},{"sessions",sessions},{"stream",stream}});}

};
} // namespace chronograph
