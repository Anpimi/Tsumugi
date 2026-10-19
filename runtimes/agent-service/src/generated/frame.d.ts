// Generated from the Core member channel. Run pnpm generate:contracts; do not edit.

/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "MemberBody".
 */
export type MemberBody =
  | {
      context: unknown;
      contextVersion: string;
      input: string;
      kind: "start";
      maxTurns: number;
      memberId: ExecutionId;
      profile: MemberProfile;
      systemPrompt: string;
      timeoutMs: number;
      tools: MemberTool[];
      workItemId: ExecutionId;
    }
  | {
      kind: "ready";
    }
  | {
      call: MemberCall;
      kind: "request";
      request: number;
    }
  | {
      kind: "reply";
      reply: MemberReply;
      request: number;
    }
  | {
      kind: "guide";
      text: string;
    }
  | {
      kind: "close";
    }
  | {
      kind: "result";
      messages: unknown;
      turnLimitReached: boolean;
    }
  | {
      kind: "closed";
    }
  | {
      code: string;
      kind: "fault";
    };
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "ExecutionId".
 */
export type ExecutionId = string;
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "TokenField".
 */
export type TokenField = "max_tokens" | "max_completion_tokens";
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "MemberCall".
 */
export type MemberCall =
  | {
      messages: unknown;
      method: "prepare";
    }
  | {
      body: string;
      endpoint: string;
      method: "http";
      requestId: ExecutionId;
    }
  | {
      arguments: unknown;
      callId: string;
      method: "before-tool";
      name: string;
      requestId: ExecutionId;
    }
  | {
      arguments: unknown;
      callId: string;
      method: "execute-tool";
      name: string;
      requestId: ExecutionId;
    }
  | {
      callId: string;
      isError: boolean;
      method: "after-tool";
      name: string;
      requestId: ExecutionId;
      result: unknown;
    }
  | {
      method: "finish-turn";
      requestId: ExecutionId;
      stopReason: string;
    }
  | {
      event: unknown;
      method: "event";
      requestId: ExecutionId | null;
    }
  | {
      method: "usage";
      requestId: ExecutionId;
      usage: Usage | null;
    };
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "MemberReply".
 */
export type MemberReply =
  | {
      kind: "prepared";
      requestId: ExecutionId;
    }
  | {
      body: string;
      contentType: string | null;
      kind: "http";
      requestId: ExecutionId;
      status: number;
    }
  | {
      block: boolean;
      kind: "tool-admission";
      reason: string | null;
    }
  | {
      content: unknown;
      details: unknown;
      isError: boolean;
      kind: "tool-result";
    }
  | {
      content: unknown;
      isError: boolean | null;
      kind: "tool-finalized";
    }
  | {
      action: TurnAction;
      kind: "turn";
    }
  | {
      kind: "recorded";
    }
  | {
      error: ExecutionError;
      kind: "rejected";
    };
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "TurnAction".
 */
export type TurnAction = "normal" | "end" | "continue";
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "ErrorCode".
 */
export type ErrorCode =
  | "invalid-input"
  | "limit-exceeded"
  | "result-mismatch"
  | "output-invalid"
  | "dependency-conflict"
  | "cancelled"
  | "outcome-unknown"
  | "unauthorized"
  | "busy"
  | "storage-failed"
  | "corrupt-ledger";
/**
 * Values compared at the rejecting boundary, without user text or credentials.
 *
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "ConflictEvidence".
 */
export type ConflictEvidence =
  | {
      current: ExecutionId;
      expected: ExecutionId;
      kind: "source-revision";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "translation-selection";
    }
  | {
      current: string;
      expected: string;
      kind: "review-basis";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "review-decision";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "review-check";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "review-waiver";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "source-fallback";
    }
  | {
      current: string;
      expected: string;
      kind: "build-eligibility";
    }
  | {
      current: string;
      expected: string;
      kind: "comparison-basis";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "term-revision";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "context-revision";
    }
  | {
      current: ExecutionId | null;
      expected: ExecutionId | null;
      kind: "source-snapshot";
    }
  | {
      current: Revision;
      expected: Revision;
      kind: "content-revision";
    };
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "Revision".
 */
export type Revision = string;

export interface MemberFrame {
  body: MemberBody;
  protocolVersion: number;
  sequence: number;
  sessionId: ExecutionId;
}
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "MemberProfile".
 */
export interface MemberProfile {
  contextTokens: number | null;
  endpoint: string;
  maxOutputTokens: number;
  model: string;
  tokenField: TokenField;
}
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "MemberTool".
 */
export interface MemberTool {
  description: string;
  name: string;
  parameters: unknown;
}
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "Usage".
 */
export interface Usage {
  completionTokens: number;
  promptTokens: number;
}
/**
 * This interface was referenced by `MemberFrame`'s JSON-Schema
 * via the `definition` "ExecutionError".
 */
export interface ExecutionError {
  code: ErrorCode;
  conflict?: ConflictEvidence | null;
  itemIds: ExecutionId[];
  stage: string;
}
