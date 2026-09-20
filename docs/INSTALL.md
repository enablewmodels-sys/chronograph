# Install, upgrade and remove Community

Get the [Community source](https://github.com/enablewmodels-sys/chronograph) or [versioned alpha downloads](https://github.com/enablewmodels-sys/chronograph/releases/tag/v0.4.0-alpha.2). Check the assets list for available targets. Registry packages are not published. Read [licensing](LICENSING.md) before redistributing or offering a service.

Using the hosted service? Follow [Managed setup](HOSTED.md); no server installation
is required. For your own infrastructure, follow [isolated Community](ISOLATED.md)
and [production operations](PRODUCTION.md). The commands below install Community.

## Build from source

Install Rust 1.93 or later and Node 20.19 or later. From the workspace root:

```sh
git clone https://github.com/enablewmodels-sys/chronograph.git
cd chronograph
npm --prefix ui ci
npm --prefix ui run build
cargo build --locked --release -p chronograph-server
```

The resulting native executables are `target/release/chronograph-server` and `target/release/chronograph-mcp`. The service uses the built `ui/dist` and `docs` directories by default. Keep those files together with the source checkout, or set explicit paths when launching from elsewhere:

```sh
export CHRONOGRAPH_UI=/absolute/path/to/chronograph/ui/dist
export CHRONOGRAPH_DOCS=/absolute/path/to/chronograph/docs
export CHRONOGRAPH_DATA=/absolute/path/to/private-workspace
export CHRONOGRAPH_AUTH=/absolute/path/to/private-config/auth.json
```

Choose a data directory you control. Keep configuration outside the data directory. Bootstrap a fresh administrator token and start the service:

```sh
./target/release/chronograph-server admin create-token local-admin admin 90 /absolute/path/to/private-config/admin.token
./target/release/chronograph-server serve
```

The token output file must not exist. It is created with private permissions; the authentication store contains an Argon2id hash, not the secret. Open `http://127.0.0.1:8080/login` and paste the token locally. Read [quickstart](QUICKSTART.md) and [deployment](DEPLOYMENT.md) before changing the listening address or using a public hostname.

## Embedded application

Use a path dependency until crate publication has been verified:

```toml
[dependencies]
chronograph-db = { path = "/absolute/path/to/chronograph/crates/chronograph-core" }
```

Import it as `chronograph_db`. The engine has no network listener. Call `sync()` or `close()` to establish an error-reporting durability checkpoint, or open with `Durability::Fsync`.

## Optional adapters

BCI simulation and all file-based Rust adapters build in the workspace. Live LSL is optional: `--features lsl` on the BCI connector builds the bundled native runtime. Actual LeRobot/Minari dataset exports use the optional Python environment described in their [robotics](connectors/robotics.md) and [world-model](connectors/worldmodel.md) guides. These dependencies are not required to run the core service.

## Upgrade

Version 0.4 uses format 3. A 0.3/format-2 workspace requires the [explicit format-2 upgrade](UPGRADE_0_4.md) into a separate destination before opening with this release.

Stop the old service gracefully and preserve a [consistent backup](OPERATIONS.md). Never point a new build at the only copy of irreplaceable data as an upgrade experiment. The file header identifies the format; opening format 1 returns a migration-required error, and the explicit migration CLI writes a separate destination. Source and destination must be distinct, and the source remains unchanged.

Format 2 readers must understand every journal tag in the file, including branch tags 5–10. An older reader rejects unknown tags; it does not skip branch state. Validate a restored copy with the new build before switching service paths. Keep the old binary, untouched source and previous configuration available for rollback. See [storage format](FORMAT.md) for recovery and compatibility rules.

## Remove

Stop the service with SIGINT/SIGTERM and disconnect any MCP clients. Remove the binaries and built UI from the installation directory, and remove only the Chronograph MCP entry you added to your client configuration. This does not erase graph data or credentials. Archive or delete those directories separately only when you intend to remove that workspace. Token secrets in your client environment or secret manager must also be removed separately.

## Native alpha bundle

The Apple Silicon macOS alpha is packaged under `dist/v0.4.0-alpha.2/` and attached to the release. It
contains both binaries, the built console, public docs, offline manual, upstream
license texts, SPDX 2.3 workspace dependency inventory and per-file checksums.
These binaries are unsigned and not notarized. Linux x86_64/arm64 build jobs are
available on demand; check their run results and release assets before assuming
those targets are supported. Deployed TLS verification is pending.

Verify `SHA256SUMS` in that directory, extract the archive matching your OS/CPU,
and run the relocatable launcher from its extracted directory:

```sh
shasum -a 256 -c SHA256SUMS
tar -xzf chronograph-community-0.4.0-alpha.2-aarch64-apple-darwin.tar.gz
cd chronograph-community-0.4.0-alpha.2-aarch64-apple-darwin
export CHRONOGRAPH_HOME="$HOME/.local/share/chronograph"
./chronograph admin create-token local-admin admin 90 "$CHRONOGRAPH_HOME/admin.token"
./chronograph serve
```

The launcher keeps runtime state outside the extracted bundle. `CHRONOGRAPH_HOME`
must be absolute. It resolves UI/docs paths itself. No system service, shell
startup edit or background daemon is installed. To upgrade, extract a separate
version directory and retain the previous bundle and state backup. To remove
only the software, stop it and remove that extracted directory; runtime state is
retained. Optional adapters remain source-built.

Maintainers can reproduce packaging with Python 3.12+, the compiled binaries,
`npm ci`/UI build and mdBook 0.5.3: run `python3 scripts/release/package.py --target
aarch64-apple-darwin`. It refuses to overwrite an existing release. Use `--output`
with a new directory for another candidate. `scripts/release/smoke.py` checks the
extracted bundle and a real restarted service in disposable directories. Actual
outcomes are in the retained release report.
