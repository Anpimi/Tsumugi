import { checkedInvoke } from "./ipc";
import type { SessionRequest } from "./executionCommands";
import type { McpSharePrepareRequest, McpShareAuthorizeRequest, McpShareReadRequest, McpShareRevokeRequest,
  McpSharePreparation, McpShareAuthorization, McpShareIdentity } from "./generated/mcp.requests";
import type { McpShareView, McpSharePrepared } from "./generated/mcp.responses";
import * as validators from "./generated/mcp.validators";

export type { McpSharePrepareRequest, McpShareAuthorizeRequest, McpShareReadRequest, McpShareRevokeRequest,
  McpSharePreparation, McpShareAuthorization, McpShareIdentity } from "./generated/mcp.requests";
export type { McpShareView, McpSharePrepared, McpShareConfiguration, McpShareAuthorized, McpShareRevocation, McpShareSessionView } from "./generated/mcp.responses";

function requireConfirmation(condition: boolean): asserts condition {
  if (!condition) throw Object.assign(new Error("Invalid MCP sharing acknowledgement"), { outcome: "unknown", reason: "invalid-mcp-share-receipt" });
}
export function sameMcpIdentity(left: McpShareIdentity, right: McpShareIdentity) {
  return left.ownerId === right.ownerId && left.generation === right.generation && left.shareId === right.shareId;
}
function samePreparation(left: McpSharePreparation, right: McpSharePreparation) {
  return sameMcpIdentity(left.identity, right.identity) && left.recipientLabel === right.recipientLabel
    && left.selection.projectId === right.selection.projectId && left.selection.unitId === right.selection.unitId
    && left.selection.locale === right.selection.locale && left.selection.shareTerms === right.selection.shareTerms
    && left.selection.shareContext === right.selection.shareContext;
}
export function sameMcpAuthorization(left: McpShareAuthorization, right: McpShareAuthorization) {
  return sameMcpIdentity(left.identity, right.identity) && left.actionId === right.actionId && left.previewDigest === right.previewDigest
    && left.validForSeconds === right.validForSeconds && left.confirmed === right.confirmed;
}
function confirmPrepared(value: McpSharePrepared, preparation: McpSharePreparation) {
  const { preview } = value, { basis, payload } = preview, { selection } = preparation;
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  requireConfirmation(samePreparation(value.preparation, preparation) && preview.version === 1 && /^[a-f0-9]{64}$/.test(preview.digest)
    && basis.projectId === selection.projectId && basis.unitId === selection.unitId && basis.locale === selection.locale
    && payload.unitId === basis.unitId && payload.locale === basis.locale && payload.source.snapshotId === basis.sourceSnapshotId
    && payload.source.revisionId === basis.sourceRevisionId && (payload.translation?.selectionId ?? null) === basis.selectionId
    && (payload.translation?.revisionId ?? null) === basis.translationRevisionId
    && (selection.shareTerms ? payload.terms !== null && basis.termsDigest !== null : payload.terms === null && basis.termsDigest === null)
    && (selection.shareContext ? (payload.manualContext?.revisionId ?? null) === basis.contextRevisionId
      : payload.manualContext === null && basis.contextRevisionId === null)
    && preview.byteLength > 0 && preview.byteLength <= 65_536 && bytes === preview.byteLength);
  return value;
}
function confirmView(view: McpShareView, preparation: McpSharePreparation, authorization: McpShareAuthorization | null) {
  requireConfirmation(sameMcpIdentity(view.identity, preparation.identity)
    && (view.preparation === null ? view.admissionClosed : samePreparation(view.preparation, preparation))
    && (view.previewDigest === null ? view.admissionClosed : /^[a-f0-9]{64}$/.test(view.previewDigest))
    && (view.authorization === null ? view.expiresAtMs === null
      : sameMcpIdentity(view.authorization.identity, preparation.identity) && view.authorization.previewDigest === view.previewDigest
        && view.authorization.confirmed && view.expiresAtMs !== null && BigInt(view.expiresAtMs) > 0n
        && BigInt(view.expiresAtMs) <= 8_640_000_000_000_000n && (authorization === null || sameMcpAuthorization(view.authorization, authorization)))
    && (view.phase !== "closed" || view.admissionClosed && view.callbacksDrained)
    && (view.phase !== "closing" || view.admissionClosed && !view.callbacksDrained)
    && (!["awaiting-pairing", "connected"].includes(view.phase) || view.authorization !== null && !view.admissionClosed)
    && (view.phase !== "prepared" || view.authorization === null && !view.admissionClosed));
  return view;
}
export const mcpCommands = {
  session: async (request: SessionRequest) => {
    requireConfirmation(validators.validateRequestSession(request));
    const view = await checkedInvoke("read_mcp_share_session", request, validators.validateResponseSession);
    requireConfirmation(view.kind !== "available" || view.current === null || view.current.ownerId === view.ownerId
      && BigInt(view.nextGeneration) > BigInt(view.current.generation));
    return view;
  },
  prepare: async (request: McpSharePrepareRequest) => {
    requireConfirmation(validators.validateRequestPrepare(request));
    return confirmPrepared(await checkedInvoke("prepare_mcp_share", request, validators.validateResponsePrepared), request.preparation);
  },
  authorize: async (request: McpShareAuthorizeRequest, preparation: McpSharePreparation) => {
    requireConfirmation(validators.validateRequestAuthorize(request) && sameMcpIdentity(request.authorization.identity, preparation.identity));
    const result = await checkedInvoke("authorize_mcp_share", request, validators.validateResponseAuthorized);
    confirmView(result.view, preparation, request.authorization);
    requireConfirmation(result.view.authorization !== null && sameMcpAuthorization(result.view.authorization, request.authorization));
    return result;
  },
  read: async (request: McpShareReadRequest, preparation: McpSharePreparation, previewDigest: string | null = null) => {
    requireConfirmation(validators.validateRequestRead(request) && sameMcpIdentity(request.identity, preparation.identity));
    const view = confirmView(await checkedInvoke("read_mcp_share", request, validators.validateResponseShare), preparation, request.authorization);
    requireConfirmation(previewDigest === null || view.previewDigest === null && view.admissionClosed || view.previewDigest === previewDigest);
    return view;
  },
  revoke: async (request: McpShareRevokeRequest, preparation: McpSharePreparation) => {
    requireConfirmation(validators.validateRequestRevoke(request) && sameMcpIdentity(request.identity, preparation.identity));
    const receipt = await checkedInvoke("revoke_mcp_share", request, validators.validateResponseRevoked);
    requireConfirmation(sameMcpIdentity(receipt.identity, request.identity) && receipt.actionId === request.actionId && receipt.admissionClosed);
    return receipt;
  },
};
