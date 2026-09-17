fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&chronograph_server::contract::openapi()).unwrap()
    );
}
