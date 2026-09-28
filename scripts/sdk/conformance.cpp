#include <chronograph/client.hpp>
#include <iostream>
#include <future>
std::string hex(const std::string& s){const char* alphabet="0123456789abcdef";std::string r;r.reserve(2*s.size());for(unsigned char c:s){r+=alphabet[c>>4];r+=alphabet[c&15];}return r;}
chronograph::json helper(const chronograph::client& c,const chronograph::json& q){
 auto b=q.at("body");std::string h=q.at("helper");
 if(h=="parallel"){std::vector<std::future<chronograph::json>> pending;for(int i=0;i<12;i++)pending.push_back(std::async(std::launch::async,[&](){return c.call("stats");}));for(auto& p:pending)if(!p.get().contains("revision"))throw std::runtime_error("Concurrent response mismatch");return pending.size();}
 if(h=="upload"){std::string raw,encoded=b.at("data_hex");for(std::size_t i=0;i<encoded.size();i+=2)raw+=static_cast<char>(std::stoi(encoded.substr(i,2),nullptr,16));return c.upload_asset(raw,b.at("metadata"));}
 if(h=="read"){auto a=c.read_asset(b.at("asset"));return {{"metadata",a.metadata},{"data_hex",hex(a.data)}};}
 if(h=="pages"){auto r=chronograph::json::array();c.pages(q.at("op"),b,q.value("max_pages",1000),[&](const auto& page){r.push_back(page);return r.size()!=q.value("stop_after",std::size_t(0));});return r;}
 std::string op=q.at("op");if(op=="bci_sessions")return c.bci_sessions(b.at("instance"));if(op=="bci_session")return c.bci_session(b.at("instance"),b.at("session"));if(op=="bci_manifest")return c.bci_manifest(b.at("instance"),b.at("sessions"),b.at("stream"));return c.bci_window(b.at("instance"),b.at("session"),b.at("stream"),b.at("start"),b.at("end"),b.value("channels",chronograph::json::array()));
}
int main(){std::string line;while(std::getline(std::cin,line)){chronograph::json r;try{auto q=chronograph::json::parse(line);chronograph::client c(q.at("url"),q.at("token"),q.value("timeout",30000L),q.value("limit",4194304));chronograph::json v;if(q.contains("helper"))v=helper(c,q);else if(q.value("construct",false))v=true;else if(q.contains("method"))v=hex(c.request(q.at("path"),q.at("method"),q.value("body",chronograph::json())));else v=c.call(q.at("op"),q.value("body",chronograph::json::object()));r={{"ok",true},{"value",v}};}catch(const chronograph::api_error& e){r={{"ok",false},{"status",e.status},{"code",e.code},{"retry",e.retry_after}};}catch(const std::exception&){r={{"ok",false},{"local",true}};}std::cout<<r.dump()<<std::endl;}}
