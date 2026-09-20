# Deploy the website on Vercel

The public website contains the landing page, documentation and a synthetic,
read-only console demo. It has no graph service, API credentials, sign-in system
or Managed account provisioning. To store data, [run Community](INSTALL.md) on
your own machine or follow the [single-host deployment guide](DEPLOYMENT.md).

## Import the repository

1. In Vercel, add a new project and import `enablewmodels-sys/chronograph`.
2. Keep **Root Directory** at the repository root (`.`), not `ui`.
3. Use **Other** as the framework preset. The committed `vercel.json` sets the
   install command, build command, output directory, route rewrites and headers.
4. Deploy. No application secrets, database token or Rust toolchain are needed.
5. Check the landing, `/documentation/QUICKSTART`, `/documentation/LICENSING`
   and `/app` on the generated HTTPS URL, including a direct reload.

The install command is `npm --prefix ui ci`, the build command is
`node scripts/build-site.mjs`, and the output is `dist/site`. Node 22 is suitable.
The owner performs the Vercel deployment; a committed configuration does not mean
an external site is already live. Vercel Git access must include this repository.

## Reproduce or host elsewhere

```sh
npm --prefix ui ci
node scripts/build-site.mjs
```

Serve `dist/site/` as static files. For a subdirectory deployment, set
`CHRONOGRAPH_SITE_BASE=/chronograph/` before building and serve that output at the
same prefix. The builder writes route entry files for direct links and reloads.
It copies only public documentation, UI assets and license notices. Each build
uses a separate output directory from the self-hosted console.

API calls are disabled in the public build. The synthetic console stays read only
and does not accept a workspace token. The native/server build retains normal
token authentication and its existing same-origin API behavior.

## Hosting the database

The Rust service is a long-running process owning a durable journal and local
assets. This Vercel static deployment does not run it. Host it on a suitable VM or
container service with persistent disk, private auth configuration and TLS. The
native bundle serves its own authenticated UI at the configured origin; see
[deployment](DEPLOYMENT.md). There is no browser-side token forwarding from the
public demo to an arbitrary database URL.

## Maintain the release

Changes should pass the Verify workflow before release. Build native bundles with
the `Build unsigned Community candidates` workflow; inspect each target's smoke
result before attaching its archive to a release. Publish versioned alpha tags
and include checksum files, source, license and upstream notices. Do not overwrite
an older release's artifacts. The website provisions no database or billing account.

## GitHub Pages

The repository includes `.github/workflows/pages.yml`, which builds the public
site with base path `/chronograph/` and deploys it through GitHub Actions. A
repository owner should choose **Settings → Pages → Build and deployment →
Source: GitHub Actions**. This avoids the redundant legacy Jekyll job, which can
fail while interpreting code examples as Liquid. The current push-capable GitHub
identity cannot change repository Pages settings. The EC2 hosted alpha has its
own deployment and hostname.
