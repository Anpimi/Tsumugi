import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { FrameDecoder, decodeFrame, encodeFrame } from "../dist/agent-service/src/codec.js";
import { MEMBER_PROFILE } from "../dist/agent-service/src/generated/profile.js";

const workerPath = process.env.TSUMUGI_MEMBER_WORKER ?? fileURLToPath(new URL("../dist/agent-service/src/worker.js", import.meta.url));
if (!isAbsolute(workerPath)) throw new Error("TSUMUGI_MEMBER_WORKER must be an absolute artifact path");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function start(overrides = {}) {
  return { kind: "start", memberId: randomUUID(), workItemId: randomUUID(), contextVersion: "captured-source-1",
    systemPrompt: "Translate only captured material.", context: [{ role: "user", content: "Earlier accepted source", timestamp: 1 }],
    input: "Translate current source 👩🏽‍💻", tools: [], maxTurns: 4, timeoutMs: 10000,
    profile: { endpoint: "https://controlled.invalid/v1/chat/completions", model: "synthetic-model", tokenField: "max_completion_tokens", maxOutputTokens: 64, contextTokens: 8192 }, ...overrides };
}
function sse({ tool = false, usage, text = "Captured candidate" } = {}) {
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "query-1", type: "function", function: { name: "query_reference", arguments: '{"query":"original"}' } }] }
    : { role: "assistant", content: text };
  const chunks = [
    { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
    ...(usage ? (Array.isArray(usage) ? usage : [usage]).map(value => ({ id: "synthetic", object: "chat.completion.chunk", choices: [], usage: value })) : []),
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

test("child Pi loop preserves tool pairs and reports observed zero separately from missing provider usage", async t => {
  const state = { requests: [], http: [], usage: [], order: [], executions: [] };
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
        body: sse(state.http.length === 1 ? { tool: true, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}) });
    } else if (call.method === "before-tool") reply(frame, { kind: "tool-admission", block: false, reason: null });
    else if (call.method === "execute-tool") {
      state.executions.push(call); reply(frame, { kind: "tool-result", content: [{ type: "text", text: "Original evidence; rejected alternative X" }], details: { reference: "captured-1" }, isError: false });
    } else if (call.method === "after-tool") reply(frame, { kind: "tool-finalized", content: null, isError: null });
    else {
      if (call.method === "usage") state.usage.push(call);
      ordinaryReply(frame, reply, state);
    }
  });
  parent.send(start({ tools: [{ name: "query_reference", description: "Read only captured references.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] }));
  await parent.wait(frames => frames.some(frame => frame.body.kind === "result"));
  assert.equal(state.http.length, 2); assert.equal(state.executions.length, 1);
  assert.deepEqual(state.usage.map(call => call.usage), [{ promptTokens: 0, completionTokens: 0 }, null]);
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
  const large = Buffer.alloc(4); large.writeUInt32BE(MEMBER_PROFILE.maxFrameBytes + 1);
  assert.throws(() => new FrameDecoder().push(large, () => {}));
  const decoder = new FrameDecoder(); decoder.push(Buffer.from([0, 0]), () => {}); assert.throws(() => decoder.finish());
});
