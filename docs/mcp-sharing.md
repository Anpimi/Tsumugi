# Share a fixed entry with an MCP client

The experimental outbound MCP bridge lets an external MCP client read a single saved translation entry in one target language. This feature exposes local project data to an external client; it does not connect Tsumugi to an external MCP server.

## Preparing and authorizing a share

1. Open the entry in **Translations**, open the MCP sharing panel, enter a label for the recipient, and generate a preview.
2. Optionally include **Adopted terms** or **Saved human context** (both are disabled by default).
3. Review the preview and authorize the share.

Only saved data is shared—unsaved editor drafts are excluded, and the source text and selected translation must belong to the same source revision. Modifying the preview requires re-confirming. Once authorized, the share is pinned to that exact snapshot; subsequent edits in Tsumugi are not exposed to the client.

## Connecting the client

Authorizing a share generates a local stdio MCP server configuration (`command`, `args`, and `env`) that you can paste into any MCP client supporting stdio servers. Keep Tsumugi and the project open while using the connection: the command launches the Tsumugi binary in headless bridge mode and proxies MCP traffic over a random `127.0.0.1` port to your active project session without opening a second database instance.

### Security and session lifecycle

- **Bearer credential**: The generated configuration includes a single-use bearer token scoped to this share. Treat it as a secret and do not commit it to version control or paste it into logs. It does not contain your desktop session token or model-provider API keys. The recipient name is only a local label; Tsumugi does not authenticate the client's self-reported name.
- **Data handling**: Once a client reads the entry, it may cache or forward the text (for example, to its own model provider). Revoking a share stops future reads but cannot recall data already sent.
- **Expiration and revocation**: Each authorization permits a single authenticated client connection and expires after your chosen duration (up to 10 minutes). Revoking the share, disconnecting the client, closing the project, or quitting Tsumugi closes admission immediately; the panel indicates if any in-flight responses are still draining. If an authorization response is lost, you can recover the original configuration under its action identity without extending its deadline, whereas reconnecting after closure requires a new preview and authorization.

## Exposed tools and protocol limits

The server exposes three zero-argument tools (input must be `{}`):

| Tool | Disclosed content |
| --- | --- |
| `tsumugi_read_entry` | The pinned entry's source text, selected translation, and revision IDs |
| `tsumugi_read_terms` | Applicable adopted terms (including unresolved conflicts), if enabled in the preview |
| `tsumugi_read_context` | Saved human context for this entry and language, if enabled in the preview |

Calls passing extra arguments or requesting unselected categories are rejected. Extracted or inferred context, neighboring entries, file paths, project browsing, SQL queries, model execution, translation adoption, review approval, and export operations are not exposed.

Connection and payload boundaries:
- **Payload size**: The total disclosed payload is capped at 64 KiB of UTF-8; oversized previews are rejected upfront rather than truncated.
- **Session quotas**: A connection allows at most 100 content reads and 128 incoming protocol frames (up to 128 KiB per frame). Hitting any limit closes the share.
- **Structured output**: Tool responses return MCP `structuredContent` only, without duplicating project text into fallback plain-text blocks. Clients must support structured tool results and should treat returned fields strictly as project data rather than prompt instructions.

The transport is built on the official [Rust MCP SDK 3.5.1](https://github.com/modelcontextprotocol/rust-sdk/releases/tag/rmcp-v3.5.1) implementing the [2026-07-28 MCP specification](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning). Verify compatibility with your target MCP client on your platform.
