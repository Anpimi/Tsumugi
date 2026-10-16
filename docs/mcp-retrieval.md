# Retrieve term proposals from an MCP server

The experimental inbound MCP adapter provides a manual glossary workflow over
Streamable HTTP. In **Glossary and context**, open the query workspace and select
MCP. Enter the exact server endpoint and, if needed, the name of a dedicated
credential environment variable. Select one current source entry and a target
language. Saving or reopening this draft does not connect to the server.

Explicitly authorize discovery before connecting. Discovery reads tool
descriptions and schemas; those are untrusted server claims. Choose a tool that
supports the terminology profile described below. Review the complete fixed
query, languages, service and tool before separately consenting to execution.
The query sends only the previewed arguments. It does not automatically include
the project directory, neighboring entries, current translation, saved context
or adopted terms.

Each discovery permits at most one query within its original two-minute maximum
lifetime. Preparing, reconciling or retrying the original acknowledgement does
not renew this deadline. Tool annotations such as `readOnlyHint` do not authorize
an operation or prove that the external service has no side effects. The
recipient may retain or forward the data you send, and its own usage charges
and permissions apply.

## Service identity and credentials

Use an exact HTTPS URL, or an explicitly selected literal loopback HTTP endpoint
for a local service. URL usernames, passwords, fragments and query strings are
refused; use the separate credential reference for authentication. Redirects,
inherited proxy configuration, automatic session
reinitialization, transparent retries and stale catalog fallback are disabled.
The adapter uses the official Rust MCP SDK's client and message types with a
bounded HTTP transport.

The optional credential reference must use the `TSUMUGI_MCP_CLIENT_` namespace.
Set that environment variable before starting Tsumugi; enter its name in the
query form, never its secret value. An empty reference sends no credential.
The adapter does not reuse model-provider keys, the desktop session token,
outbound MCP pairing credentials or another application's login. Only the
non-secret reference is retained in local execution provenance.

## Supported terminology profile

The first adapter supports the `tsumugi.mcp.term-query-1` profile. Its tool input
is a strict object containing exactly `query`, `sourceLocale` and `targetLocale`:

```json
{
  "query": "Copper Ore",
  "sourceLocale": "en",
  "targetLocale": "zh-CN"
}
```

Successful MCP results must provide `structuredContent` in this strict shape:

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

The tool must declare the exact canonical input and output schemas for this
profile, available as `mcp_term_query_input_schema` and
`mcp_term_query_output_schema` in the [public contract source](../crates/core/src/application/mcp_retrieval.rs).
JSON object key order is immaterial; schema values, including `required` arrays,
must match. The first profile does not infer equivalence between arbitrary JSON
Schemas. Extra
fields, duplicate entry identities, invalid or out-of-scope terms, oversized
content and unsupported schemas are refused. The adapter does not fetch
returned URIs, execute server instructions, answer interactive requests, follow
server tasks or reinterpret text blocks as successful term output.

The query must be a non-empty, exact substring of the selected current source;
each proposed source phrase must occur in that query. Input is preserved rather
than silently trimmed or rewritten.

Queries are limited to 16 KiB of UTF-8. A successful structured result is limited
to 64 KiB and 100 entries. Catalog, schema, frame and cumulative connection
limits apply independently; reaching a bound fails explicitly without silently
truncating the catalog or adopting partial output.

## Review, stop and recover

Execution records the original fixed input, task and exact result in the
project's normal history. A successful query proposes terms; it does not adopt
them. Explicitly create a resource preview from the saved result, then review
each proposal through the existing resource comparison and decision controls.
The capture records MCP service, tool, schema, query, source and execution
provenance. It makes no verified license claim on the server's behalf.

Adoption checks the original source and current term revision. Manual overrides
retain their existing protection. Keeping or ignoring a proposal leaves adopted
terms unchanged, and unadopted results are not included in normal term
resolution or AI inputs. Adopting a term does not rewrite translations.

A query is a set of proposals, not a complete glossary revision. Terms absent
from a later query are not removals. Repeated proposals for the same service,
tool, source entry, language and external entry identity use the existing term
comparison and revision checks while preserving each capture's exact provenance.

Stop closes further admission and distinguishes that fact from accepted work
still draining. Ending a visible wait does not prove that a remote operation was
undone. If an acknowledgement is lost, reconcile the original action; the
adapter does not issue a replacement query automatically. Uncertain remote
effects remain unknown. A later input stays separate from earlier responses.

Closing or switching projects, expiry and application exit revoke live
authorization. Reopening can read saved results, resource captures and decisions
without restoring a connection, credential permission or execution permit.
Starting another query requires a new explicit discovery, preview and consent.
This first adapter does not add arbitrary MCP tools to AI plans or launch local
stdio servers.
