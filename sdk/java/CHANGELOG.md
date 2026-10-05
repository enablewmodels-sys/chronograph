# Java SDK changelog

Registry status: **not published**. `co.chronodb:chronograph-community:0.4.0-alpha.3`
exists as source in this repository and as a local `mvn install` artifact only. No version
has been uploaded to Maven Central, and no Maven build has been run in this workspace
(`mvn` is not installed here).

## Unreleased - Maven Central packaging

- `pom.xml` now carries the metadata Central requires and its reviewers check: non-SNAPSHOT
  `0.4.0-alpha.3`, `name`, `description`, `url`, `organization`, `inceptionYear`, an honest
  PolyForm Perimeter 1.0.0 `licenses` entry with `distribution` and an SPDX caveat,
  `developers`, `scm` with `connection`/`developerConnection`/`tag v0.4.0-alpha.3`,
  `issueManagement`, and a `distributionManagement` target for the Central Portal.
- `maven-source-plugin` 3.4.0 (`jar-no-fork`) and `maven-javadoc-plugin` 3.12.0 (`jar`) attach
  the `-sources.jar` and `-javadoc.jar` that Central requires beside every jar.
- A `release` profile binds `maven-gpg-plugin` 3.2.8 to `verify`, so
  `mvn -Prelease deploy` signs every uploaded file as Central requires.
- `LICENSE`, `NOTICE` and `README.md` are packaged under `META-INF/`, so the licence and the
  required notices travel with the jar, the sources jar and the javadoc jar.
- Verified in this workspace with JDK 25.0.2: `javac --release 17 -cp gson-2.14.0.jar`
  compiles `Client.java` (exit 0, warnings only) and `javadoc --release 17` completes with
  warnings only, so the javadoc jar is expected to build. The POM validates against
  `maven-4.0.0.xsd`, and the plugin versions and Gson 2.14.0 were confirmed to exist on
  Maven Central. **No Maven build, packaging or deployment was possible here.**
- Not published. Blockers: verified namespace (`co.chronodb` must be verified by DNS; `io.chronograph` reversed to a domain this
  project does not control), a GPG signing key, a Central Portal account and user token, and
  the unresolved question of how Central treats a non-OSI, non-SPDX licence. See
  "Publishing to Maven Central" in README.md.

## 0.4.0-alpha.3 - 2026-09-30

- Initial source package for the ChronoDB Community `/v1` API: thread-safe authenticated
  transport with a 30-second default timeout and 4 MiB request/response caps, origin and
  bearer-token validation, HTTPS for remote origins, redirect rejection and bounded response
  bodies.
- `call` for JSON operations, `request` for GET/DELETE and bounded binary responses, `ingest`
  for a Gson `JsonArray`, `checkpoint`, `pages` incremental iteration with a 1-10,000 page
  budget, `uploadAsset`/`readAsset` for 1 byte-16 MiB assets, and the shared `bci_sessions`,
  `bci_session`, `bci_records`, `bci_window` and `bci_manifest` operations.
- `Client.ApiException` exposes `status`, `code` and `retryAfter`. No application write
  retries are performed.
- Distributed as source only; no package-registry release is implied.
