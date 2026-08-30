# Security Policy

Security reports are welcome and should be handled privately when disclosure could expose users, infrastructure, credentials, model-provider secrets, or exploitable runtime behavior.

## Reporting

Prefer GitHub private vulnerability reporting or a private security advisory when available. Do not publish exploit details in a public issue before maintainers have had a reasonable opportunity to assess and remediate the problem.

A useful report identifies the affected commit or surface, impact and realistic preconditions, safe reproduction steps, and whether the issue concerns provider adapters, model routing, memory/tool execution, evaluation, observability, or another reusable runtime primitive.

Never include live credentials, API keys, private data, access tokens, or secrets in reports or fixtures.

## Scope

Security fixes must preserve the product-agnostic boundary. Product-specific authorization or protocol semantics must not be introduced into the shared AI foundation as a security shortcut.

Third-party model, dataset, runtime, and dependency vulnerabilities should identify the affected component and version/range when known.

---

© 2026 aiaiaiai · aiaiaiai.org
