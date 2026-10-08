# Lens: security

Write every finding in full sentences, starting its `problem` with `SECURITY:`. Say what an attacker or a mistake can do, and to whom. No length cap applies.

- **Authentication:** a new entry point that skips the session check; token handling; session fixation.
- **Authorization:** every new route, procedure, query or server action checks that the caller may act on that specific resource. Tenant scoping, direct object references, role checks. Compare with how the neighbouring entry points do it and cite both.
- **Payments:** amounts computed on the server, idempotency keys, webhook signature verification, no trust in a price the client sends.
- **Row-level security:** enabled on every new table; policies correct for select, insert, update and delete; no `using (true)`; service-role or admin clients only where justified.
- **Secrets:** none committed; server-only values not exposed to client bundles; no secrets in logs or error messages.
- **Personal data:** not logged, not sent to third parties without need, not in URLs or analytics payloads.
- **Deletion:** irreversible deletes are guarded and scoped; cascades understood; the repository's soft-delete convention followed.
- **Injection and input:** SQL built from strings, unescaped HTML, server-side request forgery, open redirects, path traversal, unsafe deserialization.
- **Dependencies:** a new package with an install script or a known advisory.

Read the whole diff, not only the files a path rule matched.
