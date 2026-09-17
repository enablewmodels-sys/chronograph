#pragma once
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cmath>
#include <memory>
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
};
} // namespace chronograph
