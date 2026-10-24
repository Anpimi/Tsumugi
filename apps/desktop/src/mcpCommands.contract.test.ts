import { beforeEach, expect, it, vi } from "vitest";
import { mcpCommands } from "./mcpCommands";
import { mcpAuthorization, mcpConfiguration, mcpPrepared, mcpPreparation, mcpProject, mcpView } from "./testSupport/mcpSharingFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session = { projectId: mcpProject.metadata.projectId, sessionToken: mcpProject.sessionToken };
beforeEach(() => { invoke.mockReset(); });

it("maps all five real sharing commands through the checked adapter with their complete original identities", async () => {
  const preparation = mcpPreparation(), authorization = mcpAuthorization(preparation), view = mcpView(preparation, authorization);
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "read_mcp_share_session") return { kind: "available", ownerId: preparation.identity.ownerId, nextGeneration: "2", current: preparation.identity };
    if (command === "prepare_mcp_share") return mcpPrepared(request.preparation);
    if (command === "authorize_mcp_share") return { view, configuration: mcpConfiguration };
    if (command === "read_mcp_share") return view;
    if (command === "revoke_mcp_share") return { identity: request.identity, actionId: request.actionId, admissionClosed: true, callbacksDrained: false };
    throw new Error("Unexpected synthetic command");
  });
  expect((await mcpCommands.session(session)).kind).toBe("available");
  expect(await mcpCommands.prepare({ ...session, preparation })).toEqual(mcpPrepared(preparation));
  expect(await mcpCommands.authorize({ ...session, authorization }, preparation)).toEqual({ view, configuration: mcpConfiguration });
  expect(await mcpCommands.read({ ...session, identity: preparation.identity, authorization }, preparation, authorization.previewDigest)).toEqual(view);
  await mcpCommands.revoke({ ...session, identity: preparation.identity, actionId: id(9090) }, preparation);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["read_mcp_share_session", "prepare_mcp_share", "authorize_mcp_share", "read_mcp_share", "revoke_mcp_share"]);
  expect(invoke.mock.calls[2]?.[1]).toEqual({ request: { ...session, authorization } });
});

it.each(["project", "unit", "locale", "source", "translation", "terms", "context", "limit", "identity", "recipient"])("rejects a typed but mismatched prepared disclosure: %s", async mismatch => {
  const preparation = mcpPreparation(), result = structuredClone(mcpPrepared(preparation));
  if (mismatch === "project") result.preview.basis.projectId = id(9990);
  if (mismatch === "unit") result.preview.payload.unitId = id(9990);
  if (mismatch === "locale") result.preview.payload.locale = "ja-JP";
  if (mismatch === "source") result.preview.payload.source.revisionId = id(9990);
  if (mismatch === "translation" && result.preview.payload.translation) result.preview.payload.translation.selectionId = id(9990);
  if (mismatch === "terms") result.preview.payload.terms = [];
  if (mismatch === "context") result.preview.payload.manualContext = { revisionId: id(9990), text: "Not chosen" };
  if (mismatch === "limit") result.preview.byteLength = 65537;
  if (mismatch === "identity") result.preparation.identity.shareId = id(9990);
  if (mismatch === "recipient") result.preparation.recipientLabel = "A different recipient";
  invoke.mockResolvedValue(result);
  await expect(mcpCommands.prepare({ ...session, preparation })).rejects.toMatchObject({ outcome: "unknown" });
});

it("distinguishes excluded terms from included but empty terms and keeps missing translation and context explicit", async () => {
  const preparation = mcpPreparation({ selection: { ...mcpPreparation().selection, shareTerms: true, shareContext: true } });
  const result = mcpPrepared(preparation);
  result.preview.payload.terms = []; result.preview.payload.translation = null; result.preview.payload.manualContext = null;
  result.preview.basis.selectionId = null; result.preview.basis.translationRevisionId = null; result.preview.basis.contextRevisionId = null;
  result.preview.byteLength = new TextEncoder().encode(JSON.stringify(result.preview.payload)).byteLength;
  invoke.mockResolvedValue(result);
  expect(await mcpCommands.prepare({ ...session, preparation })).toEqual(result);
});

it.each(["action", "generation", "digest", "expired-shape", "false-confirmation", "closed-undrained"])("rejects a mismatched authorization acknowledgement: %s", async mismatch => {
  const preparation = mcpPreparation(), authorization = mcpAuthorization(preparation), view = mcpView(preparation, authorization);
  if (!view.authorization) throw new Error("Synthetic authorization missing");
  if (mismatch === "action") view.authorization = { ...view.authorization, actionId: id(9990) };
  if (mismatch === "generation") view.identity = { ...view.identity, generation: "2" };
  if (mismatch === "digest") view.previewDigest = "c".repeat(64);
  if (mismatch === "expired-shape") view.expiresAtMs = "8640000000000001";
  if (mismatch === "false-confirmation") view.authorization = { ...view.authorization, confirmed: false };
  if (mismatch === "closed-undrained") view.phase = "closed";
  invoke.mockResolvedValue({ view, configuration: mcpConfiguration });
  await expect(mcpCommands.authorize({ ...session, authorization }, preparation)).rejects.toMatchObject({ outcome: "unknown" });
});

it("can read a canonical unaccepted original authorization without asserting that the operation failed", async () => {
  const preparation = mcpPreparation(), authorization = mcpAuthorization(preparation), view = mcpView(preparation);
  invoke.mockResolvedValue(view);
  expect(await mcpCommands.read({ ...session, identity: preparation.identity, authorization }, preparation)).toEqual(view);
});

it("refuses a secret-bearing status DTO and a receipt for a different revocation", async () => {
  const preparation = mcpPreparation();
  invoke.mockResolvedValue({ ...mcpView(preparation), configuration: mcpConfiguration });
  await expect(mcpCommands.read({ ...session, identity: preparation.identity, authorization: null }, preparation)).rejects.toThrow();
  invoke.mockResolvedValue({ identity: preparation.identity, actionId: id(9990), admissionClosed: true, callbacksDrained: true });
  await expect(mcpCommands.revoke({ ...session, identity: preparation.identity, actionId: id(9090) }, preparation)).rejects.toMatchObject({ outcome: "unknown" });
});

it("binds the original prepared digest even before authorization", async () => {
  const preparation = mcpPreparation();
  invoke.mockResolvedValue({ ...mcpView(preparation), previewDigest: "c".repeat(64) });
  await expect(mcpCommands.read({ ...session, identity: preparation.identity, authorization: null }, preparation, "b".repeat(64))).rejects.toThrow();
});
