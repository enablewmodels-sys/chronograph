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

## Keep the UI editions separate

| Deployment | Build command | Output | Human access |
| --- | --- | --- | --- |
| Public Community website | `node scripts/build-site.mjs` | `dist/site` | Synthetic demo |
| Self-hosted Community database | `npm --prefix ui run build` | `ui/dist` | Scoped engine credentials |
| Managed account service | `npm --prefix ui run build:managed` | `ui/dist-managed` | Google, GitHub, or an existing email account |

Each build includes `chronodb-build.json` and an edition tag in `index.html`.
Before deploying, run `node scripts/verify-ui-build.mjs <output> <edition>`,
where the edition is `public`, `community`, or `managed`. The Managed build
explicitly selects its edition and writes a separate directory, so a later
Community test build cannot overwrite the artifact intended for hosting.

The Managed gateway also declares the edition in the HTML it serves. This
controls the interface only; the server independently enforces account sessions,
project membership and API key scopes. Never deploy the static public demo
as a replacement for the Managed account service. Google/GitHub account creation
requires configured providers; email registration and recovery additionally
require configured email delivery. A project API key is for software access,
not a substitute for signing in to the hosted console.

## Hold the mobile floor

A phone is a width, not a device, and the stylesheets used to make text smaller as the window got
narrower. The floors now live in one file, `ui/src/mobile.css`, in two queries:

- `max-width: 900px` — type and touch. Nothing a reader reads is under 12px, prose is at least 14px,
  a disclosure row or a control is at least 40px tall, and a navigation folds instead of scrolling
  sideways. This reaches to 900px because a 768px tablet in portrait is a touch device too.
- `max-width: 700px` — layout. Grids stack, section padding shrinks, and the help tooltip becomes a
  sheet along the bottom edge.

Measure a change with the committed suite, not by eye:

```sh
cd ui && node node_modules/@playwright/test/cli.js test e2e/mobile.spec.ts       # public pages
cd ui && node node_modules/@playwright/test/cli.js test e2e/console-mobile.spec.ts  # the console
```

`ui/e2e/mobile-floor.ts` is the measurement both suites share. It reports sideways scrolling, text
past the viewport, text under 12px, controls under 40px, a navigation that scrolls instead of
folding, and a label cut off with an ellipsis. The console suite measures the Community edition on
the isolated test server and the Managed edition against `scripts/managed-local.mjs`.

Measure the boundary widths, not only 390px. Every defect found so far sat between two breakpoints:
the information pages' section nav scrolled from 701px to 760px because the component stylesheet
starts its scroller at 760px while the fold rule stopped at 700px, and the console's two-column grid
was wider than the window from 901px to about 944px. When you add or move a narrow-width rule in a
component stylesheet, check the width on both sides of its breakpoint.

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
