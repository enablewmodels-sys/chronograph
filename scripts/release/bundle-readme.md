# Chronograph Community 0.4.0-alpha.2 native bundle

This is an unsigned Community alpha under PolyForm Perimeter 1.0.0 (LICENSE).
Preserve NOTICE when redistributing. Download from the versioned GitHub release.
Signing/notarization, deployed TLS validation and Managed availability remain pending.
No compiler or Node runtime is needed to run these two binaries on the matching OS/CPU.
Optional connector CLIs/Python dataset integrations are built from the source bundle.

Verify the adjacent SHA256SUMS file before extracting. Inside the extracted directory,
choose a private absolute state directory and bootstrap an administrator:

```sh
export CHRONOGRAPH_HOME="$HOME/.local/share/chronograph"
./chronograph admin create-token local-admin admin 90 "$CHRONOGRAPH_HOME/admin.token"
./chronograph serve
```

Open http://127.0.0.1:8080 and paste the token from that private file. `chronograph`
resolves UI/docs paths relative to this bundle and stores graph/config under
CHRONOGRAPH_HOME; no user data is written into the bundle. The service uses the
loopback interface unless explicitly configured. Ctrl+C synchronizes and stops it.
Credentials stay outside graph backups. Never point CHRONOGRAPH_DOCS at secrets.

Use `bin/chronograph-mcp` for a native stdio client; see docs/MCP.md. Read the
manual in `manual/index.html` or use the console documentation. The exact source
and dependency inventory are linked by SHA-256 in release-manifest.json.

For upgrade, stop the process, save a checked backup plus private auth config and
retain the current bundle. Extract the new bundle into a separate directory and
validate a restored copy before reconnecting writers. Format-1 migration and format-2 upgrade always
write a new destination. See docs/UPGRADE_0_4.md. See docs/OPERATIONS.md.

To uninstall, stop the service and remove this extracted directory. CHRONOGRAPH_HOME
is retained; its removal is a separate deliberate deletion of your data and credentials.
No launch agent, background service, shell startup edit or system installation is created.
