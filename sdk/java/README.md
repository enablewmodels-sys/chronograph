# Java SDK

JDK 17+, Gson 2.14.0. From the repository root: `mvn -f sdk/java/pom.xml install`. This installs to your local Maven repository. Add `co.chronodb:chronograph-community:0.4.0-alpha.3` to your application's dependencies; it has not been published to Maven Central (see [Publishing to Maven Central](#publishing-to-maven-central-maintainers)).

```java
import io.chronograph.Client;
import com.google.gson.JsonObject;

var client = new Client(System.getenv("CHRONOGRAPH_URL"), System.getenv("CHRONOGRAPH_TOKEN"));
var args = new JsonObject();
args.addProperty("t", "9007199254740993");
args.addProperty("limit", 100);
var page = client.call("as_of", args);
```

Reuse one Client for connection pooling. Its synchronous operations may throw `IOException`, `InterruptedException` or `Client.ApiException`. The latter exposes `status`, `code` and `retryAfter`. The optional constructor accepts a `Duration` deadline and maximum response bytes. The custom body subscriber stops oversized responses before collecting them fully. `request(path, method, body)` returns bytes, `ingest` takes a Gson JsonArray, and `checkpoint` returns the response JsonObject. Use `getAsString()` for graph IDs; never `getAsDouble()`.

This is an alpha.3 source package for the ChronoDB Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.


## Publishing to Maven Central (maintainers)

**Nothing in this module has been published to Maven Central.** `0.4.0-alpha.3` exists as
source in this repository and as a local `mvn install` artifact only. The POM now carries
what Central's automated validation and its reviewer checklist look for:

- a non-SNAPSHOT version `0.4.0-alpha.3`, matching the Python (`0.4.0a3`), TypeScript, Dart and C# SDKs
- `name`, `description`, `url`, `organization` and `inceptionYear`
- `licenses`: PolyForm Perimeter 1.0.0 with its real name and a version-pinned canonical URL, a `distribution` element and an explicit SPDX caveat. PolyForm 1.0.0 has no SPDX identifier (the SPDX licence list 3.29.0 carries only PolyForm Noncommercial and Small Business), and the old `polyformproject.org/licenses/perimeter/1.0.0/` page now returns 404, so the POM cites the tag-pinned text instead
- `developers` (ChronoDB, Inc., enablewmodels@gmail.com) and `scm` with `connection`, `developerConnection` and `tag v0.4.0-alpha.3`
- `issueManagement` and a `distributionManagement` target for the Central Portal
- `maven-source-plugin` 3.4.0 and `maven-javadoc-plugin` 3.12.0, which attach the required `-sources.jar` and `-javadoc.jar`
- `maven-gpg-plugin` 3.2.8 in the `release` profile, which signs every uploaded file
- `LICENSE`, `NOTICE` and this README packaged under `META-INF/`

```sh
# 1. Build and sign locally (no upload, no verified namespace needed yet)
mvn -f sdk/java/pom.xml -Prelease -Dgpg.keyname=<your-key-id> verify
# 2. Confirm target/ holds chronograph-community-0.4.0-alpha.3{,-sources,-javadoc}.jar{,.asc}
ls sdk/java/target/*.jar*
# 3. Publish (needs a Central Portal user token in ~/.m2/settings.xml under the server id central)
mvn -f sdk/java/pom.xml -Prelease -Dgpg.keyname=<your-key-id> deploy
```

`mvn deploy` uploads to the Central Portal OSSRH-compatible staging API named in
`<distributionManagement>`. The deployment then appears at
<https://central.sonatype.com/publishing> for a manual publish, or is transferred with
`POST /manual/upload/defaultRepository/<namespace>` from the same IP address. The
alternative path is `org.sonatype.central:central-publishing-maven-plugin` 0.11.0, which
uploads a bundle through the Portal publisher API instead of the staging API; it replaces
the `<distributionManagement>` target.

Central is immutable: a published `0.4.0-alpha.3` can never be replaced, so publish a
version deliberately and bump the version in `pom.xml`, `README.md` and `CHANGELOG.md` together.

### Blockers before the first release

1. **Namespace (groupId) verification.** `co.chronodb` reverses to `chronodb.co`, which this project owns; verify it with a DNS TXT record at that registrar. (The original `io.chronograph` reversed to `chronograph.io`, a domain
   this project does not control, so it cannot be verified by DNS. Verify `co.chronodb` (reverse
   DNS of the project domain `chronodb.co`) or `io.github.enablewmodels-sys` (GitHub-linked
   namespace) in the Portal and change `<groupId>` to the verified value. The Java package
   The Java package `io.chronograph` does not have to change with it.) Publishing under an unverified namespace
   is rejected by the Portal.
2. **GPG key.** An RSA or Ed25519 key published to a public keyserver, with the passphrase
   available to the build. Central rejects any file without a valid `.asc` signature.
3. **Portal account and token.** A Sonatype account holding that namespace, plus a user token
   in `~/.m2/settings.xml`. An old OSSRH token returns 401 and must be replaced.
4. **Licence risk, unresolved.** Central's published requirements ask only for a declared
   licence name and URL, and non-OSI, non-SPDX licences do exist there (for example
   `com.oracle.database.jdbc:ojdbc11` declares the Oracle Free Use Terms and Conditions).
   PolyForm Perimeter 1.0.0 is not OSI-approved, has no SPDX identifier and restricts
   competing use, so an automated validation pass is expected but a human reviewer or
   downstream tooling may still object. Do not describe this artifact as open source.

## BCI and binary data

Use your isolated origin or `https://chronodb.co` and a scoped project key.
Managed routes the origin to the key's project; `/p/PROJECT_ID` is not an SDK
constructor URL. Record session `101` first using the [acquisition guide](https://chronodb.co/documentation/BCI).
The following uses the `client` from the connection example above:

```java
var channels = new com.google.gson.JsonArray(); channels.add(0); channels.add(1);
var window = client.bciWindow("bci_research", "101", "eeg", "0", "1000000", channels);
var args = new JsonObject(); args.addProperty("instance", "bci_research"); args.addProperty("session", "101");
client.pages("bci_records", args, 200, page -> { System.out.println(page); return true; });
```

`uploadAsset(byte[], metadata)` / `readAsset(id)` handle 1 byte–16 MiB of exact binary data.
Chunk lengths, metadata and pagination progress are checked; malformed responses
fail explicitly. Page iteration is incremental with a configurable 1–10,000 page
budget. Stop consuming (or return false from a callback) to stop fetching.

`bci_sessions`, `bci_session`, `bci_records`, `bci_window` and `bci_manifest` are
shared API operations. All model connectors use the same normalized records,
asset helpers and explicit ingest sequence. BrainFlow/LSL device acquisition and
MNE/CSP training run in the Python acquisition service, not in this HTTP client.