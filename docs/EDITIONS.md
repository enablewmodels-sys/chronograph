# Community and Managed

Chronograph Community is a self-hosted, source-available temporal graph database
under **PolyForm Perimeter 1.0.0**. You can modify it and use it commercially for
noncompeting purposes. Offering a competing product, including a free one, is
restricted. See [licensing](LICENSING.md) for the full boundary.

| Capability | Community alpha | Hosted alpha / planned expansion |
| --- | --- | --- |
| Embedded Rust engine, history and durable branches | Included | Same underlying engine |
| Scoped tokens, HTTP and native MCP | Included | Hosted HTTPS workspace endpoint |
| Browser console, migration editor, connector presets | Included | Hosted console |
| Typed assets, checkpointed ingestion and language SDKs | Included | Same transport over HTTPS |
| Consistent backup and restore | Local tools | Scheduled local archives; remote automation planned |
| Infrastructure | Operated by you | Isolated hosted workspace and storage |
| Accounts and teams | Workspace-wide token scopes | Operator-issued tokens; accounts/team roles planned |
| Billing | No license fee for permitted use; infrastructure costs apply | Subscription pricing not announced |
| Reliability | Alpha with documented limits | No service commitment available yet |

Community requires no cloud account or license server. An invitation-only
[hosted alpha](HOSTED.md) runs the same engine on a dedicated single-workspace
service. Its private operator deployment configuration is not included in this
public repository. Self-service accounts, tenant provisioning and billing remain
unimplemented; there is no subscription or uptime guarantee. The static Community
website demo still uses synthetic data.

Start with [installation](INSTALL.md), [release status](REQUIREMENTS.md) and
[security](SECURITY.md). Build noncompeting applications on Community today;
evaluate the alpha against your own workload before relying on it operationally.
