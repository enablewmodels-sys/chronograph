# Upstream notice provenance

Some crates omit their repository-level license files from crates.io archives.
These supplemental texts come from the public upstream commits recorded in each
crate's `.cargo_vcs_info.json`. `sources.json` records the exact URLs and SHA-256.
For ra_ap_limit 0.0.188, its entire src/lib.rs matched the rust-analyzer 2023-12-04
release source byte for byte before those license texts were copied. No package
source code is patched here.

The packaging inventory copies these texts only when the installed package does
not carry its own. SPDX output normalizes legacy Cargo slash-separated alternatives
to `OR`; notices retain the original declared expression. The inventory includes
optional/development requirements and is a superset of a normal service binary's
linked dependencies. It is not a vulnerability or binary reachability analysis.
