/** Synthetic public Responses stream; never performs model IO. */
export function responsesSse({ terminal = "completed", usage, tool = false, text = "Captured subscription candidate", truncated = false } = {}) {
  const item = tool
    ? { id: "fc_synthetic", type: "function_call", call_id: "query-1", name: "query_reference", namespace: "tsumugi", arguments: '{"query":"original 👩🏽‍💻"}', status: "completed" }
    : { id: "msg_synthetic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: tool ? { ...item, arguments: "" } : { ...item, content: [] } },
    ...(tool ? [{ type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments }]
      : [{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }]),
    { type: "response.output_item.done", output_index: 0, item },
    ...(!truncated ? [{ type: `response.${terminal}`, response: {
      id: "resp_synthetic", status: terminal, output: [item], ...(usage === undefined ? {} : { usage }),
      ...(terminal === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      ...(terminal === "failed" ? { error: { code: "synthetic_provider_error", message: "Synthetic failure" } } : {}),
    } }] : []),
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
