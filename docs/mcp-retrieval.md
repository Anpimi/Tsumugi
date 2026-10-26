# Retrieve term proposals from an MCP server

The experimental inbound MCP adapter lets you query an external terminology server over Streamable HTTP.

To set up a query:
1. In **Glossary and context**, open the query workspace and select **MCP**.
2. Enter the server endpoint URL and, if authentication is needed, the name of a credential environment variable.
3. Select a single source entry and target language. (Saving or reopening a draft does not connect to the server.)
4. Authorize tool discovery. Because tool descriptions and schemas come from an untrusted remote server, review them carefully and select a tool that implements the terminology profile described below.
5. Review the preview—including the exact query string, locales, server endpoint, and tool—and give separate consent to run the query.

Only the previewed arguments (`query`, `sourceLocale`, and `targetLocale`) are sent to the server. Tsumugi never includes your project directory, neighboring entries, current translations, saved context, or adopted glossary terms. Keep in mind that the remote service may log or forward your request, and its own usage policies and billing apply.

Each discovery grant allows at most one query within a two-minute window; retrying or reconciling an acknowledgement does not extend that timer. Server-supplied tool annotations such as `readOnlyHint` are treated as untrusted claims and do not bypass confirmation or guarantee that the server has no side effects.

## Optional fixed query for an ordinary Pi member

Once you prepare a query in **Resources**, you can pass its fixed preview into AI work-plan preparation so a standard, non-delegated Pi member can run it during a task:

- **Explicit dual disclosure**: When approving the work plan, you review the server endpoint, tool, query text, entry, language, and deadline, and explicitly authorize both sending the query to the MCP server once and forwarding the returned terms to the model provider. Approving a manual query in **Resources** alone does not enable model tool access.
- **Fixed execution scope**: This opt-in profile supports a single entry and an ordinary Pi member (not multi-agent teams, arbitrary MCP tools, or model-authored queries). The member can only call `lookup_captured_terms` for the prepared entry and cannot alter the server, tool, arguments, or credential variable.
- **Budgets and limits**: The MCP tool call adds at most one tool invocation to the SDK allowance; accepted and uncertain invocations remain counted, and subsequent model calls draw from the standard model-request budget. Both the MCP result size limit and the overall model-request limit apply independently, and oversized responses fail rather than being truncated.
- **Lifetimes and recovery**: The original two-minute discovery deadline still applies, including time spent preparing the plan. If a query stops, expires, or is reopened from history, it cannot be re-authorized from an existing plan; you must prepare and approve a new plan. Removing an AI draft does not cancel an in-flight external request—use the service session's recovery controls to stop it.

When the query succeeds, its output is passed to the model as untrusted tool output without automatically adopting terms or modifying translations. Missing or uncertain results are not automatically replayed, and reopening a project reads saved history without reconnecting to the server.

## Service identity and credentials

Endpoints must be an exact HTTPS URL, or an explicit literal loopback HTTP URL for local services. URLs containing usernames, passwords, query strings, or fragments are rejected.

The adapter uses the official Rust MCP SDK's client and message types over a bounded HTTP transport with redirects, inherited proxy settings, automatic session reinitialization, transparent retries, and stale catalog fallbacks disabled.

For authenticated servers, store your token in an environment variable prefixed with `TSUMUGI_MCP_CLIENT_` before launching Tsumugi, and enter the variable name (never the secret itself) in the query form. Leave the field blank to send an unauthenticated request. The adapter never reuses model-provider API keys, desktop session tokens, outbound MCP pairing credentials, or system logins, and only the environment variable name is recorded in local execution provenance.

## Supported terminology profile

The adapter supports the `tsumugi.mcp.term-query-1` profile. The tool input must be a JSON object with exactly `query`, `sourceLocale`, and `targetLocale`:

```json
{
  "query": "Copper Ore",
  "sourceLocale": "en",
  "targetLocale": "zh-CN"
}
```

The `query` string must be a non-empty, exact substring of the selected source entry (whitespace is preserved, not silently trimmed).

Successful responses must return `structuredContent` matching this structure:

```json
{
  "entries": [
    {
      "id": "copper-ore",
      "source": "Copper Ore",
      "target": "铜矿石",
      "reason": "Suggested game terminology"
    }
  ]
}
```

Each proposed `source` phrase must appear within the submitted `query`.

The server tool must declare the exact canonical input and output schemas defined by `mcp_term_query_input_schema` and `mcp_term_query_output_schema` in [`crates/core/src/application/mcp_retrieval.rs`](../crates/core/src/application/mcp_retrieval.rs). While JSON key ordering does not matter, all schema values—including `required` arrays—must match verbatim; the adapter does not attempt to infer equivalence between arbitrary JSON Schemas.

The adapter enforces strict boundaries on responses:
- **Size limits**: Queries are capped at 16 KiB of UTF-8. Structured results are capped at 64 KiB and 100 entries. Catalog, schema, frame, and cumulative connection limits are enforced independently without silent truncation or partial adoption.
- **No active content**: Extra fields, duplicate entry IDs, out-of-scope terms, and plain-text blocks are rejected. The adapter does not fetch returned URIs, follow server instructions or tasks, or respond to interactive server prompts.

## Review, stop and recover

Every query records its input, task identity, and raw result in project history, along with the MCP service, tool, schema, and execution provenance (without making license claims on behalf of the server).

Running a query only collects proposals:
- **Review and adoption**: Create a resource preview from the saved result to compare and accept or ignore individual terms. Adopting a term checks the source and current term revisions, respects manual overrides, and does not rewrite existing translations. Unadopted proposals are excluded from normal terminology resolution.
- **Incremental updates**: Query results are treated as point-in-time proposals rather than full glossary snapshots—terms missing from a later query are not deleted. Repeated proposals for the same server, tool, source entry, locale, and external entry ID use the standard term revision checks while keeping each run's provenance intact.
- **Stopping and reconciliation**: Stopping a query prevents new admission and indicates whether an already accepted request is still draining; cancelling the local wait cannot undo work already performed by the remote server. If a response is lost, reconcile the existing operation rather than expecting an automatic retry.
- **Session lifecycle**: Closing or switching projects, reaching the deadline, or quitting Tsumugi revokes live permissions. Reopening a project lets you inspect saved results and decisions offline; running another query requires a fresh discovery, preview, and consent. This adapter only connects to remote HTTP endpoints and never launches local stdio servers.
