# Community and Managed

ChronoDB Community is a self-hosted, source-available temporal graph database
under **PolyForm Perimeter 1.0.0**. You can modify it and use it commercially for
noncompeting purposes. Offering a competing product, including a free one, is
restricted. See [licensing](LICENSING.md) for the full boundary.

| Capability | Community alpha | Managed launch preview |
| --- | --- | --- |
| Embedded Rust engine, history and durable branches | Included | Same underlying engine |
| Scoped tokens, HTTP and native MCP | Included | Project HTTPS endpoints and scoped API keys |
| Browser console, migration editor, connector presets | Included | Hosted console and private projects |
| Typed assets, checkpointed ingestion and language SDKs | Included | Same transport over HTTPS |
| Consistent backup and restore | Local tools | Scheduled graph and encrypted account/configuration snapshots |
| Infrastructure | Operated by you | Separate databases and project processes on a shared host |
| Accounts and teams | Workspace-wide token scopes | GitHub, invited email accounts, MFA, project roles and sessions |
| Provider secrets | Use your own secret store | Encrypted project vault with separate reader keys |
| Billing | No license fee for permitted use; infrastructure costs apply | Subscription pricing not announced |
| Reliability | Alpha with documented limits | No service commitment available yet |

Community requires no cloud account or license server. The [Managed service](HOSTED.md)
adds a private account and project control plane around the same Rust engine.
GitHub signup is available; new email accounts are platform-operator issued while
email delivery is pending. Source for the private backend and operator deployment
configuration is not part of this public Community repository.

Managed currently uses one host with bounded capacity. It has no billing, row-level
policies, organization SSO, automated off-host recovery, HA, or uptime guarantee.
Its application/process isolation is not a claim of independently audited tenant
security. The static Community website demo still uses synthetic data.

Start with [Managed hosting](HOSTED.md), [isolated self-hosting](ISOLATED.md),
[production operations](PRODUCTION.md), [installation](INSTALL.md), [release status](REQUIREMENTS.md) and
[security](SECURITY.md). Build noncompeting applications on Community today;
evaluate the alpha against your own workload before relying on it operationally.
