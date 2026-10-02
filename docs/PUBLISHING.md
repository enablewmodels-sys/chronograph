# Publishing packages and images

This page is for maintainers. Nothing here is needed to *use* ChronoDB. It records
what is publicly installable today, the exact steps to publish the SDKs and the
container image, and what still requires a human account holder.

## What is publicly installable today

Two paths work anonymously, with no account and no token. Both were verified on
2026-10-01 with an unauthenticated `curl` and a native pull.

| Path | Install | Evidence |
| --- | --- | --- |
| GitHub release `v0.4.0-alpha.3` | `npm install <asset URL>`, `pip install <asset URL>` | both asset URLs return HTTP 200 anonymously; the tag carries 8 assets |
| GHCR `ghcr.io/enablewmodels-sys/chronograph:main` | `docker pull` | GHCR issued an anonymous pull token, length 72, and the OCI index lists `linux/amd64` and `linux/arm64` |

```sh
npm install https://github.com/enablewmodels-sys/chronograph/releases/download/v0.4.0-alpha.3/chronograph-community-sdk-0.4.0-alpha.3.tgz
pip install https://github.com/enablewmodels-sys/chronograph/releases/download/v0.4.0-alpha.3/chronograph_connectors-0.4.0a3-py3-none-any.whl
docker pull ghcr.io/enablewmodels-sys/chronograph:main
```

The release tag carries exactly these 8 assets (sizes in bytes, from the GitHub
releases API on 2026-10-01):

| Asset | Size |
| --- | ---: |
| `chronodb-community-0.4.0-alpha.3-source.tar.gz` | 6,877,843 |
| `chronodb-dart-0.4.0-alpha.3.tar.gz` | 9,817 |
| `chronograph-community-sdk-0.4.0-alpha.3.tgz` | 10,870 |
| `chronograph-mcp` | 8,854,448 |
| `chronograph-server` | 9,433,136 |
| `chronograph_connectors-0.4.0a3-py3-none-any.whl` | 47,347 |
| `chronograph_connectors-0.4.0a3.tar.gz` | 46,590 |
| `SHA256SUMS` | 394 |

The npm asset declares `@chronograph-community/sdk` 0.4.0-alpha.3 and is ESM-only
(`"type": "module"`), so import it by name after installing. The wheel declares
`chronograph-connectors` 0.4.0a3 and requires Python 3.10 or newer; `pip` refuses
it on 3.9. These are the only anonymous install paths for the clients today.

## GitHub Packages is not a public install path

The organization's package pages exist, and `.github/workflows/packages.yml`
publishes to them, but **every read requires authentication**, so an anonymous
install fails. Verified on 2026-10-01:

```sh
$ curl -s -o /dev/null -w '%{http_code}\n' https://npm.pkg.github.com/@enablewmodels-sys%2Fchronodb-sdk
401
$ curl -s https://npm.pkg.github.com/@enablewmodels-sys%2Fchronodb-sdk
{"error":"authentication token not provided"}
$ curl -s -o /dev/null -w '%{http_code}\n' https://nuget.pkg.github.com/enablewmodels-sys/index.json
401
$ curl -s -o /dev/null -w '%{http_code}\n' https://maven.pkg.github.com/enablewmodels-sys/chronograph/co/chronodb/chronograph-community/0.4.0-alpha.3/chronograph-community-0.4.0-alpha.3.pom
401
```

An anonymous `npm view` or `npm install` against `npm.pkg.github.com` returns the
same 401. GitHub Packages authenticates every request, so a package listed as
public there is still not anonymously installable.

| Artifact | Registry | Name | Build status |
| --- | --- | --- | --- |
| TypeScript client | GitHub Packages | `@enablewmodels-sys/chronodb-sdk` | published 0.4.0-alpha.3; authenticated install only |
| .NET client | GitHub Packages | `ChronoDB.Client` | published 0.4.0-alpha.3; authenticated install only |
| Java client | GitHub Packages | `co.chronodb:chronograph-community` | published 0.4.0-alpha.3 with sources and javadoc; authenticated install only |

The workflow can publish because it authenticates with the repository-scoped
`GITHUB_TOKEN` and declares `packages: write`. Those scopes are exactly what the
credential at hand lacks: **the personal GitHub token available to this project
carries neither `write:packages` nor `read:packages`**, so this route can neither
be exercised nor read back from this machine. Running or reading it needs a token
with those scopes. GitHub Packages has no Python registry either, so
`packages.yml` still targets PyPI for the Python client.

Do not offer GitHub Packages as install instructions. Treat those three packages
as private artifacts of the organization. Re-publishing an existing version is
rejected with a 409 by design; bump the version instead.

## Registries that are blocked today

`.github/workflows/publish.yml` targets PyPI and npmjs.com through OIDC trusted
publishing, and `.github/workflows/packages.yml` covers the remaining ecosystems.
Both files are written and wired, and each target is still blocked on an account or
a credential the project does not have. The workflows say the same thing in their
own headers.

| Artifact | Registry | Name | Wiring | Exact blocker |
| --- | --- | --- | --- | --- |
| Python client and agent | PyPI | `chronograph-connectors` | `publish.yml`, job `pypi`, environment `pypi` | an OIDC trusted publisher must be created on pypi.org for repository `enablewmodels-sys/chronograph`, workflow `publish.yml`, environment `pypi`. No token is stored. |
| TypeScript client | npmjs.com | `@chronograph-community/sdk` | `publish.yml`, job `npm`, environment `npm` | an npm trusted publisher for the package, or an `NPM_TOKEN` (the `packages.yml` npmjs step reads `secrets.NODE_AUTH_TOKEN`) |
| Rust engine | crates.io | `chronograph-db` | `packages.yml`, job `crates` | `CARGO_REGISTRY_TOKEN` repository secret |
| Dart client | pub.dev | `chronodb` | `packages.yml`, job `dart` | `PUB_TOKEN` repository secret |
| Java client | Maven Central | `co.chronodb:chronograph-community` | no publish step yet; the existing Maven step deploys to Maven on GitHub Packages | OSSRH/Sonatype credentials (namespace and Portal token) plus a GPG signing key |
| .NET client | NuGet | `ChronoDB.Client` | no publish step yet; the existing NuGet step pushes to NuGet on GitHub Packages | `NUGET_API_KEY`, a nuget.org API key |

No install instruction may name a registry in this table until its blocker is
cleared and the upload has been confirmed on the registry itself. As of
2026-10-01 the chosen names are still unpublished: `registry.npmjs.org/chronodb` is
taken (200) by an unrelated package, `registry.npmjs.org/@chronograph-community%2Fsdk`
returns 404, and `pypi.org/pypi/chronograph-connectors/json` returns 404.

## Local builds and checks, before any upload

Nothing in this section has been uploaded to the registry named. It records what
each package needs to pass locally first.

| Artifact | Registry | Name | Recorded local check | Remaining blocker |
| --- | --- | --- | --- | --- |
| Python client and agent | PyPI | `chronograph-connectors` | wheel and sdist build; clean-venv install runs | the trusted publisher above |
| TypeScript client | npm | `@chronograph-community/sdk` | `npm pack` tarball, 12 files | the npm trusted publisher or token above |
| Dart client | pub.dev | `chronodb` | `dart analyze` clean; `pub publish --dry-run` has no errors | the `PUB_TOKEN` above |
| Rust engine | crates.io | `chronograph-db` | `cargo package` + `publish --dry-run` succeed and verify | the `CARGO_REGISTRY_TOKEN` above |
| Java client | Maven Central | `co.chronodb:chronograph-community` | POM validates against the 4.0.0 XSD; sources compile; javadoc builds | Sonatype namespace, GPG key, Portal token; no `mvn` on the build host |
| .NET client | NuGet | `ChronoDB.Client` | manifests are well-formed | nuget.org API key; no `dotnet` on the build host |

The checks in that column were recorded earlier and cannot all be repeated on this
host: `mvn`, `dotnet`, `cargo`, `dart`, `npm`, `node` and a container runtime
are all absent here (checked 2026-10-01 with `command -v`). Only `python3` is
available, and it is 3.9.6, so the wheel metadata can be inspected but the wheel
cannot be installed locally (it declares Python 3.10 or newer). Re-verify on a
machine with the matching toolchain before publishing.

## Why several names are not what you would expect

Registry names are global, and the obvious ones are held by unrelated projects.
Each was checked anonymously on 2026-10-01, not assumed:

- **pub.dev `chronograph` is taken** (the registry API returns 200) by an unrelated
  Flutter stopwatch package, so a publish under it is rejected outright. The Dart
  package is named `chronodb`, which is free (404). Renaming before the first
  release avoids breaking an installed base.
- **Maven `io.chronograph` reverses to `chronograph.io`**, a domain this project does
  not control, so the namespace could never be verified and the upload would be
  rejected. The groupId is `co.chronodb`, the reverse of the project's own domain.
- **npm `chronodb` is taken** (200) by an unrelated local-first database, so the
  TypeScript package is scoped as `@chronograph-community/sdk` (404, free).
- **NuGet already hosts `Chronograph` and `Chronograph.Core`** from another owner
  (both return 200), and reserved prefixes cannot be queried without an account.
  The package id is `ChronoDB.Client` (404, free), which avoids the contested
  family entirely.
- **crates.io `chronograph` is taken** (200, an unrelated "Timestamp Tracers"
  crate), but the package is `chronograph-db`, which does not exist yet.

## The licence, honestly

PolyForm Perimeter 1.0.0 is **source-available, not OSI-approved**, and it has **no
SPDX identifier**: the SPDX licence list contains only PolyForm-Noncommercial-1.0.0
and PolyForm-Small-Business-1.0.0 (checked 2026-10-01). It therefore cannot go in a
`license` field or a `PackageLicenseExpression`:

- Python uses `LicenseRef-PolyForm-Perimeter-1.0.0`
- Rust uses `license-file`; crates.io reports "non-standard licence"
- .NET uses `PackageLicenseFile` with the LICENSE packed at the package root
- Java declares the licence name and URL. Maven Central does not require an SPDX
  expression, but a human reviewer may still object to a non-standard licence:
  treat that as risk, not a pass.

**Never describe these artifacts as open source, and never call the licence
OSI-approved.** They are source-available.

The LICENSE files are byte-identical to the upstream PolyForm template
(`cmp` against the pinned `polyform-licenses` 1.0.0 file passes on 2026-10-01),
including its own licence URL, which returns 404. Do not edit a licence file to
chase a link: the canonical text is pinned at
[polyform-licenses 1.0.0](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Perimeter-1.0.0.md).

## Python: build, check, publish

The metadata lives in `sdk/python/pyproject.toml` and is complete: readme, licence
expression, authors, classifiers, keywords and project URLs.

```sh
# Build the wheel and sdist
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install --upgrade build
(cd sdk/python && /tmp/venv/bin/python -m build --outdir /tmp/pkg)

# Verify the metadata before uploading
/tmp/venv/bin/python -m twine check /tmp/pkg/*

# Verify a real install in a clean environment (Python 3.10 or newer)
/tmp/venv2/bin/pip install /tmp/pkg/*.whl
/tmp/venv2/bin/python -c "import chronograph_connectors"

# Publish, preferred path: the OIDC trusted publisher, no stored token
gh workflow run publish.yml -f target=pypi

# Fallback with a PyPI API token (never commit it)
/tmp/venv/bin/python -m twine upload /tmp/pkg/* \
  --username __token__ --password "$PYPI_API_TOKEN"
```

PyPI requires two-factor authentication on the account and refuses uploads without
it. Prefer a project-scoped API token over a password, and prefer
[Trusted Publishing](https://docs.pypi.org/trusted-publishers/) (OIDC from GitHub
Actions) over a long-lived token. Until the trusted publisher entry exists, the
`publish.yml` PyPI job fails with an authentication error and nothing is uploaded.

## npm: build, check, publish

```sh
cd sdk/typescript
npm ci
npm run build
npm test
npm pack --dry-run          # inspect exactly what will be uploaded
gh workflow run publish.yml -f target=npm   # preferred: OIDC trusted publisher
npm publish --access public # scoped packages default to private without this flag
```

The package carries `repository`, `homepage`, `bugs`, `keywords`, `author` and
`publishConfig.access = public`. Its `files` list ships only `dist`, the readme and
the licence files. The tarball attached to `v0.4.0-alpha.3` has 12 entries, and its
`package.json` declares `@chronograph-community/sdk` 0.4.0-alpha.3. Publishing to
npmjs.com needs the trusted publisher entry or an automation token in
`NPM_TOKEN`; never commit the token.

## Container image

A `Dockerfile` exists at the repository root and builds a multi-stage image: the
console is built with Node, the server with Rust, and the runtime stage runs as an
unprivileged user with `/data` and `/config` as volumes.

The published image is verified: `ghcr.io/enablewmodels-sys/chronograph:main`
pulls anonymously and its OCI index lists `linux/amd64` and `linux/arm64`
(verified 2026-10-01 with a GHCR anonymous token and a native pull).
`.github/workflows/container.yml` builds both platforms with buildx and pushes on
tag and on manual dispatch.

There is no container runtime on this build host, so `docker build` from source
has not been re-run here; the check above was a pull of the published image, not a
local build. Build and smoke-test before publishing a new image:

```sh
docker build -t chronodb:alpha .
docker run --rm -p 8080:8080 -v chronodb-data:/data -v chronodb-config:/config chronodb:alpha
# then: create a token inside the container and open http://127.0.0.1:8080
```

`scripts/container-smoke.py` is the intended smoke test. The image reference is
already documented in `README.md`; `docs/INSTALL.md` still describes the native
bundle route only.

## GitHub release

```sh
git tag -a v0.4.0-alpha.4 -m "ChronoDB Community v0.4.0-alpha.4"
git push origin v0.4.0-alpha.4
gh release create v0.4.0-alpha.4 --prerelease --title "..." --notes-file NOTES.md \
  target/release/chronograph-server \
  /tmp/pkg/chronograph_connectors-0.4.0a3-py3-none-any.whl
```

Attach checksums, as `v0.4.0-alpha.3` does with `SHA256SUMS`. Release assets are the
only publicly installable client path today, so a release without the npm tarball
and the wheel leaves the SDKs unavailable to anonymous users.
`docs/REQUIREMENTS.md` is the source of truth for what a given tag actually
contains; update it in the same change as any release.

## Repository settings the maintainer still owns

These need **admin** rights on `enablewmodels-sys/chronograph`, which the current
automation account does not have:

- The repository **description**, **homepage** and **topics** are still unset.
- **Discussions** is disabled; GitHub Issues is the only intake today.

Until those are set, the project stays hard to discover even though the code is
public.

## Secrets

Never commit tokens, and never paste them into a chat or an issue. Keep them in a
secret manager or your CI provider, and rotate anything that has ever been shared
in plain text. See [security](SECURITY.md).
