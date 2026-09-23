export const operator = {
  name: "SAI YOGADA ENTERPRISES PTY LTD",
  tradingName: "IntelliNxT",
  abn: "19 618 905 936",
  acn: "618 905 936",
  location: "Victoria 3167, Australia",
  email: "contact@intellinxt.com.au",
  registry: "https://abr.business.gov.au/ABN/View/19618905936",
};

export interface PolicyPage {
  title: string;
  summary: string;
  sections: { id: string; title: string; body: string }[];
}

const contact = "[contact@intellinxt.com.au](mailto:contact@intellinxt.com.au)";
const company =
  "SAI YOGADA ENTERPRISES PTY LTD, trading as IntelliNxT (ABN 19 618 905 936)";
export const policyDate = "23 September 2026";
export const policies: Record<string, PolicyPage> = {
  privacy: {
    title: "Privacy policy",
    summary: "What we collect, why we need it, and the choices you have.",
    sections: [
      {
        id: "operator",
        title: "Who is responsible",
        body: `ChronoDB Managed is operated by ${company}, based in Victoria, Australia. Contact ${contact} for privacy questions or requests. This policy covers chronodb.co and the hosted account, database and support services. Self-hosted Community operators are responsible for their own deployments; this policy does not give us access to those databases.`,
      },
      {
        id: "information",
        title: "Information we handle",
        body: "**Account information:** your name, email, provider identity, encrypted OAuth tokens where returned, password hash if you use a password, and MFA configuration. We do not receive your Google or GitHub password.\n\n**Project content:** the graph records, historical versions, migrations, assets and secrets that you or your authorised applications submit. Content may include personal information if you choose to store it.\n\n**Operational information:** project membership, roles, credential metadata, security/audit events, IP addresses, browser details, session timestamps and request diagnostics.\n\n**Correspondence:** information you send in a support, security or privacy request. Do not include passwords, API keys or unnecessary personal data in correspondence.",
      },
      {
        id: "purposes",
        title: "How we use it",
        body: "We use account and operational information to authenticate you, provide project access, prevent abuse, investigate incidents, restore service and respond to requests. We process project content to perform your database operations, maintain durability and create recovery copies. We do not sell project content or use it to train foundation models.\n\nWhere a law requires a lawful basis, account/service processing is for providing the requested service, security and abuse prevention serve our legitimate operational interests, and some records may be required by law. Optional uses that require consent will be separately explained. We do not currently run advertising pixels or optional behavioural analytics in the application.",
      },
      {
        id: "sharing",
        title: "Recipients and overseas processing",
        body: "Authorised members of your project can access information according to their role. Your API and MCP keys give access to the software or agents to which you provide them. We use infrastructure and identity providers described on the [subprocessors and providers page](/subprocessors).\n\nThe current primary hosting region is AWS US West (Northern California), **us-west-1**. Cloudflare processes website traffic through its global network. Google or GitHub processes sign-in under its own terms when you choose that provider. This is not an Australia-only or EU-only data-residency service.\n\nWe may disclose information when legally required or necessary to address abuse, protect rights or investigate a security incident. If your organisation requires a specific processing agreement or international transfer mechanism, contact us before uploading that data. We do not represent that a signed DPA or transfer agreement exists merely because you create an account.",
      },
      {
        id: "retention",
        title: "Retention and deletion",
        body: "Project records persist until removed through the supported operations or an operator-assisted deletion. Because ChronoDB keeps history, invalidating an edge or changing a current property does **not** erase all prior versions. Contact us for erasure that must include history, assets and backups.\n\nSessions expire after 12 hours or 30 minutes of inactivity. Setup and email reset links expire after one hour. Security audit records are append-only and do not currently have an automatic age-based purge. Recovery copies use rolling retention; off-host recovery copies require operator review when handling deletion.\n\nAccount closure, full project deletion and historical-data erasure are handled by the operator after verifying your authority and any other owners’ rights. We explain any legally required retention or limited security records that cannot be removed, and confirm the scope and timing of the deletion rather than promising an immediate purge.",
      },
      {
        id: "rights",
        title: "Access, correction and complaints",
        body: `Email ${contact} with “ChronoDB privacy” and the account email concerned. You may request access, correction, export or deletion, or ask about restricting or objecting to processing where applicable. We may request proportionate proof of ownership; never send us your password or MFA recovery codes. Project-content requests may need to be handled with the organisation that controls that project.\n\nWe aim to acknowledge requests within seven days and respond within 30 days, or explain an extension permitted by applicable law. If you are dissatisfied, you may contact the [Office of the Australian Information Commissioner](https://www.oaic.gov.au/privacy/privacy-complaints/lodge-a-privacy-complaint-with-us) where its jurisdiction applies, or your relevant local supervisory authority. Mandatory rights are not limited by this policy.`,
      },
      {
        id: "changes",
        title: "Scope and changes",
        body: "The hosted preview is for adult developers and organisations. It is not approved for identifiable medical, biometric, neural or other regulated sensitive datasets without a separate written assessment and agreement. Use synthetic or properly de-identified data during evaluation.\n\nWe publish the policy date above and update this page when handling practices change. We will provide additional notice of material changes where required by law. See [cookies](/cookies), [security](/security) and [data protection](/data-protection) for the operational details.",
      },
    ],
  },
  terms: {
    title: "Terms of service",
    summary: "The agreement for using ChronoDB Managed.",
    sections: [
      {
        id: "agreement",
        title: "The service and this agreement",
        body: `These terms apply between you and ${company} (“we”, “us”) for the hosted ChronoDB service at chronodb.co. You must be at least 18 and authorised to act for any organisation whose account or data you manage. By creating an account or using the hosted service, you agree to these terms and the [acceptable use policy](/acceptable-use). Our [privacy policy](/privacy) explains information handling.\n\nA separately signed agreement takes precedence for matters it expressly covers. The Community software and SDKs are governed by their published [software licence](/documentation/LICENSING), not a grant of hosted-service rights under these terms.`,
      },
      {
        id: "accounts",
        title: "Accounts and responsibilities",
        body: "Keep account credentials, MFA recovery codes and application keys secure. Use individual accounts for people and appropriately scoped keys for applications. You are responsible for the users, models, MCP agents and software that you authorise, including their writes and migrations. Tell us promptly if you suspect compromised access.\n\nProject owners control membership and permissions. Do not grant access to data you lack authority to disclose. Maintain your own export or backup appropriate to your needs, and review destructive operations before applying them.",
      },
      {
        id: "data",
        title: "Your data and intellectual property",
        body: "You retain your rights in project content. You grant us the limited permission needed to host, copy, transmit and process that content to provide, secure and recover the service and comply with law. This is not ownership of your models, training data, code or graph. You are responsible for the permissions and lawful basis needed to submit and process content.\n\nWe retain rights in our hosted service and branding. Third-party software remains subject to its own licences. Provider integrations are independent services; compatibility examples do not imply partnership or endorsement.",
      },
      {
        id: "availability",
        title: "Preview, capacity and fees",
        body: "The current hosted offering is a launch preview with bounded project and storage capacity. Published limits and available features are described in the [Managed guide](/documentation/HOSTED). There is no automatic scaling, contractual uptime SLA or 24/7 response commitment under these terms.\n\nSelf-service billing is not enabled. We will not automatically enrol a preview account in a paid subscription. Any paid service requires clearly disclosed pricing and your agreement before charges. If features or limits materially change, we will provide reasonable notice where practicable, with urgent security measures taking effect when necessary.",
      },
      {
        id: "safety",
        title: "Appropriate use",
        body: "ChronoDB stores and retrieves data. It is not a certified medical device, a clinical decision service, a safety controller or a guarantee of a model’s accuracy. You must independently validate applications that use its results. The public preview must not be the sole control for a safety-critical physical system.\n\nDo not upload identifiable health, biometric, neural, payment-card or other regulated sensitive information unless we have expressly agreed the required controls and contractual terms. The [data protection page](/data-protection) explains the current scope.",
      },
      {
        id: "suspension",
        title: "Suspension, closure and export",
        body: `We may restrict access to address a credible security incident, unlawful conduct, material breach, or a legal requirement. We will explain the reason and provide an opportunity to resolve it where lawful and practicable. Emergency measures may precede notice.\n\nYou may stop using the service and request account or project closure through ${contact}. We verify ownership and address other project owners’ rights before deletion. Export your data first. Closing an account is not an instantaneous purge of historical versions or recovery copies; we explain the applicable deletion scope and any required retention. A suspension is not permission to use your content for another purpose.`,
      },
      {
        id: "rights",
        title: "Service assurances and mandatory rights",
        body: "We provide the service with reasonable care and work to resolve reported faults. We do not promise uninterrupted availability, error-free model outputs, compatibility with every workload, or recovery from every failure. Liability and available remedies remain subject to applicable law and any separate written agreement.\n\nNothing in these terms excludes or restricts rights or guarantees that cannot lawfully be excluded, including applicable Australian Consumer Law guarantees. We do not impose a blanket waiver of those rights or require you to waive a lawful complaint.",
      },
      {
        id: "disputes",
        title: "Contact and changes",
        body: `Contact ${contact} with questions, disputes or a request for a commercial agreement. We will first seek to resolve a dispute in good faith. Australian law and the law applicable to the operator in Victoria apply, subject to mandatory protections and any courts or authorities that otherwise have jurisdiction.\n\nWe publish revisions with their effective date. Material changes will be notified in the service or by another appropriate channel where practicable. Changes do not retrospectively remove rights that have already accrued.`,
      },
    ],
  },
  "data-protection": {
    title: "Data protection",
    summary: "Understand the processing model before connecting your workload.",
    sections: [
      {
        id: "roles",
        title: "Your project, your instructions",
        body: "You decide what goes into a project, why it is processed and who can access it. For personal information in your project, your organisation normally determines the purpose and lawful basis; ChronoDB processes the content to execute your service instructions. We separately determine necessary account administration, abuse prevention and operational security processing. The precise legal roles depend on the applicable law and contract.",
      },
      {
        id: "scope",
        title: "Processing scope",
        body: "**Purpose:** hosting temporal graphs, relationships, historical versions, migrations and associated assets; authenticating access; executing API/MCP requests; and maintaining recovery copies.\n\n**Operations:** collection through your requests, storage, indexing, retrieval, modification, export and supported deletion.\n\n**Data and people:** determined by your workload. Typical account data concerns developers and authorised collaborators. Minimise identifiers in project content and use synthetic data for evaluation.\n\n**Duration:** while the service is provided and during necessary retention and recovery handling described in the privacy policy. Historical versions require explicit erasure handling.",
      },
      {
        id: "controls",
        title: "Controls available today",
        body: "- HTTPS for public connections; native graph processes listen on loopback.\n- Cookie-based console sessions, verified social identities and mandatory MFA.\n- Project membership roles and expiring application keys.\n- Project-scoped encrypted secret storage and encrypted identity recovery bundles.\n- Durable writes, schema revision checks and backup/restore procedures.\n- Append-only audit events and request-rate limits.\n\nProjects have separate graph data and native processes, but share the host and control-plane service identity. This is application-enforced isolation, not a dedicated VM per customer. Do not interpret vault encryption as a claim that every native graph file is encrypted by the engine.",
      },
      {
        id: "location",
        title: "Location and service providers",
        body: "The primary runtime is in AWS us-west-1 in the United States. Cloudflare handles traffic globally. Identity providers receive sign-in requests when selected. See [subprocessors and providers](/subprocessors) for their roles. Dedicated regions, customer-managed encryption keys and private-network deployment are not included in the current hosted preview.",
      },
      {
        id: "requests",
        title: "Requests and incidents",
        body: `Send an access, correction, export, deletion or processing question to ${contact}. Include the project ID and your account email, but no project secrets. We verify your authority and coordinate with the relevant project owner. For a suspected incident, use the [security reporting process](/security#reporting). We investigate, take containment steps and provide legally required notifications based on the incident and affected data.`,
      },
      {
        id: "agreement",
        title: "Processing agreements and regulated workloads",
        body: `This page describes the current service; it is not an executed Data Processing Agreement or a transfer safeguard. Contact ${contact} before workloads that require a signed DPA, standard contractual clauses, a BAA, a specific residency obligation or negotiated incident/retention terms. Do not upload those workloads until the necessary agreement and controls are in place.\n\nWe make no SOC 2, ISO 27001, HIPAA or blanket GDPR certification claim. BCI, robotics and quantum examples describe data formats and connectors; they do not establish regulatory approval for the resulting application.`,
      },
    ],
  },
  security: {
    title: "Security",
    summary:
      "Concrete controls, clear responsibilities and a private reporting channel.",
    sections: [
      {
        id: "identity",
        title: "Identity and access",
        body: "Console access uses Google, GitHub or an email/password account and a second factor. Sessions use secure HttpOnly cookies and expire after 12 hours or 30 minutes idle. Sensitive operations require recent MFA verification. Password resets revoke sessions and preserve MFA. Unclaimed operator invitations can be claimed only after a provider verifies the matching email; established accounts retain stricter linking checks.",
      },
      {
        id: "applications",
        title: "Applications and agents",
        body: "Use a separate expiring key for each trusted backend or MCP agent. Read, ingest and admin scopes have different permissions. Keep keys on servers, rotate them when exposed and revoke them when an integration is removed. Browser sessions cannot authenticate MCP clients. Secrets in the vault require separate secret-reader credentials. Never expose an admin or secret-reader key in a public website bundle.",
      },
      {
        id: "operations",
        title: "Hosting and recovery",
        body: "Public traffic uses HTTPS through Cloudflare and the origin proxy. The service runs with restricted operating-system identities; database ports are not publicly exposed. Project secrets and identity/configuration backup bundles use authenticated encryption. Hosted writes enforce fsync, and migrations check the schema revision before applying changes.\n\nThe service has health monitoring and recovery procedures, but remains a single-host launch preview. Customers should keep exports suited to their needs. No independent security certification or external penetration-test attestation is claimed.",
      },
      {
        id: "reporting",
        title: "Report a vulnerability",
        body: `Email ${contact} with the subject “ChronoDB security”. Include the affected route/version, reproduction steps, impact and a minimal redacted example. Do not publish credentials, other customers’ records or exploit details in a public GitHub issue.\n\nUse only accounts and data you control. Stop if you encounter another person’s data; do not extract it, persist access, perform denial-of-service tests or modify production data. Ask before testing outside that scope. We will assess good-faith reports and coordinate remediation; no bounty or response-time SLA is promised.`,
      },
    ],
  },
  subprocessors: {
    title: "Subprocessors & providers",
    summary: "The services involved in running the current hosted deployment.",
    sections: [
      {
        id: "infrastructure",
        title: "Infrastructure",
        body: "| Provider | Function and data | Location |\n| --- | --- | --- |\n| Amazon Web Services | Compute and storage for account records, project data and operational recovery | Primary region: us-west-1, Northern California, US |\n| Cloudflare | DNS, HTTPS proxy and traffic/security processing; can process IP addresses, request metadata and proxied content | Global network |\n\nProvider information: [AWS privacy](https://aws.amazon.com/privacy/) · [Cloudflare privacy](https://www.cloudflare.com/privacypolicy/). Provider policies do not replace a processing agreement between your organisation and us.",
      },
      {
        id: "identity",
        title: "Identity providers you choose",
        body: "Google and GitHub handle OAuth sign-in when you select them. ChronoDB receives identity attributes such as provider ID, name, email/verification status and any returned profile image, plus server-side tokens needed by the flow. Their independent account processing is governed by their own policies: [Google](https://policies.google.com/privacy) and [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). ChronoDB does not request access to Google Drive, Gmail or private GitHub repositories.",
      },
      {
        id: "optional",
        title: "Optional delivery and integrations",
        body: "Resend is the supported transactional email provider. It is used only when email delivery is configured, for recipient addresses and account verification/reset messages. The current sign-in and recovery pages report whether delivery is available. See [Resend’s legal information](https://resend.com/legal).\n\nModels and connectors are customer-configured integrations, not automatically connected subprocessors. An SDK example does not send your graph to a model provider. Data is shared with an external application when you configure and authorise that application. Payment processing and advertising providers are not connected to this deployment.",
      },
      {
        id: "changes",
        title: "Questions and changes",
        body: `We update this page when the service’s provider arrangements change. Contract-specific notice or objection procedures must be agreed in the applicable processing agreement. Contact ${contact} for the current arrangements before a regulated workload or procurement review.`,
      },
    ],
  },
  cookies: {
    title: "Cookies & browser storage",
    summary:
      "Essential storage for sign-in, security and workspace preferences.",
    sections: [
      {
        id: "essential",
        title: "Essential cookies",
        body: "The Managed service uses authentication cookies under the `chronograph` prefix, including its session token, OAuth state and MFA challenge cookies. A `__Secure-` prefix may also appear in production. These names remain for compatibility following the ChronoDB rename. Session cookies are HttpOnly, Secure on HTTPS and SameSite=Lax.\n\nThe server enforces a maximum 12-hour session lifetime and a 30-minute idle timeout. OAuth and MFA challenges are short-lived. Signing out revokes the active session; removing browser cookies also signs that browser out. Cloudflare may set essential security/challenge cookies as needed by its protection features.",
      },
      {
        id: "preferences",
        title: "Local preferences",
        body: "The application can use browser storage for workspace/editor preferences and local drafts. The Managed console does not store your account password, MFA recovery codes or session bearer token in localStorage. Treat local drafts and downloaded exports as data on your own device, particularly on shared computers. The isolated Community client has a different credential model described in its documentation.",
      },
      {
        id: "choices",
        title: "Your choices",
        body: "We do not currently include optional advertising pixels or behavioural analytics cookies, so there is no optional tracking category to enable. Blocking essential cookies prevents account sign-in. You can clear site data in your browser; export drafts you need first. If optional tracking is introduced, its controls and this notice will be updated before it is enabled where consent is required.\n\nGoogle and GitHub use their own cookies on their sign-in pages. See their privacy notices and the [provider list](/subprocessors).",
      },
    ],
  },
  "acceptable-use": {
    title: "Acceptable use",
    summary:
      "Protect your projects, other users and the infrastructure we share.",
    sections: [
      {
        id: "allowed",
        title: "Build with appropriate authority",
        body: "Use ChronoDB for lawful development, research and application workloads for which you have the necessary rights and permissions. You remain responsible for model outputs, agent actions, data licences and the physical systems connected to your application.",
      },
      {
        id: "prohibited",
        title: "Prohibited conduct",
        body: "Do not access another customer’s project, bypass roles or limits, steal credentials, distribute malware, conduct credential stuffing or use the service for unlawful surveillance. Do not overload the service, evade rate limits, create accounts to bypass capacity limits, or attempt destructive testing against shared infrastructure. Do not store illegal content or submit information you are not authorised to process.\n\nThe public preview is not authorised for identifiable medical, biometric or neural datasets, payment-card data, or regulated sensitive workloads without a separate written agreement. Do not rely on it as the sole safety controller for a robot, medical system or other hazardous operation.",
      },
      {
        id: "agents",
        title: "Agents and integrations",
        body: "Actions performed with your keys are your authorised application actions. Start agents with read access, grant writes deliberately, and review migrations or destructive changes. Test integrations on disposable data. Revoke keys promptly when a device, service or collaborator should no longer have access.",
      },
      {
        id: "enforcement",
        title: "Reporting and enforcement",
        body: `Report abuse to ${contact} with a redacted description and relevant request ID. We may restrict access to contain harm or comply with law, and provide notice and an opportunity to respond where lawful and practicable. Good-faith security research must follow the [security reporting process](/security#reporting).`,
      },
    ],
  },
  legal: {
    title: "Legal & company information",
    summary: "The operator behind ChronoDB Managed.",
    sections: [
      {
        id: "company",
        title: "Operator",
        body: `**${operator.name}**\n\nTrading as **${operator.tradingName}**\n\nABN **${operator.abn}** · ACN **${operator.acn}**\n\nMain business location listed on the Australian Business Register: **${operator.location}**. This locality is not a published street or registered-office address. For formal service or postal correspondence, request the appropriate address through ${contact}.\n\n[View the Australian Business Register record](${operator.registry}) · [IntelliNxT website](https://intellinxt.com.au)`,
      },
      {
        id: "documents",
        title: "Service documents",
        body: "The [terms of service](/terms) govern the hosted service. The [privacy policy](/privacy), [data protection information](/data-protection), [cookie notice](/cookies) and [acceptable use policy](/acceptable-use) describe its operation and responsibilities. The [Community licence](/documentation/LICENSING) separately governs the published software.\n\nChronoDB compatibility with Google, GitHub, TypeSafe Jev, MCP clients or other model ecosystems does not imply ownership, certification, affiliation or endorsement by those organisations.",
      },
      {
        id: "contact",
        title: "Contact",
        body: `Support, privacy, legal and security correspondence: ${contact}. Please put “ChronoDB” and your topic in the subject. See [support](/support) for information that helps us handle a request without exposing your data.`,
      },
    ],
  },
  support: {
    title: "Support",
    summary: "Get help with your account, projects or deployment.",
    sections: [
      {
        id: "contact",
        title: "Contact the team",
        body: `Email ${contact} with “ChronoDB support” in the subject. Include your account email, project ID, the affected screen or endpoint, approximate time/timezone, and a request ID if shown. A short redacted reproduction is more useful than a full database export. Never send passwords, tokens, recovery codes or unredacted customer records.\n\nSupport is handled by the operator during business availability; the launch preview has no 24/7 support or contractual response SLA.`,
      },
      {
        id: "account",
        title: "Account help",
        body: "Use [sign in](/login) for Google, GitHub or your email/password account. Use [Forgot password](/forgot-password) for the current recovery options. A linked provider can sign you in without an email password. If you lose your authenticator, use a saved one-use recovery code. Losing both requires operator-assisted identity verification; a password reset does not remove MFA.",
      },
      {
        id: "projects",
        title: "Projects and data",
        body: "Start with the [Managed guide](/documentation/HOSTED), [migration guide](/documentation/SCHEMA) and [API documentation](/documentation/API). Capacity errors are real host limits; contact us to discuss additional capacity. Keep separate exported backups for data you cannot replace. For full project deletion, account closure, historical-data erasure or a processing agreement, contact the operator with proof of authority.",
      },
      {
        id: "reporting",
        title: "Choose the right channel",
        body: "Check [service status](/status) for a current connectivity check. Report security issues privately using the [security process](/security#reporting). Use the [privacy request process](/privacy#rights) for personal information. General Community code issues can be filed on [GitHub](https://github.com/enablewmodels-sys/chronograph/issues); keep hosted-account and security details out of public issues.",
      },
    ],
  },
};
