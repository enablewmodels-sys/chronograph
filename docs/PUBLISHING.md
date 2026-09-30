# Publishing packages and images

This page is for maintainers. Nothing here is needed to *use* ChronoDB. It records
the exact steps to publish the SDKs and the container image, and what still
requires a human account holder.

## Registry status

Live now, verified by upload logs and by a 409 conflict when the same version was
re-published:

| Artifact | Registry | Name | Status |
| --- | --- | --- | --- |
| TypeScript client | **GitHub Packages** | `@enablewmodels-sys/chronodb-sdk` | **published** 0.4.0-alpha.3 |
| .NET client | **GitHub Packages** | `ChronoDB.Client` | **published** 0.4.0-alpha.3 |
| Java client | **GitHub Packages** | `co.chronodb:chronograph-community` | **published** 0.4.0-alpha.3, with sources and javadoc |
| Container image | **GHCR** | `ghcr.io/enablewmodels-sys/chronograph` | **published**; multi-arch `amd64` and `arm64`, pulled and run |
| Source, binaries, wheel | **GitHub Releases** | `v0.4.0-alpha.3` | **published**, 5 assets with checksums |

Wired and waiting on one credential each:

| Artifact | Registry | Name | Blocker |
| --- | --- | --- | --- |
| Python client and agent | PyPI | `chronograph-connectors` | a trusted publisher entry for `packages.yml`; no token needed |
| Rust engine | crates.io | `chronograph-db` | `CARGO_REGISTRY_TOKEN` repository secret |
| Dart client | pub.dev | `chronodb` | `PUB_TOKEN` repository secret |
| TypeScript client | npmjs.com | `@chronograph-community/sdk` | npm access token, or a trusted publisher once the package exists |
| Java client | Maven Central | `co.chronodb:chronograph-community` | Sonatype namespace, GPG key and Portal token |
| .NET client | NuGet | `ChronoDB.Client` | nuget.org API key |

The GitHub Packages routes are live because they need no separate account: the
workflow authenticates with its own repository-scoped `GITHUB_TOKEN`. That is
also why the Java and .NET packages exist at all — the CI runner has `mvn` and
`dotnet`, which this development machine does not, so those were the first real
builds of either package.

Run `.github/workflows/packages.yml` manually to publish, or
`.github/workflows/publish.yml` to target PyPI and npmjs. Re-publishing an
existing version is rejected with a 409 by design; bump the version instead.

Every package is prepared and locally verified. Nothing has been uploaded. The
names below were all checked against the live registries.

| Artifact | Registry | Name | Local verification | Remaining blocker |
| --- | --- | --- | --- | --- |
| Python client and agent | PyPI | `chronograph-connectors` | wheel and sdist build; clean-venv install runs | PyPI account with 2FA and an API token |
| TypeScript client | npm | `@chronograph-community/sdk` | `npm pack` tarball, 12 files | npm account with an automation token |
| Dart client | pub.dev | `chronodb` | `dart analyze` clean; `pub publish --dry-run` has no errors | pub.dev account |
| Rust engine | crates.io | `chronograph-db` | `cargo package` + `publish --dry-run` succeed and verify | crates.io account and token |
| Java client | Maven Central | `co.chronodb:chronograph-community` | POM validates against the 4.0.0 XSD; sources compile; javadoc builds | Sonatype namespace, GPG key, Portal token; no `mvn` on the build host |
| .NET client | NuGet | `ChronoDB.Client` | manifests are well-formed | nuget.org account and API key; no `dotnet` on the build host |
| Container image | GHCR | `ghcr.io/enablewmodels-sys/chronograph` | **published**; pulled and run successfully | Multi-arch build in progress |
| Binaries, wheel, source | GitHub Releases | attached to a tag | **published** | — |

### Why several names are not what you would expect

Registry names are global, and three of the obvious ones are already held by
unrelated projects. Each was checked, not assumed:

- **pub.dev `chronograph` is taken** by an unrelated Flutter stopwatch package, so a
  publish under it is rejected outright. The Dart package is named `chronodb`, which
  is free. This was renamed before the first release, when there is no installed
  base to break.
- **Maven `io.chronograph` reverses to `chronograph.io`**, a domain this project does
  not control, so the namespace could never be verified and the upload would be
  rejected. The groupId is `co.chronodb`, the reverse of the project's own domain.
- **npm `chronodb` is taken** by an unrelated local-first database, so the TypeScript
  package is scoped as `@chronograph-community/sdk`.
- **NuGet already hosts `Chronograph` and a `Chronograph.*` family** from another
  owner, and reserved prefixes cannot be queried without an account. The package
  id is `ChronoDB.Client`, which avoids the contested family entirely.
- crates.io `chronograph` is taken, but the package is `chronograph-db`, which is free.

### The licence, honestly

PolyForm Perimeter 1.0.0 has **no SPDX identifier** — the SPDX list contains only
PolyForm-Noncommercial-1.0.0 and PolyForm-Small-Business-1.0.0. It therefore cannot
go in a `license` field or a `PackageLicenseExpression`:

- Python uses `LicenseRef-PolyForm-Perimeter-1.0.0`
- Rust uses `license-file`; crates.io reports "non-standard licence"
- .NET uses `PackageLicenseFile` with the LICENSE packed at the package root
- Java declares the licence name and URL; Maven Central's published requirements
  ask only that a licence be declared, and non-SPDX licences are demonstrably
  live there. A human reviewer may still object — treat that as risk, not a pass.

**Never describe these artifacts as open source.** They are source-available.

The LICENSE files are byte-identical to the upstream PolyForm template, including
its own licence URL, which currently returns 404. Do not edit a licence file to
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

# Verify a real install in a clean environment
/tmp/venv2/bin/pip install /tmp/pkg/*.whl
/tmp/venv2/bin/python -c "import chronograph_connectors"

# Publish (needs a PyPI API token; never commit it)
/tmp/venv/bin/python -m twine upload /tmp/pkg/* \
  --username __token__ --password "$PYPI_API_TOKEN"
```

PyPI requires two-factor authentication on the account and refuses uploads without
it. Prefer a project-scoped API token over a password, and prefer
[Trusted Publishing](https://docs.pypi.org/trusted-publishers/) (OIDC from GitHub
Actions) over a long-lived token once the first release exists.

## npm: build, check, publish

```sh
cd sdk/typescript
npm ci
npm run build
npm test
npm pack --dry-run          # inspect exactly what will be uploaded
npm publish --access public # scoped packages default to private without this flag
```

The package carries `repository`, `homepage`, `bugs`, `keywords`, `author` and
`publishConfig.access = public`. Its `files` list ships only `dist`, the readme and the
licence files. Publishing requires `npm login` or an automation token in
`NPM_TOKEN`; never commit the token.

## Container image

A `Dockerfile` exists at the repository root and builds a multi-stage image: the
console is built with Node, the server with Rust, and the runtime stage runs as an
unprivileged user with `/data` and `/config` as volumes.

**It has not been verified in this environment** because no container runtime was
available. Build and smoke-test it before publishing an image, and do not advertise
a container until that has passed:

```sh
docker build -t chronodb:alpha .
docker run --rm -p 8080:8080 -v chronodb-data:/data -v chronodb-config:/config chronodb:alpha
# then: create a token inside the container and open http://127.0.0.1:8080
```

`scripts/container-smoke.py` is the intended smoke test. Add the image reference to
`docs/INSTALL.md` only after it passes on a clean machine.

## GitHub release

```sh
git tag -a v0.4.0-alpha.4 -m "ChronoDB Community v0.4.0-alpha.4"
git push origin v0.4.0-alpha.4
gh release create v0.4.0-alpha.4 --prerelease --title "..." --notes-file NOTES.md \
  target/release/chronograph-server \
  /tmp/pkg/chronograph_connectors-0.4.0a3-py3-none-any.whl
```

Attach checksums. `docs/REQUIREMENTS.md` is the source of truth for what a given tag
actually contains; update it in the same change as any release.

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
