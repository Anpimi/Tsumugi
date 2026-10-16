import type { ProjectView } from "../projectCommands";
import type { McpSharingTarget } from "../McpSharingSession";
import type { McpSharePreparation, McpShareAuthorization, McpSharePrepared, McpShareView, McpShareConfiguration } from "../mcpCommands";
import { fixtureIdentity as id } from "./executionFixture";

export const mcpProject: ProjectView = { sessionToken: "synthetic-mcp-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: id(9000), displayName: "Synthetic sharing", sourceLocale: "en", targetLocales: ["zh-CN", "ja-JP"], metadataRevision: "1" } };
export const mcpTarget: McpSharingTarget = { unitId: id(9010), locale: "zh-CN", key: "synthetic.greeting", sourceSnapshotId: id(9011), sourceRevisionId: id(9012),
  selectionId: id(9013), translationRevisionId: id(9014) };
export function mcpPreparation(overrides: Partial<McpSharePreparation> = {}): McpSharePreparation {
  return { identity: { ownerId: id(9020), generation: "1", shareId: id(9021) }, recipientLabel: "Synthetic external client",
    selection: { projectId: mcpProject.metadata.projectId, unitId: mcpTarget.unitId, locale: mcpTarget.locale, shareTerms: false, shareContext: false }, ...overrides };
}
export function mcpPrepared(preparation = mcpPreparation()): McpSharePrepared {
  const terms = preparation.selection.shareTerms ? [{ source: "Greeting", selected: { revisionId: id(9031), source: "Greeting", target: "问候" }, conflicting: [] }] : null;
  const manualContext = preparation.selection.shareContext ? { revisionId: id(9032), text: "Synthetic manual context only" } : null;
  const payload = { unitId: preparation.selection.unitId, locale: preparation.selection.locale,
    source: { snapshotId: mcpTarget.sourceSnapshotId, revisionId: mcpTarget.sourceRevisionId, text: "Synthetic Hello {{player}} 👩🏽‍💻 é\nمرحبا" },
    translation: { selectionId: mcpTarget.selectionId ?? id(9013), revisionId: mcpTarget.translationRevisionId ?? id(9014), text: "合成你好 {{player}}" }, terms, manualContext };
  return { preparation, preview: { version: 1, basis: { projectId: preparation.selection.projectId, unitId: payload.unitId, locale: payload.locale,
    sourceSnapshotId: payload.source.snapshotId, sourceRevisionId: payload.source.revisionId, selectionId: payload.translation.selectionId,
    translationRevisionId: payload.translation.revisionId, termsDigest: terms ? "a".repeat(64) : null, contextRevisionId: manualContext?.revisionId ?? null },
    payload, byteLength: new TextEncoder().encode(JSON.stringify(payload)).byteLength, digest: "b".repeat(64) } };
}
export function mcpAuthorization(preparation = mcpPreparation()): McpShareAuthorization {
  return { identity: preparation.identity, actionId: id(9040), previewDigest: mcpPrepared(preparation).preview.digest, validForSeconds: 300, confirmed: true };
}
export function mcpView(preparation = mcpPreparation(), authorization: McpShareAuthorization | null = null, overrides: Partial<McpShareView> = {}): McpShareView {
  return { identity: preparation.identity, preparation, previewDigest: mcpPrepared(preparation).preview.digest,
    authorization, expiresAtMs: authorization ? "1792110000000" : null, phase: authorization ? "awaiting-pairing" : "prepared",
    admissionClosed: false, callbacksDrained: authorization === null, error: null, ...overrides };
}
/** Explicitly synthetic; this is never a usable recipient credential. */
export const mcpConfiguration: McpShareConfiguration = { command: "/synthetic/Tsumugi", args: ["--mcp-stdio", "--port", "12345"],
  env: { TSUMUGI_MCP_PAIRING: "synthetic-unusable-recipient-credential" } };
