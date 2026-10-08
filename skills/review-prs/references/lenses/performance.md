# Lens: performance

Regressions the diff introduces. Quantify where you can: rows, queries per request, bytes.

- **N+1:** a query inside a loop, `await` inside `map` over rows, a per-row fetch in a resolver or component.
- **Missing indexes:** a new `WHERE`, `JOIN` or `ORDER BY` column, or a foreign key, without an index, on a table that grows with users.
- **Unbounded queries:** no `LIMIT` or pagination on user-growing data; `SELECT *` on a wide table in a hot path.
- **Large lists:** rendering unbounded rows with no pagination or virtualization.
- **Bundle growth:** a heavy new dependency, a server-only library imported into client code, no dynamic import for heavy, rarely used UI.
- **Request-path work:** heavy synchronous computation, or sequential awaits that could run together where the repository has a pattern for it.

You run nothing: no `EXPLAIN`, no analyzer, no benchmark. Reason from the code and say what you could not measure.
