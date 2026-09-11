# Security reporting

Chronograph Community 0.4.0-alpha.2 is an alpha. There is no response SLA or
third-party penetration-test certification. The supported review target is the
latest Community alpha; older local candidates are not maintained release lines.

Do not disclose exploitable details, credentials or private recordings in a public
issue. Check the repository's **Security → Report a vulnerability** private channel.
If unavailable, open an issue asking only for a private reporting contact, without
the finding or reproduction. A repository administrator must enable GitHub private
vulnerability reporting; this publishing account cannot change security settings.

Once a private channel is available, include the affected version, a minimal
synthetic reproduction, the expected boundary, impact and whether persistence or
credentials were exposed. Use disposable test data and never submit real tokens.

Read [the threat model](docs/SECURITY.md), [operations](docs/OPERATIONS.md) and
[known limits](docs/LIMITATIONS.md). The public website serves only static docs
and synthetic examples. A real service needs private configuration, scoped tokens,
TLS termination and deployment checks. Dependency audits are point-in-time checks;
the unmaintained transitive `paste` crate is tracked separately from vulnerabilities.
