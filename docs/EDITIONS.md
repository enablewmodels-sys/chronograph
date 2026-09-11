# Community and Managed

Chronograph Community is a self-hosted, source-available temporal graph database
under **PolyForm Perimeter 1.0.0**. You can modify it and use it commercially for
noncompeting purposes. Offering a competing product, including a free one, is
restricted. See [licensing](LICENSING.md) for the full boundary.

| Capability | Community alpha | Managed plan |
| --- | --- | --- |
| Embedded Rust engine, history and durable branches | Included | Same underlying engine |
| Scoped tokens, HTTP and native MCP | Included | Hosted workspace endpoints |
| Browser console, migration editor, connector presets | Included | Hosted console |
| Typed assets, checkpointed ingestion, Python SDK and local agent | Included | Managed ingestion operations |
| Consistent backup and restore | Local tools | Scheduled off-host backups and recovery |
| Infrastructure | Operated by you | Isolated hosted workspace and storage |
| Accounts and teams | Workspace-wide token scopes | GitHub sign-in and team roles |
| Billing | No license fee for permitted use; infrastructure costs apply | Subscription pricing not announced |
| Reliability | Alpha with documented limits | No service commitment available yet |

Community requires no cloud account or license server. Managed will be a separate
private platform; it is not included in this public repository. There is no live
hosted signup, billing integration, subscription or uptime guarantee. A static
website demo does not run a database for visitors.

Start with [installation](INSTALL.md), [release status](REQUIREMENTS.md) and
[security](SECURITY.md). Build noncompeting applications on Community today;
evaluate the alpha against your own workload before relying on it operationally.
