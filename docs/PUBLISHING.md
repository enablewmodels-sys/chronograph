# Publishing packages and images

This page is for maintainers. Nothing here is needed to *use* ChronoDB. It records
the exact steps to publish the SDKs and the container image, and what still
requires a human account holder.

## What can be published today

| Artifact | Registry | Package name | Account needed |
| --- | --- | --- | --- |
| Python client and agent | PyPI | `chronograph-connectors` | PyPI account with 2FA and an API token |
| TypeScript client | npm | `@chronograph-community/sdk` | npm account with an automation token |
| Container image | Docker Hub or GHCR | not yet published | Docker Hub account, or a GHCR token |
| Binaries, wheel, source | GitHub Releases | attached to a tag | Write access to this repository |

The two SDK names are already scoped and do not collide with any existing package.
`chronodb` on npm and `chronograph` on crates.io are held by unrelated projects, which is
why the npm package is published under the `@chronograph-community` scope.

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
