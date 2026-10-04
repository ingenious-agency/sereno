# Security policy

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/ingenious-agency/sereno/security/advisories/new). Please report new vulnerabilities privately before posting public issues or pull requests with exploit details.

Include:

- The affected version or commit.
- The impact and required access or configuration.
- Reproduction steps using synthetic data.
- A suggested fix, if available.

Do not include real credentials, private configuration, live discovery snapshots, or identifying infrastructure details.

## Supported versions

Security fixes target the current `main` branch and latest release. Older releases are not maintained separately. Responses and fixes are best effort; there is no guaranteed response time.

## Local execution

Sereno runs with the current user's permissions. Docker and service-management access can carry substantial authority. AI explanations use the configured provider; the default Codex provider performs hosted inference. Local execution alone does not make logs safe to share or send to a model.
