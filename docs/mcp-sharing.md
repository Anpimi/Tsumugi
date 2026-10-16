# Share a fixed entry with an MCP client

The experimental outbound MCP connection lets an external client read one saved
entry in one target language. Open the entry in **Translations**, open its MCP
sharing panel, name the recipient, and prepare a preview. Adopted terms and saved
human context are separate choices and start disabled.

Review the complete preview before authorizing. Unsaved editor text is not sent.
The source and selected translation must refer to the same source revision. A
changed preview requires a new confirmation. Once authorized, the connection
reads that fixed version; later edits do not silently become shared content.

Authorization displays a stdio client configuration containing `command`, `args`
and `env`. Use it with a client that accepts a local stdio MCP server. Keep
Tsumugi and the project open. The command starts the same executable in bridge
mode, before the desktop UI starts, and forwards MCP bytes to the original
project session over a randomly assigned `127.0.0.1` port. It does not open the
project in a second process.

The configuration contains an independent bearer credential for this recipient.
Anyone holding it can attempt to use this sharing connection. Do not post it in
logs or source control. It contains neither the desktop session token nor a model
provider credential. The recipient name is your label; the client's reported
name does not authenticate it. External clients may retain or forward content
they receive, including sending it to their model provider. Revocation cannot
recover delivered content.

Only one authenticated connection can use each authorization. It expires after
the chosen duration, up to ten minutes. Revoking it, disconnecting the
authenticated client, closing the project, or exiting the application closes
admission. The panel distinguishes closed admission from responses still
draining. Reconnecting requires a fresh preview and authorization. A lost
authorization response can be checked under its original identity; explicitly
recovering that original configuration does not renew permission or its deadline.

The connection exposes three tools with an empty object as their input:

| Tool | Disclosed content |
| --- | --- |
| `tsumugi_read_entry` | The fixed entry's source and selected translation, with their revision identities |
| `tsumugi_read_terms` | Applicable adopted terms, including unresolved conflicts, only when separately selected |
| `tsumugi_read_context` | Saved human context for this entry and language, only when separately selected |

The server refuses extra arguments and unselected categories. It provides no
project browsing, file paths, SQL, model execution, translation adoption, review
approval, or export tools. Extracted and inferred context and neighboring entries
are excluded. The complete disclosed payload is limited to 64 KiB of encoded
UTF-8; oversized previews are refused instead of truncated.

Each connection allows at most 100 content reads and 128 incoming protocol
frames. Incoming frames are limited to 128 KiB. Reaching a connection limit
closes the share; it does not automatically issue replacement permission.

Tool results use MCP `structuredContent`. The client must support structured
tool results; the server does not duplicate project text in a compatibility
text block. Treat all returned content as project data rather than instructions.

The transport uses the official [Rust MCP SDK 3.5.1](https://github.com/modelcontextprotocol/rust-sdk/releases/tag/rmcp-v3.5.1).
MCP defines the [2026-07-28 current protocol](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning),
with compatibility behavior implemented by the SDK. Support for a particular
external client's configuration or platform still requires that client's testing.
This entry point does not connect Tsumugi to an external MCP server.
