# C# / .NET SDK changelog

Registry status: **not published**. `ChronoDB.Client` `0.4.0-alpha.3` exists as source
in this repository only. No version has been pushed to nuget.org, and no `dotnet` build or
pack has been run in this workspace (the .NET SDK is not installed here).

## Unreleased - NuGet packaging

- `Chronograph/Chronograph.csproj` now carries the metadata NuGet requires: `PackageId`,
  `Version` `0.4.0-alpha.3`, `Title`, `Authors` and `Company` (ChronoDB, Inc.), `Product`,
  `Copyright`, `Description`, `PackageTags`, `PackageProjectUrl`, `RepositoryUrl`,
  `RepositoryType` git, `PublishRepositoryUrl`, `PackageReleaseNotes` and `IsPackable`.
- Licence handling uses `PackageLicenseFile` LICENSE rather than `PackageLicenseExpression`,
  because PolyForm Perimeter 1.0.0 is source-available, not OSI-approved and not an SPDX
  expression. The unmodified licence text and the `Required Notice:` lines are packed.
- `PackageReadmeFile` README.md is declared and the readme is packed at the package root, so
  the package is not broken on restore.
- `Conformance/Conformance.csproj` sets `IsPackable` false so the conformance console is
  never packed or pushed by accident.
- Not verified by a real build: the .NET SDK is unavailable in this workspace, so
  `dotnet pack` and the produced nuspec are untested. IDs were checked against the nuget.org
  API instead (no `chronograph.community` package exists today).
- Blockers: a nuget.org account and API key, confirmation that the `Chronograph.*` ID prefix
  is not reserved by the unrelated owner of the existing `Chronograph` and `Chronograph.Core`
  packages, and a first successful `dotnet pack` on a machine with the SDK. See
  "Publishing to NuGet" in README.md.

## 0.4.0-alpha.3 - 2026-09-30

- Initial source package for the ChronoDB Community `/v1` API: `CallAsync`, `RequestAsync`,
  `IngestAsync` and `CheckpointAsync` with `CancellationToken` support, a 30-second default
  timeout and 4 MiB request/response caps, origin and bearer-token validation, HTTPS for
  remote origins, redirect rejection and bounded response bodies.
- `ApiException` exposes `Status`, `Code` and `RetryAfter`. `PagesAsync` iterates graph and BCI
  pages incrementally with a 1-10,000 page budget; `UploadAssetAsync`/`ReadAssetAsync` handle
  1 byte-16 MiB assets. No application write retries are performed.
- Distributed as source only; no package-registry release is implied.
