import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { FrameDecoder, decodeFrame, encodeFrame } from "../dist/agent-service/src/codec.js";
import { MEMBER_PROFILE } from "../dist/agent-service/src/generated/profile.js";
import { responsesSse } from "./responses-fixture.mjs";

const workerPath = process.env.TSUMUGI_MEMBER_WORKER ?? fileURLToPath(new URL("../dist/agent-service/src/worker.js", import.meta.url));
if (!isAbsolute(workerPath)) throw new Error("TSUMUGI_MEMBER_WORKER must be an absolute artifact path");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function start(overrides = {}) {
  return { kind: "start", memberId: randomUUID(), workItemId: randomUUID(), contextVersion: "captured-source-1",
    systemPrompt: "Translate only captured material.", context: [{ role: "user", content: "Earlier accepted source", timestamp: 1 }],
    input: "Translate current source 👩🏽‍💻", tools: [], maxTurns: 4, timeoutMs: 10000,
    profile: { endpoint: "https://controlled.invalid/v1/chat/completions", model: "synthetic-model", tokenField: "max_completion_tokens", maxOutputTokens: 64, contextTokens: 8192 }, ...overrides };
}
function sse({ tool = false, toolArguments = { query: "original" }, usage, usageEvents = [], text = "Captured candidate" } = {}) {
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "query-1", type: "function", function: { name: "query_reference", arguments: JSON.stringify(toolArguments) } }] }
    : { role: "assistant", content: text };
  const chunks = [
    { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
    ...(usage ? (Array.isArray(usage) ? usage : [usage]).map(value => ({ id: "synthetic", object: "chat.completion.chunk", choices: [], usage: value })) : []),
    ...usageEvents,
  ];
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}
function fixture(t, handle = async () => undefined) {
  const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENAI_API_KEY: "ambient-key-must-not-be-forwarded" } });
  const sessionId = randomUUID(), decoder = new FrameDecoder(), frames = [], changed = [];
  let sequence = 0, outputSequence = 0, stderr = "", failure;
  // `close` includes the final stdout/stderr bytes. `exit` can precede their
  // delivery and would race a correctly flushed terminal frame.
  const ended = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  child.once("error", error => { failure = error; });
  const send = (body, override = {}) => child.stdin.write(encodeFrame({ protocolVersion: MEMBER_PROFILE.protocolVersion, sessionId, sequence: sequence++, body, ...override }));
  const reply = (frame, value) => send({ kind: "reply", request: frame.body.request, reply: value });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    try {
      decoder.push(chunk, frame => {
        assert.equal(frame.sessionId, sessionId); assert.equal(frame.sequence, outputSequence++);
        frames.push(frame);
        for (const notify of changed.splice(0)) notify();
        Promise.resolve(handle(frame, { send, reply, frames })).catch(error => { failure = error; child.kill(); });
      });
    } catch (error) { failure = error; child.kill(); }
  });
  const until = promise => Promise.race([promise, ended.then(outcome => {
    const terminal = frames.at(-1)?.body;
    throw failure ?? new Error(`Worker exited before parent observation (code=${outcome.code}, signal=${outcome.signal}, last=${terminal?.kind ?? "none"}${terminal?.kind === "fault" ? `:${terminal.code}` : ""}): ${stderr.slice(0, 4096)}`);
  })]);
  const wait = async predicate => {
    while (!predicate(frames)) {
      if (failure) throw failure;
      await until(new Promise(resolve => changed.push(resolve)));
    }
    return frames.findLast(predicateFrame => predicate([predicateFrame]));
  };
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await ended; if (failure) throw failure; assert.equal(stderr, ""); });
  return { child, sessionId, send, reply, frames, wait, until, ended };
}
function ordinaryReply(frame, reply, state) {
  const call = frame.body.call;
  if (call.method === "prepare") {
    const requestId = randomUUID(); state.requests.push(requestId); reply(frame, { kind: "prepared", requestId, sharedView: null });
  } else if (call.method === "http") {
    state.http.push(call); reply(frame, { kind: "http", requestId: call.requestId, status: 200, contentType: "text/event-stream", body: sse() });
  } else if (call.method === "finish-turn") reply(frame, { kind: "turn", action: "normal" });
  else if (call.method === "usage" || call.method === "event") reply(frame, { kind: "recorded" });
  else throw new Error(`Unexpected controlled call: ${call.method}`);
}

const usageReport = usage => ({ id: "synthetic", object: "chat.completion.chunk", choices: [], usage });
const usageInChoice = (usage, top = {}) => ({ id: "synthetic", object: "chat.completion.chunk", ...top,
  choices: [{ index: 0, delta: {}, finish_reason: null, usage }] });
const knownUsage = (promptTokens, completionTokens, cacheReadTokens = null, cacheWriteTokens = null, reasoningTokens = null) => ({
  promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
});

test("subscription worker preserves actual terminal usage without output-cap or pricing claims", async t => {
  for (const [terminal, usage, expected, refusal = false] of [
    ["completed", { input_tokens: 100, output_tokens: 20000, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 400 } }, knownUsage(100, 20000, "30", null, "400")],
    ["incomplete", { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, knownUsage(0, 0, "0", null, "0")],
    ["failed", { input_tokens: 20, output_tokens: 3 }, knownUsage(20, 3)],
    ["completed", { input_tokens: 20 }, null],
    ["completed", undefined, null],
    ["completed", { input_tokens: 5, output_tokens: 2 }, knownUsage(5, 2), true],
  ]) {
    await t.test(`${terminal}: ${JSON.stringify(usage)}`, async t => {
      const state = { requests: [], http: [], usage: [] };
      const parent = fixture(t, async (frame, { reply }) => {
        if (frame.body.kind !== "request") return;
        const call = frame.body.call;
        if (call.method === "http") {
          state.http.push(call);
          const body = JSON.parse(call.body);
          assert.equal(call.endpoint, "https://api.openai.com/v1/responses");
          assert.equal(body.store, false); assert.equal(body.stream, true);
          assert.equal(body.input[0].role, "developer");
          assert.equal(body.input.some(message => message.role === "system"), false);
          for (const key of ["max_output_tokens", "max_completion_tokens", "max_tokens", "temperature"]) assert.equal(Object.hasOwn(body, key), false);
          reply(frame, { kind: "http", requestId: call.requestId, status: 200, contentType: "text/event-stream", body: responsesSse({ terminal, usage, refusal }) });
        } else {
          if (call.method === "usage") state.usage.push(call);
          ordinaryReply(frame, reply, state);
        }
      });
      parent.send(start({ context: [], maxTurns: 1,
        profile: { endpoint: "https://api.openai.com/v1/responses", model: "synthetic-subscription", tokenField: "chatgpt_subscription", maxOutputTokens: 0, contextTokens: null } }));
      await parent.wait(frames => frames.some(frame => frame.body.kind === "result"));
      assert.equal(state.http.length, 1);
      assert.equal(state.usage.length, 1);
      assert.deepEqual(state.usage[0].usage, expected);
      assert.equal(state.usage[0].requestId, state.requests[0]);
      const last = parent.frames.find(frame => frame.body.kind === "result").body.messages.at(-1);
      if (terminal === "completed" && !refusal) assert.equal(last.stopReason, "stop");
      else assert.notEqual(last.stopReason, "stop");
      assertNoNormalizedAssistantUsage(parent.frames);
      parent.send({ kind: "close" }); assert.equal((await parent.ended).code, 0);
    });
  }
});
function assertNoNormalizedAssistantUsage(frames) {
  let assistants = 0;
  const message = value => {
    if (value?.role !== "assistant") return;
    assistants++;
    assert.equal(Object.hasOwn(value, "usage"), false);
  };
  for (const { body } of frames) {
    if (body.kind === "result") body.messages.forEach(message);
    if (body.kind !== "request") continue;
    if (body.call.method === "prepare") body.call.messages.forEach(message);
    if (body.call.method !== "event") continue;
    const event = body.call.event;
    if (["message_start", "message_update", "message_end", "turn_end"].includes(event.type)) message(event.message);
    if (event.type === "agent_end") event.messages.forEach(message);
    if (event.type === "message_update") {
      message(event.assistantMessageEvent.partial);
      message(event.assistantMessageEvent.message);
      message(event.assistantMessageEvent.error);
    }
  }
  assert.ok(assistants > 0);
}
async function observedChildUsage(t, usageEvents, toolRoundTrip = false) {
  const state = { requests: [], http: [], usage: [] };
  const toolDetails = { usage: { source: "Original tool evidence" } };
  const parent = fixture(t, async (frame, { reply }) => {
    if (frame.body.kind !== "request") return;
    const call = frame.body.call;
    if (call.method === "http") {
      state.http.push(call);
      reply(frame, { kind: "http", requestId: call.requestId, status: 200,
        contentType: "text/event-stream", body: sse({ tool: toolRoundTrip && state.http.length === 1,
          usageEvents: !toolRoundTrip || state.http.length === 1 ? usageEvents : [] }) });
    } else if (call.method === "before-tool") reply(frame, { kind: "tool-admission", block: false, reason: null });
    else if (call.method === "execute-tool") reply(frame, { kind: "tool-result", content: [{ type: "text", text: "Original tool evidence" }], details: toolDetails, isError: false });
    else if (call.method === "after-tool") reply(frame, { kind: "tool-finalized", content: null, isError: null });
    else {
      if (call.method === "usage") state.usage.push(call);
      ordinaryReply(frame, reply, state);
    }
  });
  parent.send(start({ tools: toolRoundTrip ? [{ name: "query_reference", description: "Read captured evidence.", parameters: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
  } }] : [] }));
  await parent.wait(frames => frames.some(frame => frame.body.kind === "result"));
  assert.equal(state.http.length, toolRoundTrip ? 2 : 1);
  assert.equal(state.usage.length, state.http.length);
  assert.deepEqual(state.usage.map(call => call.requestId), state.requests);
  assertNoNormalizedAssistantUsage(parent.frames);
  if (toolRoundTrip) {
    assert.equal(state.usage[1].usage, null);
    const prepared = parent.frames.filter(frame => frame.body.kind === "request" && frame.body.call.method === "prepare").at(-1).body.call;
    const assistant = prepared.messages.find(message => message.role === "assistant");
    const tool = prepared.messages.find(message => message.role === "toolResult");
    assert.equal(assistant.content.find(content => content.type === "toolCall").id, tool.toolCallId);
    assert.deepEqual(tool.details, toolDetails);
    assert.ok(prepared.messages.some(message => message.role === "user" && message.content === "Translate current source 👩🏽‍💻"));
    const after = parent.frames.find(frame => frame.body.kind === "request" && frame.body.call.method === "after-tool").body.call;
    assert.deepEqual(after.result.details, toolDetails);
  }
  parent.send({ kind: "close" });
  assert.deepEqual(await parent.ended, { code: 0, signal: null });
  return state.usage[0].usage;
}

test("child Pi loop preserves tool pairs and reports observed zero separately from missing provider usage", async t => {
  const heldUsage = deferred(), state = { requests: [], http: [], usage: [], order: [], executions: [] };
  const views = ["Original objection with real author/source 👩🏽‍💻", "New evidence for the same candidate"].map((body, index) => ({
    viewId: randomUUID(), utf8: JSON.stringify({ kind: "untrusted-team-discussions", author: "member-B", source: "candidate-1", revision: index + 1, body }),
  }));
  const parent = fixture(t, async (frame, { reply }) => {
    if (frame.body.kind !== "request") return;
    const call = frame.body.call; state.order.push(call.method);
    if (call.method === "prepare") {
      assert.ok(!call.messages.some(message => views.some(view => message.content === view.utf8)));
      const requestId = randomUUID(); state.requests.push(requestId);
      reply(frame, { kind: "prepared", requestId, sharedView: views[state.requests.length - 1] });
    } else if (call.method === "http") {
      state.http.push(call);
      reply(frame, { kind: "http", requestId: call.requestId, status: 200, contentType: "text/event-stream",
        body: sse(state.http.length === 1 ? { tool: true, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } } : {}) });
    } else if (call.method === "before-tool") reply(frame, { kind: "tool-admission", block: false, reason: null });
    else if (call.method === "execute-tool") {
      state.executions.push(call); reply(frame, { kind: "tool-result", content: [{ type: "text", text: "Original evidence; rejected alternative X" }], details: { reference: "captured-1" }, isError: false });
    } else if (call.method === "after-tool") reply(frame, { kind: "tool-finalized", content: null, isError: null });
    else {
      if (call.method === "usage") {
        state.usage.push(call);
        if (state.usage.length === 1) { heldUsage.resolve(frame); return; }
      }
      ordinaryReply(frame, reply, state);
    }
  });
  parent.send(start({ tools: [{ name: "query_reference", description: "Read only captured references.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] }));
  const firstUsage = await parent.until(heldUsage.promise);
  await delay(30);
  assert.equal(state.requests.length, 1);
  assert.equal(state.http.length, 1);
  assert.equal(parent.frames.some(frame => frame.body.kind === "result"), false);
  parent.reply(firstUsage, { kind: "recorded" });
  await parent.wait(frames => frames.some(frame => frame.body.kind === "result"));
  assert.equal(state.http.length, 2); assert.equal(state.executions.length, 1);
  assert.deepEqual(state.usage.map(call => call.usage), [knownUsage(0, 0, "0", "0", "0"), null]);
  assert.deepEqual(state.usage.map(call => call.requestId), state.requests);
  assert.equal(state.order.indexOf("usage") < state.order.lastIndexOf("prepare"), true);
  const [first, second] = state.http.map(call => JSON.parse(call.body));
  for (const [index, body] of [first, second].entries()) {
    assert.equal(body.messages.filter(message => message.role === "user" && message.content === views[index].utf8).length, 1);
    assert.equal(body.messages.some(message => message.content === views[1 - index].utf8), false);
  }
  assert.equal(first.max_completion_tokens, 64); assert.equal(first.max_tokens, undefined);
  assert.ok(first.messages.some(message => message.role === "system" && /Translate only captured/.test(message.content)));
  assert.ok(second.messages.some(message => message.role === "user" && message.content === "Translate current source 👩🏽‍💻"));
  const assistant = second.messages.find(message => message.tool_calls), tool = second.messages.find(message => message.role === "tool");
  assert.equal(assistant.tool_calls[0].id, tool.tool_call_id); assert.match(tool.content, /rejected alternative X/);
  assert.equal(JSON.stringify(state.http).includes("ambient-key-must-not-be-forwarded"), false);
  const result = parent.frames.find(frame => frame.body.kind === "result").body;
  assert.ok(!result.messages.some(message => views.some(view => message.content === view.utf8)));
  parent.send({ kind: "close" }); assert.deepEqual(await parent.ended, { code: 0, signal: null });
});

test("child usage preserves raw totals and the pinned carrier and cache alias priorities", async t => {
  const base = { prompt_tokens: 10, completion_tokens: 6 };
  const details = { ...base, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } };
  const cases = [
    ["reported zero totals do not imply reported zero details", [usageReport({ prompt_tokens: 0, completion_tokens: 0 })], knownUsage(0, 0)],
    ["details are already included in their original totals", [usageReport(details)], knownUsage(10, 6, "4", "5", "2")],
    ["cache read and write may overlap", [usageReport({ ...base, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 6 } })], knownUsage(10, 6, "9", "8", "6")],
    ["explicit canonical zero precedes nonzero aliases", [usageReport({ ...base, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      prompt_cache_hit_tokens: 7, cached_tokens: 8, completion_tokens_details: { reasoning_tokens: 0 } })], knownUsage(10, 6, "0", "0", "0")],
    ["null canonical cache count falls through to the first alias", [usageReport({ ...base, prompt_tokens_details: { cached_tokens: null }, prompt_cache_hit_tokens: 4, cached_tokens: 8 })], knownUsage(10, 6, "4")],
    ["explicit first-alias zero precedes the final alias", [usageReport({ ...base, prompt_cache_hit_tokens: 0, cached_tokens: 8 })], knownUsage(10, 6, "0")],
    ["null first alias permits the final reported alias", [usageReport({ ...base, prompt_cache_hit_tokens: null, cached_tokens: 3 })], knownUsage(10, 6, "3")],
    ["safe integer detail remains an exact decimal string", [usageReport({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: Number.MAX_SAFE_INTEGER } })], knownUsage(Number.MAX_SAFE_INTEGER, 0, "9007199254740991")],
    ["overlapping safe details do not expose Pi's unsafe normalized sum", [usageReport({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: Number.MAX_SAFE_INTEGER, cache_write_tokens: Number.MAX_SAFE_INTEGER } })], knownUsage(Number.MAX_SAFE_INTEGER, 0, "9007199254740991", "9007199254740991")],
    ["first choice is a supported raw usage carrier", [usageInChoice(details)], knownUsage(10, 6, "4", "5", "2")],
    ["truthy top carrier precedes the choice carrier", [usageInChoice({ prompt_tokens: 1, completion_tokens: 1 }, { usage: details })], knownUsage(10, 6, "4", "5", "2")],
    ["null top carrier permits the choice report", [usageInChoice(details, { usage: null })], knownUsage(10, 6, "4", "5", "2")],
  ];
  for (const [name, events, expected] of cases) await t.test(name, async t => {
    assert.deepEqual(await observedChildUsage(t, events), expected);
  });
});

test("child usage keeps unreliable details unknown without discarding reliable totals", async t => {
  const base = { prompt_tokens: 6, completion_tokens: 4 };
  const preliminary = usageReport({ ...base, prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } });
  for (const [name, value] of [["negative", -1], ["fraction", 0.5], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["numeric string", "2"], ["null", null]]) {
    await t.test(name, async t => {
      const report = { ...base, prompt_tokens_details: { cached_tokens: value, cache_write_tokens: value }, completion_tokens_details: { reasoning_tokens: value } };
      assert.deepEqual(await observedChildUsage(t, [preliminary, usageReport(report)], name === "unsafe integer"), knownUsage(6, 4));
    });
  }
  await t.test("each detail is bounded by its own total independently", async t => {
    assert.deepEqual(await observedChildUsage(t, [preliminary, usageReport({ ...base,
      prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 5 } })]), knownUsage(6, 4, null, "6"));
  });
  await t.test("a malformed first alias does not select a lower-priority valid value", async t => {
    assert.deepEqual(await observedChildUsage(t, [usageReport({ ...base,
      prompt_tokens_details: { cached_tokens: "1" }, prompt_cache_hit_tokens: 2, cached_tokens: 3 })]), knownUsage(6, 4));
  });
  await t.test("non-object detail containers do not report zero", async t => {
    assert.deepEqual(await observedChildUsage(t, [usageReport({ ...base, prompt_tokens_details: [], completion_tokens_details: 0 })]), knownUsage(6, 4));
  });
});

test("child usage replaces complete reports without filling later missing fields from older observations", async t => {
  const preliminary = usageReport({ prompt_tokens: 6, completion_tokens: 4,
    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } });
  await t.test("later reliable totals with missing details clear all earlier details", async t => {
    assert.deepEqual(await observedChildUsage(t, [preliminary, usageReport({ prompt_tokens: 13, completion_tokens: 7 })]), knownUsage(13, 7));
  });
  await t.test("an ordinary delta without either usage carrier preserves the report", async t => {
    const delta = { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: null }] };
    assert.deepEqual(await observedChildUsage(t, [preliminary, delta]), knownUsage(6, 4, "2", "3", "1"));
  });
  await t.test("an explicit null choice report invalidates the previous report", async t => {
    assert.equal(await observedChildUsage(t, [preliminary, usageInChoice(null)]), null);
  });
  for (const [name, report] of [
    ["missing base total", { completion_tokens: 4 }],
    ["negative base total", { prompt_tokens: -1, completion_tokens: 4 }],
    ["unsafe base total", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 4 }],
    ["numeric string base total", { prompt_tokens: 6, completion_tokens: "4" }],
  ]) await t.test(name, async t => {
    assert.equal(await observedChildUsage(t, [preliminary, usageReport(report)], name === "unsafe base total"), null);
  });
});

test("an unsafe tool payload faults immediately without waiting behind an unencoded request", async t => {
  const state = { requests: [], http: [] };
  const parent = fixture(t, async (frame, { reply }) => {
    if (frame.body.kind !== "request") return;
    if (frame.body.call.method === "http") {
      state.http.push(frame.body.call);
      reply(frame, { kind: "http", requestId: frame.body.call.requestId, status: 200, contentType: "text/event-stream",
        body: sse({ tool: true, toolArguments: { query: "original", unsafe: Number.MAX_SAFE_INTEGER + 1 } }) });
    } else ordinaryReply(frame, reply, state);
  });
  parent.send(start());
  assert.deepEqual(await parent.ended, { code: 1, signal: null });
  assert.deepEqual(parent.frames.at(-1).body, { kind: "fault", code: "member-output-failed" });
  assert.equal(state.http.length, 1);
  assert.equal(parent.frames.some(frame => frame.body.kind === "result"), false);
});

test("final event acknowledgement is required before a child result can be emitted", async t => {
  const held = deferred(), state = { requests: [], http: [] };
  const parent = fixture(t, async (frame, { reply }) => {
    if (frame.body.kind !== "request") return;
    if (frame.body.call.method === "event" && frame.body.call.event.type === "agent_end") { held.resolve(frame); return; }
    ordinaryReply(frame, reply, state);
  });
  parent.send(start());
  const finalRecord = await parent.until(held.promise);
  await delay(30); assert.equal(parent.frames.some(frame => frame.body.kind === "result"), false);
  parent.reply(finalRecord, { kind: "recorded" });
  await parent.wait(frames => frames.some(frame => frame.body.kind === "result"));
  parent.send({ kind: "close" }); assert.equal((await parent.ended).code, 0);
});

test("a malformed final provider usage report cannot preserve an earlier partial count as final usage", async t => {
  for (const finalUsage of [{ prompt_tokens: 0.5, completion_tokens: 1, total_tokens: 1.5 }, null, 7]) {
    const state = { requests: [], http: [], usage: [] };
    const parent = fixture(t, async (frame, { reply }) => {
      if (frame.body.kind !== "request") return;
      if (frame.body.call.method === "http") {
        state.http.push(frame.body.call);
        reply(frame, { kind: "http", requestId: frame.body.call.requestId, status: 200, contentType: "text/event-stream",
          body: sse({ usage: [{ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, finalUsage] }) });
      } else {
        if (frame.body.call.method === "usage") state.usage.push(frame.body.call.usage);
        ordinaryReply(frame, reply, state);
      }
    });
    parent.send(start());
    await parent.wait(frames => frames.some(frame => frame.body.kind === "result"));
    assert.deepEqual(state.usage, [null]);
    parent.send({ kind: "close" }); assert.equal((await parent.ended).code, 0);
  }
});

test("Close cancels the admitted HTTP promise, accepts only its original late reply and drains acknowledged records", async t => {
  const dispatched = deferred(), state = { requests: [], http: [] };
  const parent = fixture(t, async (frame, { reply }) => {
    if (frame.body.kind !== "request") return;
    if (frame.body.call.method === "http") { state.http.push(frame.body.call); dispatched.resolve(frame); return; }
    ordinaryReply(frame, reply, state);
  });
  parent.send(start());
  const pending = await parent.until(dispatched.promise);
  parent.send({ kind: "close" });
  parent.reply(pending, { kind: "rejected", error: { code: "cancelled", stage: "member-http", itemIds: [] } });
  assert.deepEqual(await parent.ended, { code: 0, signal: null });
  assert.equal(state.http.length, 1);
  assert.equal(parent.frames.some(frame => frame.body.kind === "result"), false);
  assert.equal(parent.frames.at(-1).body.kind, "closed");
});

test("guidance reaches the next real Pi request without replacing accepted input or latest tool result", async t => {
  const firstHttp = deferred(), state = { requests: [], http: [] };
  const parent = fixture(t, async (frame, { reply }) => {
    if (frame.body.kind !== "request") return;
    if (frame.body.call.method === "http" && !state.http.length) { state.http.push(frame.body.call); firstHttp.resolve(frame); return; }
    ordinaryReply(frame, reply, state);
  });
  parent.send(start());
  const original = await parent.until(firstHttp.promise);
  parent.send({ kind: "guide", text: "Human correction: use the captured speaker." });
  parent.reply(original, { kind: "http", requestId: original.body.call.requestId, status: 200, contentType: "text/event-stream", body: sse() });
  await parent.wait(frames => frames.some(frame => frame.body.kind === "result"));
  assert.equal(state.http.length, 2);
  const messages = JSON.parse(state.http[1].body).messages;
  assert.ok(messages.some(message => message.content === "Translate current source 👩🏽‍💻"));
  assert.ok(messages.some(message => message.content === "Human correction: use the captured speaker."));
  parent.send({ kind: "close" }); assert.equal((await parent.ended).code, 0);
});

test("wrong reply identity fails closed instead of advancing an admitted request", async t => {
  const pending = deferred();
  const parent = fixture(t, async frame => { if (frame.body.kind === "request") pending.resolve(frame); });
  parent.send(start()); const request = await parent.until(pending.promise);
  parent.send({ kind: "reply", request: request.body.request + 1, reply: { kind: "recorded" } });
  assert.equal((await parent.ended).code, 1);
  assert.equal(parent.frames.at(-1).body.kind, "fault");
});

test("captured deadline terminates a child with an unacknowledged operation", async t => {
  const parent = fixture(t);
  parent.send(start({ timeoutMs: 100 }));
  assert.equal((await parent.ended).code, 1);
  assert.deepEqual(parent.frames.at(-1).body, { kind: "fault", code: "member-deadline-exceeded" });
});

test("member codec rejects duplicate keys, invalid Unicode, unsafe identities, oversize prefix and incomplete frames", () => {
  const prefix = JSON.stringify({ protocolVersion: MEMBER_PROFILE.protocolVersion, sessionId: randomUUID(), sequence: 0, body: { kind: "close" } });
  assert.throws(() => decodeFrame(Buffer.from(prefix.replace('"sequence":0', '"sequence":0,"sequence":1'))));
  assert.throws(() => decodeFrame(Buffer.from(prefix.replace('"close"', '"\\ud800"'))));
  assert.throws(() => decodeFrame(Buffer.from(prefix.replace('"sequence":0', '"sequence":9007199254740992'))));
  const frame = JSON.parse(prefix);
  assert.throws(() => decodeFrame(Buffer.from(JSON.stringify({ ...frame, protocolVersion: MEMBER_PROFILE.protocolVersion - 1 }))));
  assert.throws(() => decodeFrame(Buffer.from(JSON.stringify({ ...frame, sessionId: "not-a-uuid" }))));
  assert.throws(() => decodeFrame(Buffer.from(JSON.stringify({ ...frame,
    body: { kind: "reply", request: 1, reply: { kind: "prepared", requestId: "not-a-uuid", sharedView: null } } }))));
  const usage = { ...frame, body: { kind: "request", request: 1,
    call: { method: "usage", requestId: randomUUID(), usage: knownUsage(0, 0, "0", null, null) } } };
  assert.deepEqual(decodeFrame(Buffer.from(JSON.stringify(usage))), usage);
  const incomplete = structuredClone(usage); delete incomplete.body.call.usage.cacheReadTokens;
  assert.throws(() => decodeFrame(Buffer.from(JSON.stringify(incomplete))));
  for (const value of [0, "01"]) {
    const invalid = structuredClone(usage); invalid.body.call.usage.cacheReadTokens = value;
    assert.throws(() => decodeFrame(Buffer.from(JSON.stringify(invalid))));
  }
  const large = Buffer.alloc(4); large.writeUInt32BE(MEMBER_PROFILE.maxFrameBytes + 1);
  assert.throws(() => new FrameDecoder().push(large, () => {}));
  const decoder = new FrameDecoder(); decoder.push(Buffer.from([0, 0]), () => {}); assert.throws(() => decoder.finish());
});
