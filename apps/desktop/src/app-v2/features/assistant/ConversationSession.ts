import { commandFailure, type CommandFailure } from "../../../CommandFailure";
import { conversationCommands, isConversationMessageText, type ConversationPlanningRun, type ConversationProposalRevision, type PreparedConversationPlanning } from "../../../conversationCommands";
import { defaultAiConfig, editedAiConfig, validAiLimits, type AiConfig } from "../../../aiCommands";
import { conversationDraftCommands, canonicalConversationDraft, conversationPendingActionId, isConversationTeamPending, locallyReplayableConversationRequest, type ConversationDraftHead, type ConversationDraftKey, type ConversationDraftPending, type ConversationDraftSummary, type ConversationDraftValue, type ConversationProposalDraft, type ConversationDraftRevocation, type ConversationDraftResolveTarget, type ConversationDraftDisposition, type ConversationTeamDraft, type ConversationTeamGuidanceDraft, type ConversationTeamPublicationDraft } from "../../../conversationDraftCommands";
import type { SessionRequest } from "../../../executionCommands";
import type { SessionReads } from "../../../sessionReads";
import { strategyCommands, strategyKeys } from "../../../strategyCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { LifecycleParticipant } from "../../platform/projectLifecycle";
import { DraftKernel, nextEditSeq } from "../../workspace/draftKernel";
import { DecisionActivityMemo, type DecisionClientAction } from "../../workspace/decisionActivity";
import { copyWorkspaceSelection, workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";
import { checkPlanningSelection, planningSelectionMatchesPreview, planningSelectionScope } from "./planningSelection";
import { reviewCommands } from "../../../reviewCommands";
import { editableProposal, validProposalContent, type ProposalContent } from "./proposalDraft";
import { newProposalMember } from "./proposalRecipe";
import { isCommandError } from "../../../projectCommands";
import { emptyExecutionConsent, workPlanInput, workPlanMinutesValid, type ConversationWorkPlanInput, type ProposalWorkPlanTools, type ProposalWorkPlanConfirmation } from "./proposalWorkPlan";
import type { WorkPlanExecutionConsent } from "../../../WorkPlanExecutionReview";
import type { PlanToolDraft } from "../../../WorkPlanToolChoice";
import type { PluginTextReviewSelection } from "../../../pluginCommands";
import { workPlanCommands, type WorkPlanCommand, type WorkPlanReceiptView, type WorkPlanStatusView, type WorkPlanView, type TeamExecutionView } from "../../../workPlanCommands";
import { teamGuidanceActive } from "../../../TeamGuidanceSession";
import { teamPublicationActive } from "../../../TeamDiscussionSession";
import { isRunPending, runMatchesLink, runReadyCurrent, type ConversationPlanLink, type ConversationRunReady, type ConversationRunFailure, type ConversationRunConfirmation, type ConversationRunPending, revocationAllowed, revocationControlRequest, type ConversationRevocationState, type ConversationRevocationCommand } from "./conversationRun";

import { teamRecoveryAvailable } from "../../../TeamRecoverySession";
import { validateRequestWorkPlanTeamRecoveryPrepare } from "../../../generated/ai.validators";
import type { WorkPlanTeamRecoveryAuthorizeRequest } from "../../../generated/ai.requests";
import type { WorkPlanTeamRecoveryStateView, TeamRecoveryReceipt } from "../../../generated/ai.responses";
import { initialConversationRecoveryState, initialConversationRecoveryDraft, newConversationRecoveryMember, unchangedConversationRecoveryMember, conversationRecoveryProblem, recoveryBasisMatches,
  type ConversationRecoveryState, type ConversationRecoveryDraft, type ConversationRecoveryMember } from "./conversationRecovery";
import { teamQuestionCommands, type TeamQuestionView } from "../../../teamQuestionCommands";
import type { RespondTeamQuestion } from "../../../generated/ai.requests";
import type { ConversationTeamQuestionDraft } from "../../../generated/draft.responses";
type ConversationQuestionPending = Extract<ConversationDraftPending, { kind: "team-question-response" }>;
type ConversationRecoveryPending = Extract<ConversationDraftPending, { kind: "team-recovery" }>;

type Ports = typeof conversationDraftCommands & Pick<typeof conversationCommands, "create" | "append" | "recoverCreate" | "recoverMessage" | "preparePlanning" | "validatePlanning" | "startPlanning" | "readPlanning" | "captureProposal" | "reviseProposal" | "validateProposal" | "prepareProposalWorkPlan" | "authorizeProposalWorkPlan" | "recoverPlanning" | "recoverProposalCapture" | "recoverProposalRevision" | "recoverProposalWorkPlan"> & {
  identity: () => string; now: () => number; captureSelection: typeof reviewCommands.captureScope;
  planStatus: typeof workPlanCommands.status; startPlan: typeof workPlanCommands.start; readPlanStartSettlement: typeof workPlanCommands.startSettlement;
  controlPlan: typeof workPlanCommands.control; readPlanControlSettlement: typeof workPlanCommands.controlSettlement;
  readProposalWorkPlan: typeof conversationCommands.readProposalWorkPlan;
  readTeamExecution: typeof workPlanCommands.teamExecution; sendTeamMessage: typeof workPlanCommands.sendTeamMessage;
  publishTeam: typeof workPlanCommands.publishTeam; teamMessageSettlement: typeof workPlanCommands.teamMessageSettlement;
  teamPublicationSettlement: typeof workPlanCommands.teamPublicationSettlement;
  readTeamQuestion: typeof teamQuestionCommands.question; respondTeamQuestion: typeof teamQuestionCommands.respond;
  teamQuestionSettlement: typeof teamQuestionCommands.settlement;
  teamRecoveryState: typeof workPlanCommands.teamRecoveryState; prepareTeamRecovery: typeof workPlanCommands.prepareTeamRecovery;
  authorizeTeamRecovery: typeof workPlanCommands.authorizeTeamRecovery; readTeamRecoveryPreparation: typeof workPlanCommands.readTeamRecoveryPreparation;
  closeTeamRecoveryPreparation: typeof workPlanCommands.closeTeamRecoveryPreparation; teamRecoverySettlement: typeof workPlanCommands.teamRecoverySettlement;
  readStrategyDefault: typeof strategyCommands.default; readStrategyCandidate: typeof strategyCommands.candidate;
};
type JournalWrite = Parameters<Ports["write"]>[0]["write"];
type JournalJob = { kind: "write"; request: { sessionToken: string; write: JournalWrite } }
  | { kind: "resolve"; request: { sessionToken: string; resolve: { write: JournalWrite; target: ConversationDraftResolveTarget; disposition: ConversationDraftDisposition } } };
export interface ConversationInput {
  key: ConversationDraftKey;
  head: ConversationDraftHead;
  value: ConversationDraftValue;
  dirty: boolean;
  journalBusy: boolean;
  revocationStates: ReadonlyMap<string, ConversationRevocationState>;
  busy: "submit" | "check" | null;
  outcome: "recorded" | "unknown" | "absent" | "blocked" | "mismatch" | null;
  notice: "threadCreated" | "messageSaved" | "planningRecorded" | "proposalRecorded" | "workPlanRecorded" | "runStarted" | "runPaused" | "runStopped" | "runTakenOver" | "runContinued" | "runNotApplied" | "teamMessageSaved" | "teamPublicationSaved" | "teamRecoveryRecorded" | "teamQuestionResponded" | "teamQuestionClosed" | null;
  failure: { kind: "journal" | "action"; cause: CommandFailure } | null;
  planning: ConversationPlanningInput;
  proposalEditorId: string | null;
  proposalFailure: { proposalId: string; cause: CommandFailure } | null;
  capturedResultIds: readonly string[];
  workPlan: ConversationWorkPlanInput;
  readyRuns: ReadonlyMap<string, ConversationRunReady>;
  recoveryStates: ReadonlyMap<string, ConversationRecoveryState>;
  runFailure: ConversationRunFailure | null;
  runBusy: { planId: string; kind: "start" | "control" | "check" } | null;
}
export interface ConversationPlanningInput {
  open: boolean;
  sequence: number;
  config: AiConfig;
  messageIds: readonly string[];
  selection: WorkspaceSelection | null;
  purpose: NonNullable<PreparedConversationPlanning["preview"]["purpose"]> | null;
  prepared: PreparedConversationPlanning | null;
  consent: boolean;
  busy: "prepare" | "start" | null;
  failure: { kind: "selection" | "request"; cause: CommandFailure } | null;
}
function planningConfig(config: AiConfig, selection: WorkspaceSelection | null): AiConfig {
  return { ...config, maxItems: selection ? workspaceSelectionIds(selection).length : 1, maxRequests: 1, concurrency: 1, maxRetries: 0,
    ...(!selection ? { shareTerms: false, shareContext: false, contextStrategy: null, sourceContext: structuredClone(defaultAiConfig.sourceContext) } : {}) };
}
function planningInput(): ConversationPlanningInput {
  return { open: false, sequence: 0, config: planningConfig(structuredClone(defaultAiConfig), null),
    messageIds: [], selection: null, purpose: null, prepared: null, consent: false, busy: null, failure: null };
}
export interface ConversationSessionSnapshot {
  hydration: "idle" | "loading" | "ready" | "failed";
  failure: CommandFailure | null;
  inputFailure: { conversationId: string; cause: CommandFailure } | null;
  activeId: string | null;
  inputs: ReadonlyMap<string, ConversationInput>;
  summaries: readonly ConversationDraftSummary[];
  next: ConversationDraftKey | null;
  retired: boolean;
}
interface RecordState { input: ConversationInput; job: JournalJob | null; writing: Promise<boolean> | null; action: boolean; submitting: ConversationDraftPending | null; revoking: Set<string>; revocationEpoch: Map<string, number> }
const same = (a: unknown, b: unknown) => jsonIdentity(a) === jsonIdentity(b);

/** Retains local input and original requests for one project session. It never restores permission. */
export class ConversationSession {
  private readonly ports: Ports;
  private readonly writerId: string;
  private readonly decisionActivity: DecisionActivityMemo;
  private readonly kernel = new DraftKernel();
  private readonly records = new Map<string, RecordState>();
  private readonly listeners = new Set<() => void>();
  private opening = new Map<string, Promise<boolean>>();
  private loading: Promise<boolean> | null = null;
  private readonly strategyDefaultLoads = new Map<string, object>();
  private changed = 0;
  private state: ConversationSessionSnapshot = { hydration: "idle", failure: null, inputFailure: null, activeId: null, inputs: new Map(), summaries: [], next: null, retired: false };
  constructor(readonly context: SessionRequest, private readonly onRecorded: () => void, private readonly onReveal: () => void, ports: Partial<Ports> = {}) {
    this.ports = { ...conversationDraftCommands, create: conversationCommands.create, append: conversationCommands.append,
      recoverCreate: conversationCommands.recoverCreate, recoverMessage: conversationCommands.recoverMessage,
      recoverPlanning: conversationCommands.recoverPlanning, recoverProposalCapture: conversationCommands.recoverProposalCapture,
      recoverProposalRevision: conversationCommands.recoverProposalRevision, recoverProposalWorkPlan: conversationCommands.recoverProposalWorkPlan,
      preparePlanning: conversationCommands.preparePlanning, validatePlanning: conversationCommands.validatePlanning, startPlanning: conversationCommands.startPlanning,
      readPlanning: conversationCommands.readPlanning, captureProposal: conversationCommands.captureProposal,
      reviseProposal: conversationCommands.reviseProposal, validateProposal: conversationCommands.validateProposal,
      prepareProposalWorkPlan: conversationCommands.prepareProposalWorkPlan, authorizeProposalWorkPlan: conversationCommands.authorizeProposalWorkPlan,
      planStatus: workPlanCommands.status, startPlan: workPlanCommands.start, readPlanStartSettlement: workPlanCommands.startSettlement,
      controlPlan: workPlanCommands.control, readPlanControlSettlement: workPlanCommands.controlSettlement,
      readProposalWorkPlan: conversationCommands.readProposalWorkPlan, readTeamExecution: workPlanCommands.teamExecution,
      sendTeamMessage: workPlanCommands.sendTeamMessage, publishTeam: workPlanCommands.publishTeam,
      teamMessageSettlement: workPlanCommands.teamMessageSettlement, teamPublicationSettlement: workPlanCommands.teamPublicationSettlement,
      readTeamQuestion: teamQuestionCommands.question, respondTeamQuestion: teamQuestionCommands.respond, teamQuestionSettlement: teamQuestionCommands.settlement,
      teamRecoveryState: workPlanCommands.teamRecoveryState, prepareTeamRecovery: workPlanCommands.prepareTeamRecovery,
      authorizeTeamRecovery: workPlanCommands.authorizeTeamRecovery, readTeamRecoveryPreparation: workPlanCommands.readTeamRecoveryPreparation,
      closeTeamRecoveryPreparation: workPlanCommands.closeTeamRecoveryPreparation, teamRecoverySettlement: workPlanCommands.teamRecoverySettlement,
      readStrategyDefault: strategyCommands.default, readStrategyCandidate: strategyCommands.candidate,
      captureSelection: request => reviewCommands.captureScope(request),
      identity: () => crypto.randomUUID(), now: () => Date.now(), ...ports };
    this.writerId = this.ports.identity();
    this.decisionActivity = new DecisionActivityMemo(this.writerId);
  }
  getSnapshot = () => this.state;
  getDecisionActivity = () => this.decisionActivity.getSnapshot();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ConversationSessionSnapshot> = {}) {
    const actions: DecisionClientAction[] = [];
    if (this.kernel.live) for (const record of this.records.values()) {
      const key = { kind: "conversation" as const, conversationId: record.input.key.conversationId }, pending = record.submitting;
      if (pending) actions.push({ key, slot: "primary", actionId: conversationPendingActionId(pending),
        submittedSeq: pending.submittedSeq });
      for (const slot of record.input.value.revocations ?? []) if (record.revoking.has(slot.request.actionId)
        && record.input.revocationStates.get(slot.request.actionId)?.busy === "submit")
        actions.push({ key, slot: "revocation", actionId: slot.request.actionId, submittedSeq: slot.submittedSeq });
    }
    this.decisionActivity.observe(actions, !this.kernel.live);
    this.state = { ...this.state, ...patch, inputs: new Map([...this.records].map(([id, record]) => [id, record.input])) };
    this.listeners.forEach(listener => listener());
  }
  private update(record: RecordState, patch: Partial<ConversationInput>, clearJournalFailure = false) {
    if (!clearJournalFailure && record.input.failure?.kind === "journal" && patch.failure !== undefined && patch.failure?.kind !== "journal")
      patch = { ...patch, failure: record.input.failure };
    record.input = { ...record.input, ...patch }; this.publish();
  }
  initialize(more = false): Promise<boolean> {
    if (!this.kernel.live) return Promise.resolve(false);
    if (this.loading) return this.loading;
    this.publish({ hydration: "loading", failure: null });
    const after = more ? this.state.next : null;
    this.loading = this.ports.list({ ...this.context, after, limit: 50 }).then(page => {
      if (!this.kernel.live) return false;
      this.publish({ hydration: "ready", summaries: more ? [...this.state.summaries, ...page.items] : page.items, next: page.next }); return true;
    }).catch(error => { if (this.kernel.live) this.publish({ hydration: "failed", failure: commandFailure(error) }); return false;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  async open(conversationId: string): Promise<boolean> {
    if (!this.kernel.live) return false;
    if (this.state.activeId && this.state.activeId !== conversationId) this.cancelWorkPlanStrategyDefault(this.state.activeId);
    this.publish({ activeId: conversationId, inputFailure: null });
    if (this.records.has(conversationId)) return true;
    const existing = this.opening.get(conversationId); if (existing) return existing;
    const key = { projectId: this.context.projectId, conversationId };
    const flight = this.ports.read({ sessionToken: this.context.sessionToken, key }).then(head => {
      if (!this.kernel.live) return false;
      const value = head.value ?? { text: "", editSeq: "0", pending: null };
      this.records.set(conversationId, { input: { key, head, value, dirty: false, journalBusy: false, revocationStates: new Map((value.revocations ?? []).map(slot => [slot.request.actionId, { busy: null, outcome: "unknown", failure: null }])), busy: null, outcome: value.pending ? "unknown" : null, notice: null, failure: null, planning: planningInput(),
        proposalEditorId: value.proposalEdits?.[0]?.proposalId ?? null, proposalFailure: null, capturedResultIds: [], workPlan: workPlanInput(),
        readyRuns: new Map(), recoveryStates: new Map(), runFailure: null, runBusy: null }, job: null, writing: null, action: false, submitting: null, revoking: new Set(), revocationEpoch: new Map() });
      this.publish(this.state.activeId === conversationId ? { inputFailure: null } : {}); return true;
    }).catch(error => { if (this.kernel.live && this.state.activeId === conversationId) this.publish({ inputFailure: { conversationId, cause: commandFailure(error) } }); return false;
    }).finally(() => { this.opening.delete(conversationId); });
    this.opening.set(conversationId, flight); return flight;
  }
  async create(): Promise<void> {
    if (!this.kernel.live || this.state.hydration !== "ready" || [...this.records.values()].some(record => record.action && record.input.value.pending?.kind === "create")) return;
    const conversationId = this.ports.identity(), key = { projectId: this.context.projectId, conversationId };
    const pending: ConversationDraftPending = { kind: "create", submittedSeq: "1", request: { ...key, actionId: this.ports.identity(), title: null } };
    const record: RecordState = { input: { key, head: { key, revision: "0", writerId: null, value: null }, value: { text: "", editSeq: "1", pending },
      dirty: true, journalBusy: false, revocationStates: new Map(), busy: null, outcome: null, notice: null, failure: null, planning: planningInput(), proposalEditorId: null, proposalFailure: null, capturedResultIds: [], workPlan: workPlanInput(),
      readyRuns: new Map(), recoveryStates: new Map(), runFailure: null, runBusy: null }, job: null, writing: null, action: false, submitting: null, revoking: new Set(), revocationEpoch: new Map() };
    this.records.set(conversationId, record); this.changed++; this.publish({ activeId: conversationId });
    await this.submit(record);
  }
  edit(conversationId: string, text: string) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live || text === record.input.value.text) return;
    const editSeq = nextEditSeq(record.input.value.editSeq), value = { ...record.input.value, text, editSeq, messageEditSeq: editSeq };
    this.changed++; this.update(record, { value, dirty: true, notice: null });
    if (!record.input.failure && !record.action || (isConversationTeamPending(value.pending) || value.pending?.kind === "team-recovery" || value.pending?.kind === "team-question-response") && !record.job && record.input.failure?.kind !== "journal") void this.persist(record);
  }
  async append(conversationId: string) {
    const record = this.records.get(conversationId);
    if (!record || !this.kernel.live || record.action || record.input.busy || record.input.value.pending || record.input.failure) return;
    const text = record.input.value.text;
    if (!isConversationMessageText(text)) return;
    const editSeq = nextEditSeq(record.input.value.editSeq);
    const pending: ConversationDraftPending = { kind: "append", submittedSeq: editSeq,
      request: { ...record.input.key, actionId: this.ports.identity(), messageId: this.ports.identity(), body: text } };
    this.changed++; this.update(record, { value: { ...record.input.value, text, editSeq, messageEditSeq: editSeq, pending }, dirty: true, outcome: null, notice: null, failure: null });
    await this.submit(record);
  }
  beginProposalEdit(revision: ConversationProposalRevision) {
    const record = this.records.get(revision.conversationId);
    if (!record || !this.kernel.live || revision.projectId !== this.context.projectId || !editableProposal(revision.content)) return;
    const edits = record.input.value.proposalEdits ?? [];
    if (edits.some(edit => edit.proposalId === revision.proposalId)) { this.update(record, { proposalEditorId: revision.proposalId }); return; }
    const editSeq = nextEditSeq(record.input.value.editSeq);
    const edit: ConversationProposalDraft = { proposalId: revision.proposalId, expectedRevisionId: revision.revisionId, editSeq, content: structuredClone(revision.content) };
    this.changeProposalEdits(record, [...edits, edit], editSeq, revision.proposalId);
  }
  showProposalEdit(conversationId: string, proposalId: string) {
    const record = this.records.get(conversationId);
    if (record && this.kernel.live && record.input.value.proposalEdits?.some(edit => edit.proposalId === proposalId)) this.update(record, { proposalEditorId: proposalId });
  }
  editProposal(conversationId: string, proposalId: string, change: (content: ProposalContent) => ProposalContent) {
    const record = this.records.get(conversationId), edits = record?.input.value.proposalEdits ?? [], original = edits.find(edit => edit.proposalId === proposalId);
    if (!record || !this.kernel.live || !original || !editableProposal(original.content)) return;
    const editSeq = nextEditSeq(record.input.value.editSeq), content = change(structuredClone(original.content));
    if (content.kind !== original.content.kind) return;
    this.changeProposalEdits(record, edits.map(edit => edit === original ? { ...edit, editSeq, content } : edit), editSeq, proposalId);
  }
  private changeProposalEdits(record: RecordState, edits: ConversationProposalDraft[], editSeq: string, proposalEditorId: string | null) {
    this.changed++;
    this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, proposalEdits: edits.length ? edits : undefined }, dirty: true, proposalEditorId, proposalFailure: null, notice: null });
    if (!record.action && !record.input.failure) void this.persist(record);
  }
  addProposalMember(conversationId: string, proposalId: string) {
    const record = this.records.get(conversationId), draft = record?.input.value.proposalEdits?.find(edit => edit.proposalId === proposalId);
    if (!record || !this.kernel.live || draft?.content.kind !== "proposal" || draft.content.options.mcpTermQuery
      || !draft.content.unitIds.length || (draft.content.options.teamExecution?.members.length ?? 0) >= 8) return;
    const initialUnitId = draft.content.unitIds[0];
    if (!initialUnitId) return;
    const member = newProposalMember(draft.content.unitIds, this.ports.identity, draft.content.options.teamExecution?.members[0]);
    this.editProposal(conversationId, proposalId, content => {
      if (content.kind !== "proposal") return content;
      const previous = content.options.teamExecution;
      return { ...content, options: { ...content.options,
        stages: content.options.stages.some(choice => choice.stage === "generation")
          ? content.options.stages.map(choice => choice.stage === "generation" ? { ...choice, mode: "assisted" } : choice)
          : [...content.options.stages, { stage: "generation", mode: "assisted" }],
        teamDiscussions: content.options.teamDiscussions ?? { profile: "current-plan-1" },
        teamExecution: previous ? { ...previous, members: [...previous.members, member] }
          : { profile: "bounded-team-1", initialMemberId: member.memberId, initialUnitId, members: [member],
            limits: { maxActivations: 12, maxConcurrency: 1, maxNoProgress: 3 } },
      } };
    });
    return member.memberId;
  }
  discardProposalEdit(conversationId: string, proposalId: string, expectedSeq: string): boolean {
    const record = this.records.get(conversationId), edits = record?.input.value.proposalEdits ?? [], original = edits.find(edit => edit.proposalId === proposalId);
    if (!record || !this.kernel.live || record.action || record.input.value.pending || !original || original.editSeq !== expectedSeq) return false;
    const remaining = edits.filter(edit => edit !== original);
    this.changeProposalEdits(record, remaining, nextEditSeq(record.input.value.editSeq), remaining[0]?.proposalId ?? null); return true;
  }
  acceptProposalBase(revision: ConversationProposalRevision, expectedSeq: string): boolean {
    const record = this.records.get(revision.conversationId), edits = record?.input.value.proposalEdits ?? [], original = edits.find(edit => edit.proposalId === revision.proposalId);
    if (!record || !this.kernel.live || record.action || record.input.value.pending || revision.projectId !== this.context.projectId || !original || original.editSeq !== expectedSeq || revision.content.kind !== original.content.kind) return false;
    const editSeq = nextEditSeq(record.input.value.editSeq);
    this.changeProposalEdits(record, edits.map(edit => edit === original ? { ...edit, expectedRevisionId: revision.revisionId, editSeq } : edit), editSeq, revision.proposalId); return true;
  }
  async captureProposal(run: ConversationPlanningRun) {
    const record = this.records.get(run.preview.conversationId);
    if (!record || !this.kernel.live || record.action || record.input.busy || record.input.value.pending || record.input.failure
      || run.preview.projectId !== this.context.projectId || !run.output || !editableProposal(run.output.model) || !run.resultId || record.input.capturedResultIds.includes(run.resultId)) return;
    const editSeq = nextEditSeq(record.input.value.editSeq), pending: ConversationDraftPending = { kind: "proposal-capture", submittedSeq: editSeq,
      request: { ...record.input.key, actionId: this.ports.identity(), proposalId: this.ports.identity(), revisionId: this.ports.identity(), attemptId: run.receipt.consent.attemptId, resultId: run.resultId } };
    this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, pending }, dirty: true, outcome: null, failure: null, notice: null });
    await this.submit(record);
  }
  async saveProposal(conversationId: string, proposalId: string, current: () => boolean = () => true) {
    const record = this.records.get(conversationId), original = record?.input.value.proposalEdits?.find(edit => edit.proposalId === proposalId);
    if (!record || !original || !this.kernel.live || record.action || record.input.busy || record.input.value.pending || record.input.failure || !validProposalContent(original.content) || !current()) return;
    const live = () => this.kernel.live && current() && record.input.value.proposalEdits?.find(edit => edit.proposalId === proposalId)?.editSeq === original.editSeq;
    record.action = true; this.update(record, { busy: "check", proposalFailure: null });
    try {
      const base = await this.ports.validateProposal({ ...this.context, conversationId, proposalId, revisionId: original.expectedRevisionId });
      if (!live()) return;
      const run = await this.ports.readPlanning({ ...this.context, conversationId, attemptId: base.origin.attemptId });
      if (!live()) return;
      if (!run || run.resultId !== base.origin.resultId || !validProposalContent(original.content, run)) throw new Error("The proposal material no longer matches");
      const editSeq = nextEditSeq(record.input.value.editSeq);
      const pending: ConversationDraftPending = { kind: "proposal-revision", submittedSeq: editSeq, request: { ...record.input.key,
        actionId: this.ports.identity(), proposalId, revisionId: this.ports.identity(), expectedRevisionId: original.expectedRevisionId, content: structuredClone(original.content) } };
      this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, pending,
        proposalEdits: record.input.value.proposalEdits?.map(edit => edit.proposalId === proposalId ? { ...edit, editSeq } : edit) }, dirty: true, outcome: null, notice: null });
      await this.performLocal(record);
    } catch (error) {
      if (!this.kernel.live) return;
      record.submitting = null;
      if (record.input.value.pending) this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
      else if (live()) this.update(record, { proposalFailure: { proposalId, cause: commandFailure(error) } });
    } finally {
      record.action = false; record.submitting = null; if (this.kernel.live) { this.update(record, { busy: null }); if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record); }
    }
  }
  beginWorkPlan(revision: ConversationProposalRevision) {
    const record = this.records.get(revision.conversationId);
    if (!record || !this.kernel.live || record.action || revision.projectId !== this.context.projectId || revision.content.kind !== "proposal") return;
    const before = record.input.workPlan;
    this.update(record, { workPlan: before.revision?.revisionId === revision.revisionId ? { ...before, open: true, consent: false, executionConsent: emptyExecutionConsent() }
      : { ...workPlanInput(), open: true, sequence: before.sequence + 1, strategyDefaultSequence: before.sequence + 1,
        revision: structuredClone(revision), config: { ...structuredClone(defaultAiConfig), maxItems: revision.content.unitIds.length } } });
  }
  cancelWorkPlanStrategyDefault(conversationId: string) {
    const record = this.records.get(conversationId);
    if (!record || !this.kernel.live || record.input.workPlan.strategyDefault !== "loading") return;
    this.strategyDefaultLoads.delete(conversationId);
    this.update(record, { workPlan: { ...record.input.workPlan, strategyDefault: "failed",
      strategyDefaultFailure: commandFailure(new Error("Default context reading was interrupted")) } });
  }
  async loadWorkPlanStrategyDefault(conversationId: string, reads: SessionReads, current: () => boolean = () => true) {
    const record = this.records.get(conversationId), before = record?.input.workPlan, revision = before?.revision;
    if (!record || !before || !revision || !this.kernel.live || reads.retired || record.action || record.input.busy || record.input.value.pending
      || record.input.failure || !before.open || before.busy || this.state.activeId !== conversationId || !current()
      || (before.strategyDefault !== "idle" && before.strategyDefault !== "failed")) return;
    const ticket = {};
    this.strategyDefaultLoads.set(conversationId, ticket);
    this.update(record, { workPlan: { ...before, strategyDefault: "loading", strategyDefaultFailure: null } });
    const retained = () => this.kernel.live && this.strategyDefaultLoads.get(conversationId) === ticket
      && record.input.workPlan.revision?.revisionId === revision.revisionId;
    const unchanged = () => retained() && !reads.retired && record.input.workPlan.sequence === before.sequence
      && record.input.workPlan.open && this.state.activeId === conversationId && !record.action && !record.input.busy
      && !record.input.value.pending && !record.input.failure && current();
    try {
      if (reads.context.projectId !== this.context.projectId || reads.context.sessionToken !== this.context.sessionToken)
        throw new Error("Default context reading belongs to another session");
      // The proposal's original material supplies the target language. Interface
      // language and the currently selected table entries cannot change it.
      const run = await reads.client.fetchQuery({ queryKey: reads.key(["conversation", conversationId, "planning", revision.origin.attemptId]),
        meta: { scopes: ["project", "execution"] }, queryFn: () => this.ports.readPlanning({ ...this.context, conversationId, attemptId: revision.origin.attemptId }) });
      if (!unchanged()) return;
      if (!run || run.preview.projectId !== this.context.projectId || run.preview.conversationId !== conversationId
        || run.receipt.consent.attemptId !== revision.origin.attemptId || run.receipt.inputDigest !== revision.origin.inputDigest || run.resultId !== revision.origin.resultId
        || run.preview.scope.kind !== "units" || !validProposalContent(revision.content, run)) throw new Error("The proposal's original target language is not available");
      const locale = run.preview.scope.locale, key = reads.key(strategyKeys.default(locale));
      await reads.client.fetchQuery({ queryKey: key, staleTime: 0, meta: { scopes: ["arena", "project"] },
        queryFn: () => this.ports.readStrategyDefault({ ...this.context, locale }) });
      if (!unchanged()) return;
      const snapshot = reads.client.getQueryState<Awaited<ReturnType<Ports["readStrategyDefault"]>>>(key);
      if (!snapshot || snapshot.status !== "success" || snapshot.fetchStatus !== "idle" || snapshot.isInvalidated || snapshot.error !== null)
        throw new Error("The default context is not current");
      const adopted = snapshot.data, reference = adopted?.reference;
      if (adopted && (adopted.projectId !== this.context.projectId || adopted.locale !== locale)
        || reference && (reference.projectId !== this.context.projectId || reference.revisionId !== adopted?.revisionId))
        throw new Error("The default context does not match this plan");
      const candidate = reference ? await reads.client.fetchQuery({ queryKey: reads.key(["context-strategy-candidate", reference.candidateId]),
        staleTime: 0, meta: { scopes: ["arena", "source", "translation"] },
        queryFn: () => this.ports.readStrategyCandidate({ ...this.context, candidateId: reference.candidateId }) }) : null;
      if (!unchanged()) return;
      const latest = reads.client.getQueryState(key);
      if (!latest || latest !== snapshot || latest.isInvalidated || latest.fetchStatus !== "idle" || latest.error !== null)
        throw new Error("The default context changed while reading");
      if (candidate && (candidate.projectId !== this.context.projectId || candidate.locale !== locale || candidate.candidateId !== reference?.candidateId))
        throw new Error("The saved context does not match this plan");
      // Capturing a future default only changes source context and provenance.
      // Even a later explicit retry must preserve every newer configuration edit.
      const config = candidate && reference && before.sequence === before.strategyDefaultSequence
        ? { ...record.input.workPlan.config, sourceContext: structuredClone(candidate.sourceContext), contextStrategy: structuredClone(reference) }
        : record.input.workPlan.config;
      this.update(record, { workPlan: { ...record.input.workPlan, config, strategyDefault: "ready", strategyDefaultFailure: null } });
    } catch (error) {
      if (retained())
        this.update(record, { workPlan: { ...record.input.workPlan, strategyDefault: "failed", strategyDefaultFailure: commandFailure(error) } });
    } finally {
      if (retained()) {
        this.strategyDefaultLoads.delete(conversationId);
        if (record.input.workPlan.strategyDefault === "loading") this.update(record, { workPlan: { ...record.input.workPlan,
          strategyDefault: record.input.workPlan.sequence === before.sequence ? "failed" : "ready",
          strategyDefaultFailure: record.input.workPlan.sequence === before.sequence ? commandFailure(new Error("Default context reading was interrupted")) : null } });
      }
    }
  }
  setWorkPlanOpen(conversationId: string, open: boolean) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    if (!open) this.cancelWorkPlanStrategyDefault(conversationId);
    this.update(record, { workPlan: { ...record.input.workPlan, open, ...(!open ? { sequence: record.input.workPlan.sequence + 1, prepared: null, consent: false, executionConsent: emptyExecutionConsent() } : {}) } });
  }
  private editWorkPlan(record: RecordState, patch: Partial<ConversationWorkPlanInput>) {
    this.update(record, { workPlan: { ...record.input.workPlan, ...patch, sequence: record.input.workPlan.sequence + 1,
      prepared: null, consent: false, executionConsent: emptyExecutionConsent(), failure: null } });
  }
  setWorkPlanConfig(conversationId: string, change: AiConfig | ((before: AiConfig) => AiConfig)) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    const before = record.input.workPlan.config;
    this.editWorkPlan(record, { config: editedAiConfig(before, typeof change === "function" ? change(before) : change) });
  }
  setWorkPlanTools(conversationId: string, toolDraft: PlanToolDraft | null) {
    const record = this.records.get(conversationId); if (record && this.kernel.live) this.editWorkPlan(record, { toolDraft: structuredClone(toolDraft) });
  }
  setWorkPlanChecks(conversationId: string, advisoryChecks: PluginTextReviewSelection[]) {
    const record = this.records.get(conversationId); if (record && this.kernel.live) this.editWorkPlan(record, { advisoryChecks: structuredClone(advisoryChecks) });
  }
  setWorkPlanMinutes(conversationId: string, minutes: number) {
    const record = this.records.get(conversationId); if (record && this.kernel.live) this.update(record, { workPlan: { ...record.input.workPlan, sequence: record.input.workPlan.sequence + 1, minutes, consent: false } });
  }
  setWorkPlanConsent(conversationId: string, consent: boolean) {
    const record = this.records.get(conversationId); if (record && this.kernel.live) this.update(record, { workPlan: { ...record.input.workPlan,
      consent: consent && !!record.input.workPlan.prepared && workPlanMinutesValid(record.input.workPlan.minutes) } });
  }
  setWorkPlanExecutionConsent(conversationId: string, change: (before: WorkPlanExecutionConsent) => WorkPlanExecutionConsent) {
    const record = this.records.get(conversationId); if (record && this.kernel.live) this.update(record, { workPlan: { ...record.input.workPlan,
      executionConsent: change(record.input.workPlan.executionConsent), consent: false } });
  }
  invalidateWorkPlan(conversationId: string) {
    const record = this.records.get(conversationId);
    if (record && this.kernel.live && (record.input.workPlan.prepared || record.input.workPlan.consent || record.input.workPlan.busy === "prepare")) this.editWorkPlan(record, {});
  }
  async prepareWorkPlan(conversationId: string, selectedTools: ProposalWorkPlanTools = null, current: () => boolean = () => true) {
    const record = this.records.get(conversationId), before = record?.input.workPlan, revision = before?.revision;
    if (!record || !before || !revision || !this.kernel.live || record.action || record.input.busy || record.input.value.pending || record.input.failure
      || [...this.records.values()].some(other => other.input.workPlan.busy) || before.strategyDefault !== "ready"
      || revision.content.kind !== "proposal" || revision.content.questions.length || record.input.value.proposalEdits?.some(edit => edit.proposalId === revision.proposalId)
      || !validAiLimits(before.config) || !before.config.endpoint.trim() || !before.config.model.trim() || revision.content.unitIds.length > before.config.maxItems
      || !!before.toolDraft !== !!selectedTools || !current()) return;
    record.action = true;
    // The Host has one preparation slot for this project session.
    for (const other of this.records.values()) if (other !== record) this.invalidateWorkPlan(other.input.key.conversationId);
    this.update(record, { workPlan: { ...before, busy: "prepare", prepared: null, consent: false, executionConsent: emptyExecutionConsent(), failure: null } });
    const live = () => this.kernel.live && current() && record.input.workPlan.sequence === before.sequence;
    try {
      const validated = await this.ports.validateProposal({ ...this.context, conversationId, proposalId: revision.proposalId, revisionId: revision.revisionId });
      if (!live()) return;
      const run = await this.ports.readPlanning({ ...this.context, conversationId, attemptId: validated.origin.attemptId });
      if (!live()) return;
      if (!run || run.resultId !== validated.origin.resultId || run.preview.scope.kind !== "units") throw new Error("The proposal material is not available");
      const entries = selectedTools?.entries.map(tool => ({ handle: this.ports.identity(), tool: tool.tool, target: tool.target, selections: tool.selections }));
      const first = entries?.[0];
      if (selectedTools && !first) throw new Error("The selected tools are not available");
      const toolSelection: Parameters<Ports["prepareProposalWorkPlan"]>[0]["toolSelection"] = selectedTools && first && entries
        ? { entries: [first, ...entries.slice(1)], maxInvocations: selectedTools.maxInvocations } : null;
      const prepared = await this.ports.prepareProposalWorkPlan({ ...this.context, proposal: { ...record.input.key, proposalId: revision.proposalId, revisionId: revision.revisionId },
        config: structuredClone(before.config), advisoryChecks: structuredClone(before.advisoryChecks), toolSelection }, revision, run.preview.scope.locale, selectedTools?.entries.map(tool => tool.view) ?? []);
      if (!live()) return;
      this.update(record, { workPlan: { ...record.input.workPlan, prepared } });
    } catch (error) { if (live()) this.update(record, { workPlan: { ...record.input.workPlan, failure: commandFailure(error) } });
    } finally {
      record.action = false;
      if (this.kernel.live) { this.update(record, { workPlan: { ...record.input.workPlan, busy: null } }); if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record); }
    }
  }
  async authorizeWorkPlan(conversationId: string, confirmation: ProposalWorkPlanConfirmation, current: () => boolean = () => true) {
    const record = this.records.get(conversationId), before = record?.input.workPlan, prepared = before?.prepared;
    if (!record || !before || !prepared || !this.kernel.live || record.action || record.input.busy || record.input.value.pending || record.input.failure
      || [...this.records.values()].some(other => other.input.workPlan.busy)
      || !before.consent || !workPlanMinutesValid(before.minutes) || record.input.value.proposalEdits?.some(edit => edit.proposalId === prepared.proposal.proposalId) || !current()) return;
    record.action = true;
    const live = () => this.kernel.live && current() && record.input.workPlan.sequence === before.sequence && record.input.workPlan.prepared === prepared;
    this.update(record, { workPlan: { ...before, busy: "authorize", failure: null } });
    try {
      await this.ports.validateProposal({ ...this.context, conversationId, proposalId: prepared.proposal.proposalId, revisionId: prepared.proposal.revisionId });
      if (!live() || !record.input.workPlan.consent || record.input.workPlan.minutes !== before.minutes) return;
      const editSeq = nextEditSeq(record.input.value.editSeq);
      const pending: ConversationDraftPending = { kind: "proposal-work-plan", submittedSeq: editSeq, request: {
        actionId: this.ports.identity(), proposal: structuredClone(prepared.proposal), planId: prepared.plan.planId, planDigest: prepared.plan.digest,
        confirmed: true, ...structuredClone(confirmation), expiresAt: String(Math.floor(this.ports.now() / 1000) + before.minutes * 60) } };
      record.submitting = pending;
      this.changed++;
      this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, pending },
        dirty: true, outcome: null, notice: null, workPlan: { ...record.input.workPlan, consent: false } });
      if (!await this.persist(record) || !live()) return;
      this.update(record, { busy: "submit", failure: null });
      const revocationEpoch = record.revocationEpoch.get(prepared.plan.planId) ?? 0;
      const confirmed = await this.ports.authorizeProposalWorkPlan({ ...this.context, authorization: pending.request });
      if (!this.kernel.live) return;
      if (revocationEpoch === (record.revocationEpoch.get(prepared.plan.planId) ?? 0)) this.rememberReadyRun(record, prepared.plan, confirmed.receipt);
      this.onRecorded(); this.update(record, { busy: null, outcome: "recorded", workPlan: { ...record.input.workPlan, prepared: null, consent: false, executionConsent: emptyExecutionConsent() } });
      await this.resolve(record, pending);
    } catch (error) {
      if (!this.kernel.live) return;
      record.submitting = null;
      if (record.input.value.pending) this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
      else if (live()) this.update(record, { workPlan: { ...record.input.workPlan, failure: commandFailure(error) } });
    } finally {
      record.action = false; record.submitting = null;
      if (this.kernel.live) { this.update(record, { workPlan: { ...record.input.workPlan, busy: null } }); if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record); }
    }
  }
  private rememberReadyRun(record: RecordState, plan: WorkPlanView, receipt: WorkPlanReceiptView) {
    const readyRuns = new Map(record.input.readyRuns);
    readyRuns.set(plan.planId, { plan: structuredClone(plan), receipt: structuredClone(receipt) });
    this.update(record, { readyRuns });
  }
  private forgetReadyRun(record: RecordState, planId: string) {
    if (!record.input.readyRuns.has(planId)) return;
    const readyRuns = new Map(record.input.readyRuns); readyRuns.delete(planId); this.update(record, { readyRuns });
  }
  canStartRun(conversationId: string, status: WorkPlanStatusView) {
    const record = this.records.get(conversationId);
    return !!record && this.runAvailable(record, status.plan.planId)
      && runReadyCurrent(record.input.readyRuns.get(status.plan.planId), status, this.ports.now());
  }
  private runAvailable(record: RecordState, planId: string) {
    return this.kernel.live && !record.action && !record.input.busy && !record.input.journalBusy && !record.input.value.pending && !record.input.failure
      && !(record.input.value.revocations ?? []).some(slot => slot.request.planId === planId);
  }
  private async currentRun(record: RecordState, link: ConversationPlanLink, expected: WorkPlanStatusView, execution: boolean, current: () => boolean) {
    const status = await this.ports.planStatus({ ...this.context, planId: link.planId });
    if (!this.kernel.live || !current()) return null;
    if (!runMatchesLink(status, link) || !same(status.lease, expected.lease) || status.state !== expected.state
      || execution && (status.expiresAt !== expected.expiresAt || !same(status.effects, expected.effects)
        || !same(status.plan, expected.plan))) throw new Error("The work plan changed. Read its status again before continuing");
    return status;
  }
  async startRun(link: ConversationPlanLink, expected: WorkPlanStatusView, current: () => boolean = () => true) {
    const record = this.records.get(link.conversationId), ready = record?.input.readyRuns.get(link.planId);
    if (!record || link.projectId !== this.context.projectId || !runMatchesLink(expected, link) || !this.runAvailable(record, link.planId)
      || !runReadyCurrent(ready, expected, this.ports.now()) || !ready?.receipt.attemptId || !current()) return;
    record.action = true; this.update(record, { busy: "check", runBusy: { planId: link.planId, kind: "start" }, runFailure: null });
    try {
      const status = await this.currentRun(record, link, expected, true, current);
      if (!status || !runReadyCurrent(ready, status, this.ports.now()) || record.input.readyRuns.get(link.planId) !== ready) return;
      const editSeq = nextEditSeq(record.input.value.editSeq);
      const pending: ConversationRunPending = { kind: "work-plan-start", conversationId: link.conversationId, submittedSeq: editSeq,
        expectedAttemptId: ready.receipt.attemptId, request: { projectId: link.projectId, planId: link.planId, actionId: ready.receipt.actionId, expectedGeneration: ready.receipt.lease.generation } };
      this.queueRun(record, pending, editSeq);
      await this.performRun(record, pending, () => current() && record.input.readyRuns.get(link.planId) === ready
        && runReadyCurrent(ready, status, this.ports.now()));
    } catch (error) { this.runFailed(record, link.planId, error);
    } finally { this.finishRun(record); }
  }
  async controlRun(link: ConversationPlanLink, expected: WorkPlanStatusView, command: WorkPlanCommand, confirmation: ConversationRunConfirmation | null = null, current: () => boolean = () => true) {
    if (command !== "continue") { await this.revokeRun(link, expected, command, current); return; }
    const record = this.records.get(link.conversationId), continuing = command === "continue";
    if (!record || link.projectId !== this.context.projectId || !runMatchesLink(expected, link) || !this.runAvailable(record, link.planId) || !current()
      || continuing && (expected.state !== "paused" && expected.state !== "taken-over" || expected.plan.options.teamExecution || expected.plan.options.mcpTermQuery
        || !confirmation?.confirmed || !workPlanMinutesValid(confirmation.minutes))) return;
    const epoch = record.revocationEpoch.get(link.planId) ?? 0;
    record.action = true; this.update(record, { busy: "check", runBusy: { planId: link.planId, kind: "control" }, runFailure: null });
    try {
      const status = await this.currentRun(record, link, expected, continuing, current); if (!status) return;
      const editSeq = nextEditSeq(record.input.value.editSeq);
      const pending: ConversationRunPending = { kind: "work-plan-control", conversationId: link.conversationId, submittedSeq: editSeq,
        request: { projectId: link.projectId, planId: link.planId, actionId: this.ports.identity(), expectedGeneration: status.lease.generation, command,
          confirmed: continuing, checkerExecutions: continuing && confirmation ? structuredClone(confirmation.checkerExecutions) : [],
          toolExecution: continuing && confirmation ? confirmation.toolExecution : false,
          applicationToolExecutions: continuing && confirmation ? structuredClone(confirmation.applicationToolExecutions) : [],
          expiresAt: continuing && confirmation ? String(Math.floor(this.ports.now() / 1000) + confirmation.minutes * 60) : null } };
      this.forgetReadyRun(record, link.planId); this.queueRun(record, pending, editSeq);
      await this.performRun(record, pending, current, status.plan, epoch);
    } catch (error) { this.runFailed(record, link.planId, error);
    } finally { this.finishRun(record); }
  }
  canRevokeRun(conversationId: string, status: WorkPlanStatusView, command: ConversationRevocationCommand) {
    const record = this.records.get(conversationId), slots = record?.input.value.revocations ?? [];
    return !!record && this.kernel.live && !record.job && !record.input.journalBusy && record.input.failure?.kind !== "journal"
      && slots.length < 32 && revocationAllowed(command, status.state)
      && !slots.some(slot => slot.request.planId === status.plan.planId && slot.request.expectedGeneration === status.lease.generation && slot.request.command === command);
  }
  private updateRevocation(record: RecordState, actionId: string, patch: Partial<ConversationRevocationState>) {
    const before = record.input.revocationStates.get(actionId) ?? { busy: null, outcome: null, failure: null };
    const states = new Map(record.input.revocationStates); states.set(actionId, { ...before, ...patch });
    this.update(record, { revocationStates: states });
  }
  private async revokeRun(link: ConversationPlanLink, expected: WorkPlanStatusView, command: ConversationRevocationCommand, current: () => boolean) {
    const record = this.records.get(link.conversationId);
    if (!record || link.projectId !== this.context.projectId || !runMatchesLink(expected, link)
      || !this.canRevokeRun(link.conversationId, expected, command) || !current()) return;
    const actionId = this.ports.identity(); record.revoking.add(actionId);
    try {
      // Capture the displayed generation before the first await. The original
      // control boundary checks it again; a stale request remains identifiable.
      const editSeq = nextEditSeq(record.input.value.editSeq), slot: ConversationDraftRevocation = { submittedSeq: editSeq,
        request: { projectId: link.projectId, planId: link.planId, actionId, expectedGeneration: expected.lease.generation, command } };
      record.revocationEpoch.set(link.planId, (record.revocationEpoch.get(link.planId) ?? 0) + 1);
      this.forgetReadyRun(record, link.planId);
      const recovery = this.recoveryState(record, link.planId);
      this.updateRecovery(record, link.planId, { prepared: null, consent: false, receipt: null, epoch: recovery.epoch + 1 }); this.changed++;
      this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq,
        editSeq, revocations: [...(record.input.value.revocations ?? []), slot] }, dirty: true, notice: null, runFailure: null });
      this.updateRevocation(record, actionId, { busy: "submit", outcome: null, failure: null });
      await this.performRevocation(record, slot, current);
    } catch (error) {
      if (this.kernel.live) {
        if ((record.input.value.revocations ?? []).some(slot => slot.request.actionId === actionId))
          this.updateRevocation(record, actionId, { busy: null, outcome: "unknown", failure: commandFailure(error) });
        else this.update(record, { runFailure: { planId: link.planId, cause: commandFailure(error) } });
      }
    } finally { this.finishRevocation(record, actionId); }
  }
  private async performRevocation(record: RecordState, slot: ConversationDraftRevocation, current: () => boolean) {
    this.updateRevocation(record, slot.request.actionId, { busy: "submit", failure: null });
    if (!await this.persist(record) || !this.kernel.live || !current()) return;
    if (!(record.input.value.revocations ?? []).some(value => same(value, slot))) return;
    await this.ports.controlPlan({ ...this.context, ...revocationControlRequest(slot.request) });
    if (!this.kernel.live) return;
    this.onRecorded();
    await this.resolveTarget(record, { kind: "revocation", revocation: slot }, "recorded");
  }
  private finishRevocation(record: RecordState, actionId: string) {
    record.revoking.delete(actionId);
    if (!this.kernel.live) return;
    if ((record.input.value.revocations ?? []).some(slot => slot.request.actionId === actionId)) this.updateRevocation(record, actionId, { busy: null });
    else this.publish();
    if (record.input.dirty && !record.job && record.input.failure?.kind !== "journal") void this.persist(record);
  }
  async checkRevocation(conversationId: string, actionId: string) {
    await this.recoverRevocation(conversationId, actionId, false, () => true);
  }
  async retryRevocation(conversationId: string, actionId: string, current: () => boolean = () => true) {
    await this.recoverRevocation(conversationId, actionId, true, current);
  }
  private async recoverRevocation(conversationId: string, actionId: string, retry: boolean, current: () => boolean) {
    const record = this.records.get(conversationId), slot = record?.input.value.revocations?.find(value => value.request.actionId === actionId);
    if (!record || !slot || !this.kernel.live || record.job || record.input.journalBusy || record.input.failure?.kind === "journal"
      || record.revoking.has(actionId) || retry && !current()) return;
    record.revoking.add(actionId); this.updateRevocation(record, actionId, { busy: "check", failure: null });
    try {
      const found = await this.ports.readPlanControlSettlement({ ...this.context, ...revocationControlRequest(slot.request) });
      if (!this.kernel.live || !(record.input.value.revocations ?? []).some(value => same(value, slot))) return;
      const outcome = found.settlement.outcome;
      if (outcome.kind === "recorded" || outcome.kind === "fenced-not-applied") {
        this.forgetReadyRun(record, slot.request.planId);
        if (outcome.kind === "recorded") this.onRecorded();
        await this.resolveTarget(record, { kind: "revocation", revocation: slot }, outcome.kind);
        return;
      }
      const allowed = found.settlement.lease.generation === slot.request.expectedGeneration && revocationAllowed(slot.request.command, found.settlement.state);
      this.updateRevocation(record, actionId, { outcome: allowed ? "absent" : "blocked" });
      if (retry && allowed && current()) await this.performRevocation(record, slot, current);
    } catch (error) { if (this.kernel.live) this.updateRevocation(record, actionId, { outcome: "unknown", failure: commandFailure(error) });
    } finally { this.finishRevocation(record, actionId); }
  }
  private queueRun(record: RecordState, pending: ConversationRunPending, editSeq: string) {
    record.submitting = pending;
    this.changed++;
    this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, pending },
      dirty: true, outcome: null, notice: null, failure: null });
  }
  private async performRun(record: RecordState, pending: ConversationRunPending, current: () => boolean, plan?: WorkPlanView, epoch?: number) {
    if (!await this.persist(record) || !this.kernel.live || !current()) return;
    this.update(record, { busy: "submit", failure: null });
    if (pending.kind === "work-plan-start") {
      await this.ports.startPlan({ ...this.context, ...pending.request }, pending.expectedAttemptId);
      if (!this.kernel.live) return;
      this.forgetReadyRun(record, pending.request.planId);
      const recovery = this.recoveryState(record, pending.request.planId);
      if (recovery.receipt?.actionId === pending.request.actionId) this.updateRecovery(record, pending.request.planId, { receipt: null, consent: false });
    } else {
      const receipt = await this.ports.controlPlan({ ...this.context, ...pending.request });
      if (!this.kernel.live) return;
      if (pending.request.command === "continue" && plan && epoch === (record.revocationEpoch.get(plan.planId) ?? 0)) this.rememberReadyRun(record, plan, receipt);
    }
    this.onRecorded(); this.update(record, { busy: null, outcome: "recorded" }); await this.resolve(record, pending);
  }
  private runFailed(record: RecordState, planId: string, error: unknown) {
    if (!this.kernel.live) return;
    record.submitting = null;
    if (isRunPending(record.input.value.pending)) this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
    else this.update(record, { runFailure: { planId, cause: commandFailure(error) } });
  }
  private finishRun(record: RecordState) {
    record.action = false; record.submitting = null;
    if (this.kernel.live) { this.update(record, { busy: null, runBusy: null }); if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record); }
  }
  canRetryRun(conversationId: string) {
    const record = this.records.get(conversationId), pending = record?.input.value.pending;
    if (!record || record.input.outcome !== "absent" || !isRunPending(pending)) return false;
    return pending.kind === "work-plan-control" ? pending.request.command !== "continue" : !!record.input.readyRuns.get(pending.request.planId) || this.recoveryState(record, pending.request.planId).receipt?.actionId === pending.request.actionId;
  }
  private async recoverRun(record: RecordState, pending: ConversationRunPending) {
    const found = pending.kind === "work-plan-control"
      ? await this.ports.readPlanControlSettlement({ ...this.context, ...pending.request })
      : await this.ports.readPlanStartSettlement({ ...this.context, ...pending.request, expectedAttemptId: pending.expectedAttemptId });
    if (found.settlement.outcome.kind !== "pending") return { outcome: found.settlement.outcome };
    if (pending.kind === "work-plan-control" && pending.request.command === "continue"
      || pending.kind === "work-plan-start" && !record.input.readyRuns.has(pending.request.planId)
        && this.recoveryState(record, pending.request.planId).receipt?.actionId !== pending.request.actionId)
      return { outcome: { kind: "pending" as const, replay: "blocked" as const } };
    const status = await this.ports.planStatus({ ...this.context, planId: pending.request.planId });
    const allowed = status.lease.generation === pending.request.expectedGeneration && status.state !== "stopped"
      && (pending.kind === "work-plan-control" || runReadyCurrent(record.input.readyRuns.get(pending.request.planId), status, this.ports.now())
        || this.recoveryStartCurrent(record, status, pending.request.actionId));
    return { outcome: { kind: "pending" as const, replay: allowed ? "explicit-same-request" as const : "blocked" as const } };
  }
  private async retryRun(record: RecordState, pending: ConversationRunPending, current: () => boolean) {
    if (!this.canRetryRun(record.input.key.conversationId) || record.action || record.input.busy || record.job || !this.kernel.live || !current()) return;
    record.action = true; this.update(record, { busy: "check", runBusy: { planId: pending.request.planId, kind: "check" }, failure: null });
    try {
      const found = await this.recoverRun(record, pending);
      if (!this.kernel.live || !current()) return;
      if (found.outcome.kind === "recorded") { this.recordCaptureAcknowledgement(record, pending); this.onRecorded(); await this.resolve(record, pending); return; }
      if (found.outcome.kind === "fenced-not-applied") { this.forgetReadyRun(record, pending.request.planId); await this.resolve(record, pending, "fenced-not-applied"); return; }
      if (found.outcome.kind !== "pending" || found.outcome.replay !== "explicit-same-request") {
        this.update(record, { outcome: "blocked" }); return;
      }
      record.submitting = pending; this.publish();
      await this.performRun(record, pending, current);
    } catch (error) { this.runFailed(record, pending.request.planId, error);
    } finally { this.finishRun(record); }
  }
  setPlanningOpen(conversationId: string, open: boolean) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    this.update(record, { planning: { ...record.input.planning, open, ...(!open ? { consent: false } : {}) } });
  }
  private editPlanning(record: RecordState, patch: Partial<ConversationPlanningInput>) {
    this.update(record, { planning: { ...record.input.planning, ...patch, sequence: record.input.planning.sequence + 1, prepared: null, consent: false, failure: null } });
  }
  setPlanningMessages(conversationId: string, messageIds: readonly string[]) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live || messageIds.length > 16 || new Set(messageIds).size !== messageIds.length) return;
    this.editPlanning(record, { messageIds: [...messageIds] });
  }
  setPlanningSelection(conversationId: string, selected: WorkspaceSelection | null): boolean {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return false;
    const selection = copyWorkspaceSelection(selected);
    try { planningSelectionScope(this.context, selection); } catch { return false; }
    this.editPlanning(record, { selection, config: planningConfig(record.input.planning.config, selection) });
    return true;
  }
  setPlanningConfig(conversationId: string, change: AiConfig | ((before: AiConfig) => AiConfig)) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    const previous = record.input.planning.config;
    const edited = editedAiConfig(previous, typeof change === "function" ? change(previous) : change);
    const config = planningConfig(edited, record.input.planning.selection);
    this.editPlanning(record, { config });
  }
  setPlanningPurpose(conversationId: string, purpose: ConversationPlanningInput["purpose"]) {
    const record = this.records.get(conversationId);
    if (!record || !this.kernel.live || purpose === record.input.planning.purpose || purpose === "knowledge" && workspaceSelectionIds(record.input.planning.selection).length === 0) return false;
    this.editPlanning(record, { purpose }); return true;
  }
  invalidatePlanning(conversationId: string) {
    const record = this.records.get(conversationId);
    if (record && this.kernel.live && (record.input.planning.prepared || record.input.planning.consent || record.input.planning.busy === "prepare")) this.editPlanning(record, {});
  }
  setPlanningConsent(conversationId: string, consent: boolean) {
    const record = this.records.get(conversationId); if (!record || !this.kernel.live) return;
    this.update(record, { planning: { ...record.input.planning, consent: consent && !!record.input.planning.prepared } });
  }
  teamDraft(conversationId: string, planId: string) {
    return this.records.get(conversationId)?.input.value.teamDrafts?.find(draft => draft.planId === planId) ?? null;
  }
  private changeTeamDraft(link: ConversationPlanLink, change: (before: ConversationTeamDraft, editSeq: string) => ConversationTeamDraft | null) {
    const record = this.records.get(link.conversationId);
    if (!record || !this.kernel.live || link.projectId !== this.context.projectId) return false;
    const drafts = record.input.value.teamDrafts ?? [], original = drafts.find(draft => draft.planId === link.planId);
    if (original && original.planDigest !== link.planDigest || !original && drafts.length >= 32) return false;
    const editSeq = nextEditSeq(record.input.value.editSeq), before = original ?? { planId: link.planId, planDigest: link.planDigest, guidance: null, publication: null };
    const changed = change(before, editSeq), teamDrafts = original ? drafts.flatMap(value => value === original ? changed ? [changed] : [] : [value]) : changed ? [...drafts, changed] : drafts;
    this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, teamDrafts: teamDrafts.length ? teamDrafts : undefined }, dirty: true, notice: null,
      failure: record.input.value.pending ? record.input.failure : null });
    // Journal writes remain independent of a business acknowledgement: newer
    // team input must reach disk even while the original request is waiting.
    if (!record.job && record.input.failure?.kind !== "journal") void this.persist(record);
    return true;
  }
  editTeamGuidance(link: ConversationPlanLink, change: Partial<Omit<ConversationTeamGuidanceDraft, "editSeq">>) {
    return this.changeTeamDraft(link, (before, editSeq) => ({ ...before, guidance: { memberId: null, unitId: null, body: "", ...before.guidance, ...change, editSeq } }));
  }
  editTeamPublication(link: ConversationPlanLink, change: Partial<Omit<ConversationTeamPublicationDraft, "editSeq">>) {
    return this.changeTeamDraft(link, (before, editSeq) => ({ ...before, publication: { unitId: null, body: "", replyTo: null, ...before.publication, ...change, editSeq } }));
  }
  discardTeamDraft(link: ConversationPlanLink, kind: "guidance" | "publication") {
    const record = this.records.get(link.conversationId), pending = record?.input.value.pending;
    if (!record || record.action || isConversationTeamPending(pending) && pending.request.lease.planId === link.planId) return false;
    return this.changeTeamDraft(link, before => {
      const draft = { ...before, [kind]: null }; return draft.guidance || draft.publication || draft.recovery || draft.recoveryRecorded || (draft.questions?.length ?? 0) > 0 ? draft : null;
    });
  }
  canSendTeam(conversationId: string) {
    const record = this.records.get(conversationId);
    return this.kernel.live && !!record && ![...this.records.values()].some(value => value.action || value.job || value.input.busy
      || value.input.journalBusy || value.input.value.pending || value.input.failure || value.input.planning.busy || value.input.workPlan.busy
      || (value.input.value.revocations?.length ?? 0) > 0);
  }
  clearTeamPreparationFailure(conversationId: string) {
    const record = this.records.get(conversationId);
    if (!record || !this.kernel.live || record.action || record.job || record.input.value.pending || record.input.failure?.kind !== "action") return false;
    this.update(record, { failure: null }); return true;
  }
  async sendTeamGuidance(link: ConversationPlanLink, status: WorkPlanStatusView, view: TeamExecutionView, expectedSeq: string, current: () => boolean) {
    await this.submitTeam(link, status, view, "team-message", expectedSeq, current);
  }
  async publishTeamDiscussion(link: ConversationPlanLink, status: WorkPlanStatusView, expectedSeq: string, current: () => boolean) {
    await this.submitTeam(link, status, null, "team-publication", expectedSeq, current);
  }
  private async submitTeam(originalLink: ConversationPlanLink, originalStatus: WorkPlanStatusView, originalView: TeamExecutionView | null,
    kind: "team-message" | "team-publication", expectedSeq: string, current: () => boolean) {
    const link = structuredClone(originalLink), expected = structuredClone(originalStatus);
    const expectedView = originalView ? structuredClone({ effectiveVersion: originalView.effectiveVersion, roster: originalView.roster }) : null;
    const record = this.records.get(link.conversationId), saved = this.teamDraft(link.conversationId, link.planId);
    const guidance = saved?.guidance ? structuredClone(saved.guidance) : null, publication = saved?.publication ? structuredClone(saved.publication) : null;
    const draft = kind === "team-message" ? guidance : publication;
    if (!record || saved?.planDigest !== link.planDigest || !this.canSendTeam(link.conversationId) || !current()
      || !draft || draft.editSeq !== expectedSeq || !draft.body.trim() || !runMatchesLink(expected, link)) return;
    record.action = true; this.update(record, { busy: "submit", failure: null, notice: null });
    try {
      const stored = await this.ports.readProposalWorkPlan({ ...this.context, conversationId: link.conversationId, planId: link.planId });
      if (!this.kernel.live || !current()) return;
      if (!same(stored, link)) throw new Error("The original conversation plan changed");
      const status = await this.currentRun(record, link, expected, true, current);
      if (!status || !this.kernel.live || !current()) return;
      const unit = status.plan.scope.find(value => value.unitId === draft.unitId);
      if (!unit) throw new Error("Choose an entry from the original plan");
      const target = { unitId: unit.unitId, locale: status.plan.locale, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId };
      let pending: Extract<ConversationDraftPending, { kind: "team-message" | "team-publication" }>;
      if (kind === "team-message") {
        if (!guidance || !expectedView) return;
        const view = await this.ports.readTeamExecution({ ...this.context, planId: link.planId, afterWork: null, afterMessage: null, limit: 16 });
        if (!this.kernel.live || !current()) return;
        const member = view.roster.find(value => value.memberId === guidance.memberId && value.unitIds.includes(unit.unitId));
        if (!teamGuidanceActive(status, view) || !same(view.effectiveVersion, expectedView.effectiveVersion) || !same(view.roster, expectedView.roster)
          || !member || new TextEncoder().encode(guidance.body).length > view.messageLimits.maxBodyBytes) throw new Error("The team or recipient changed. Read the records again");
        pending = { kind, conversationId: link.conversationId, submittedSeq: guidance.editSeq, targetName: unit.nativeKey,
          destination: { name: member.displayName, role: member.role, endpoint: member.config.endpoint, model: member.config.model },
          request: { projectId: this.context.projectId, lease: structuredClone(status.lease), message: { messageId: this.ports.identity(), recipientMemberId: member.memberId,
            expectedRecipientRoleVersionId: member.roleVersionId, target, body: guidance.body } } };
      } else {
        if (!publication || !teamPublicationActive(status) || !status.plan.teamDiscussionLimits
          || new TextEncoder().encode(publication.body).length > status.plan.teamDiscussionLimits.maxPostBytes) throw new Error("The discussion cannot accept this post. Read the records again");
        pending = { kind, conversationId: link.conversationId, submittedSeq: publication.editSeq, targetName: unit.nativeKey,
          request: { projectId: this.context.projectId, lease: structuredClone(status.lease), publication: { postId: this.ports.identity(), target,
            kind: "note", body: publication.body, references: [], replyTo: publication.replyTo, supersedes: null } } };
      }
      const editSeq = nextEditSeq(record.input.value.editSeq);
      this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, pending }, dirty: true, outcome: "unknown" });
      record.submitting = pending; this.publish();
      if (!await this.persist(record) || !this.kernel.live || !current() || !same(record.input.value.pending, pending)) return;
      await this.dispatchTeam(record, pending);
    } catch (error) { if (this.kernel.live) this.update(record, { outcome: record.input.value.pending ? "unknown" : null, failure: { kind: "action", cause: commandFailure(error) } }); }
    finally {
      record.action = false; record.submitting = null;
      if (this.kernel.live) { this.update(record, { busy: null }); if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record); }
    }
  }
  private async dispatchTeam(record: RecordState, pending: Extract<ConversationDraftPending, { kind: "team-message" | "team-publication" }>) {
    if (pending.kind === "team-message") await this.ports.sendTeamMessage({ ...pending.request, sessionToken: this.context.sessionToken });
    else await this.ports.publishTeam({ ...pending.request, sessionToken: this.context.sessionToken });
    if (!this.kernel.live) return;
    this.onRecorded(); this.update(record, { outcome: "recorded" });
    await this.resolve(record, pending);
  }
  canRetryTeam(conversationId: string) {
    const record = this.records.get(conversationId);
    return !!record && this.kernel.live && isConversationTeamPending(record.input.value.pending) && record.input.outcome === "absent"
      && !record.action && !record.job && !record.input.busy && !record.input.journalBusy && !record.input.failure
      && ![...this.records.values()].some(value => value !== record && (value.action || value.input.value.pending));
  }
  private async retryTeam(record: RecordState, pending: Extract<ConversationDraftPending, { kind: "team-message" | "team-publication" }>, current: () => boolean) {
    if (!this.canRetryTeam(record.input.key.conversationId) || !current()) return;
    record.action = true; record.submitting = pending; this.update(record, { busy: "submit", failure: null });
    try { if (await this.persist(record) && this.kernel.live && current()) await this.dispatchTeam(record, pending); }
    catch (error) { if (this.kernel.live) this.update(record, { outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } }); }
    finally {
      record.action = false; record.submitting = null;
      if (this.kernel.live) { this.update(record, { busy: null }); if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record); }
    }
  }
  private async recoverTeam(pending: Extract<ConversationDraftPending, { kind: "team-message" | "team-publication" }>) {
    const proof = pending.kind === "team-message" ? await this.ports.teamMessageSettlement({ ...pending.request, sessionToken: this.context.sessionToken })
      : await this.ports.teamPublicationSettlement({ ...pending.request, sessionToken: this.context.sessionToken });
    const outcome = proof.settlement.outcome;
    return { outcome: outcome.kind === "pending" ? { kind: "pending" as const, replay: "explicit-same-request" as const } : outcome };
  }
  editTeamQuestion(link: ConversationPlanLink, questionPostId: string, patch: Partial<Omit<ConversationTeamQuestionDraft, "questionPostId" | "editSeq">>) {
    return this.changeTeamDraft(link, (before, editSeq) => {
      const drafts = before.questions ?? [], original = drafts.find(draft => draft.questionPostId === questionPostId);
      if (!original && drafts.length >= 32) return before;
      const changed: ConversationTeamQuestionDraft = { questionPostId, editSeq, mode: "text", optionId: null, body: "", dismissReason: "", ...original, ...structuredClone(patch) };
      changed.editSeq = editSeq;
      return { ...before, questions: original ? drafts.map(draft => draft === original ? changed : draft) : [...drafts, changed] };
    });
  }
  discardTeamQuestion(link: ConversationPlanLink, questionPostId: string) {
    const record = this.records.get(link.conversationId), pending = record?.input.value.pending;
    if (!record || record.action || pending?.kind === "team-question-response" && pending.request.response.questionPostId === questionPostId) return false;
    return this.changeTeamDraft(link, before => ({ ...before, questions: before.questions?.filter(draft => draft.questionPostId !== questionPostId) }));
  }
  async respondTeamQuestion(originalLink: ConversationPlanLink, originalQuestion: TeamQuestionView, expectedSeq: string,
    dismiss: boolean, current: () => boolean) {
    const link = structuredClone(originalLink), question = structuredClone(originalQuestion), record = this.records.get(link.conversationId);
    const draft = structuredClone(this.teamDraft(link.conversationId, link.planId)?.questions?.find(draft => draft.questionPostId === question.question.publication.postId) ?? null);
    if (!record || !draft || draft.editSeq !== expectedSeq || !this.canSendTeam(link.conversationId) || question.state !== "open"
      || question.question.planId !== link.planId || !current()) return;
    record.action = true; this.update(record, { busy: "submit", failure: null, notice: null });
    try {
      const stored = await this.ports.readProposalWorkPlan({ ...this.context, conversationId: link.conversationId, planId: link.planId });
      if (!this.kernel.live || !current()) return;
      if (!same(stored, link)) throw new Error("The original conversation plan changed");
      const latest = await this.ports.readTeamQuestion({ ...this.context, planId: link.planId, questionPostId: draft.questionPostId });
      if (!this.kernel.live || !current()) return;
      if (latest.state !== "open" || !same(latest.question, question.question)) throw new Error("The original question changed or already has a response");
      const response: RespondTeamQuestion["response"] = dismiss ? { kind: "dismiss", reason: draft.dismissReason }
        : draft.mode === "choice" && draft.optionId ? { kind: "choice", optionId: draft.optionId } : { kind: "text", body: draft.body };
      if (!dismiss && (draft.mode === "choice" ? !draft.optionId : !draft.body.trim())) return;
      const request = { projectId: link.projectId, planId: link.planId, response: { postId: this.ports.identity(), questionPostId: draft.questionPostId, response } };
      const pending: ConversationQuestionPending = { kind: "team-question-response", conversationId: link.conversationId,
        submittedSeq: draft.editSeq, request, question: question.question };
      this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq,
        editSeq: nextEditSeq(record.input.value.editSeq), pending }, dirty: true, outcome: "unknown" });
      record.submitting = pending; this.publish();
      if (!await this.persist(record) || !this.kernel.live || !current() || !same(record.input.value.pending, pending)
        || this.teamDraft(link.conversationId, link.planId)?.questions?.find(value => value.questionPostId === draft.questionPostId)?.editSeq !== expectedSeq) return;
      await this.dispatchQuestionResponse(record, pending);
    } catch (error) { if (this.kernel.live) this.update(record, { failure: { kind: "action", cause: commandFailure(error) }, outcome: record.input.value.pending ? "unknown" : null }); }
    finally { record.action = false; record.submitting = null; if (this.kernel.live) { this.update(record, { busy: null });
      if (record.input.dirty && !record.job && record.input.failure?.kind !== "journal") void this.persist(record); } }
  }
  private async dispatchQuestionResponse(record: RecordState, pending: ConversationQuestionPending) {
    await this.ports.respondTeamQuestion({ ...this.context, ...pending.request }, pending.question);
    if (!this.kernel.live) return;
    this.onRecorded(); this.update(record, { outcome: "recorded", failure: null }); await this.resolve(record, pending);
  }
  private async recoverQuestionResponse(pending: ConversationQuestionPending) {
    const proof = await this.ports.teamQuestionSettlement({ ...this.context, ...pending.request }, pending.question);
    const outcome = proof.outcome;
    return { outcome: outcome.kind === "recorded" ? outcome : outcome.kind === "closed-by-other"
      ? { kind: "fenced-not-applied" as const } : { kind: "pending" as const, replay: "explicit-same-request" as const } };
  }
  canRetryQuestion(conversationId: string) {
    const input = this.records.get(conversationId)?.input;
    return input?.value.pending?.kind === "team-question-response" && input.outcome === "absent";
  }
  private async retryQuestionResponse(record: RecordState, pending: ConversationQuestionPending, current: () => boolean) {
    if (!this.kernel.live || !this.canRetryQuestion(record.input.key.conversationId) || record.action || record.job || record.input.busy || !current()) return;
    record.action = true; this.update(record, { busy: "check", failure: null });
    try {
      const proof = await this.recoverQuestionResponse(pending); if (!this.kernel.live) return;
      if (proof.outcome.kind === "recorded") { this.onRecorded(); await this.resolve(record, pending); return; }
      if (proof.outcome.kind === "fenced-not-applied") { await this.resolve(record, pending, "fenced-not-applied"); return; }
      if (!current()) return;
      record.submitting = pending; this.publish();
      if (await this.persist(record) && this.kernel.live && current()) await this.dispatchQuestionResponse(record, pending);
    } catch (error) { if (this.kernel.live) this.update(record, { failure: { kind: "action", cause: commandFailure(error) }, outcome: "unknown" }); }
    finally { record.action = false; record.submitting = null; if (this.kernel.live) { this.update(record, { busy: null });
      if (record.input.dirty && !record.job && record.input.failure?.kind !== "journal") void this.persist(record); } }
  }

  private recoveryState(record: RecordState, planId: string) {
    return record.input.recoveryStates.get(planId) ?? initialConversationRecoveryState();
  }
  private updateRecovery(record: RecordState, planId: string, change: Partial<ConversationRecoveryState>) {
    const states = new Map(record.input.recoveryStates);
    states.set(planId, { ...this.recoveryState(record, planId), ...change });
    this.update(record, { recoveryStates: states });
  }
  setTeamRecoveryOpen(link: ConversationPlanLink, open: boolean) {
    const record = this.records.get(link.conversationId);
    if (record && this.kernel.live) this.updateRecovery(record, link.planId, { open });
  }
  invalidateTeamRecovery(link: ConversationPlanLink) {
    const record = this.records.get(link.conversationId); if (!record || !this.kernel.live) return;
    const previous = this.recoveryState(record, link.planId);
    this.updateRecovery(record, link.planId, { prepared: null, consent: false, epoch: previous.epoch + 1 });
  }
  beginTeamRecovery(link: ConversationPlanLink, status: WorkPlanStatusView, team: TeamExecutionView) {
    const record = this.records.get(link.conversationId);
    if (!record || !this.kernel.live || !runMatchesLink(status, link) || team.planId !== link.planId || !status.plan.options.teamExecution) return;
    if (!this.teamDraft(link.conversationId, link.planId)?.recovery)
      this.changeTeamDraft(link, (before, editSeq) => ({ ...before, recovery: initialConversationRecoveryDraft(status.plan, team, editSeq) }));
    this.updateRecovery(record, link.planId, { open: true, preparedPlan: structuredClone(status.plan) });
  }
  editTeamRecovery(link: ConversationPlanLink, patch: Partial<Omit<ConversationRecoveryDraft, "editSeq">>) {
    const before = this.teamDraft(link.conversationId, link.planId)?.recovery;
    if (!before) return false;
    this.invalidateTeamRecovery(link);
    const record = this.records.get(link.conversationId); if (record) this.updateRecovery(record, link.planId, { receipt: null, readyEpoch: null });
    return this.changeTeamDraft(link, (value, editSeq) => ({ ...value, recovery: { ...before, ...structuredClone(patch), editSeq } }));
  }
  editTeamRecoveryMember(link: ConversationPlanLink, key: number, patch: Partial<Omit<ConversationRecoveryMember, "key" | "original">>) {
    const draft = this.teamDraft(link.conversationId, link.planId)?.recovery;
    if (!draft?.members.some(member => member.key === key)) return false;
    return this.editTeamRecovery(link, { members: draft.members.map(member => member.key === key
      ? { ...member, ...structuredClone(patch), ...(patch.config ? { config: editedAiConfig(member.config, patch.config) } : {}) } : member) });
  }
  addTeamRecoveryMember(link: ConversationPlanLink, plan: WorkPlanView) {
    const draft = this.teamDraft(link.conversationId, link.planId)?.recovery;
    if (!draft || plan.planId !== link.planId || plan.digest !== link.planDigest || draft.members.length >= 8 || draft.nextKey >= 0xffffffff) return false;
    const member = newConversationRecoveryMember(draft.nextKey, plan);
    return !!member && this.editTeamRecovery(link, { members: [...draft.members, member], nextKey: draft.nextKey + 1 });
  }
  removeTeamRecoveryMember(link: ConversationPlanLink, key: number) {
    const draft = this.teamDraft(link.conversationId, link.planId)?.recovery;
    if (!draft) return false;
    return this.editTeamRecovery(link, { members: draft.members.filter(member => member.key !== key),
      ...(draft.recipientKey === key ? { recipientKey: null } : {}) });
  }
  discardTeamRecovery(link: ConversationPlanLink) {
    const record = this.records.get(link.conversationId);
    if (!record || record.action || record.input.value.pending) return false;
    this.updateRecovery(record, link.planId, initialConversationRecoveryState());
    return this.changeTeamDraft(link, before => ({ ...before, recovery: null }));
  }
  setTeamRecoveryConsent(link: ConversationPlanLink, consent: boolean) {
    const record = this.records.get(link.conversationId); if (!record || !this.kernel.live) return;
    const state = this.recoveryState(record, link.planId), draft = this.teamDraft(link.conversationId, link.planId)?.recovery;
    if (!consent || state.prepared && draft?.editSeq === state.preparedSeq && !state.busy)
      this.updateRecovery(record, link.planId, { consent });
  }
  private finishRecovery(record: RecordState, planId: string) {
    record.action = false; record.submitting = null;
    if (!this.kernel.live) return;
    this.update(record, { busy: null }); this.updateRecovery(record, planId, { busy: null });
    if (record.input.dirty && !record.job && record.input.failure?.kind !== "journal") void this.persist(record);
  }
  private failRecovery(record: RecordState, planId: string, error: unknown) {
    if (!this.kernel.live) return;
    const cause = commandFailure(error);
    this.updateRecovery(record, planId, { failure: cause, consent: false });
    this.update(record, { outcome: record.input.value.pending ? "unknown" : null, failure: { kind: "action", cause } });
  }
  async prepareTeamRecovery(originalLink: ConversationPlanLink, originalStatus: WorkPlanStatusView, originalTeam: TeamExecutionView,
    originalObservation: WorkPlanTeamRecoveryStateView, current: () => boolean) {
    const link = structuredClone(originalLink), expected = structuredClone(originalStatus), expectedTeam = structuredClone(originalTeam), expectedObservation = structuredClone(originalObservation);
    const record = this.records.get(link.conversationId), draft = structuredClone(this.teamDraft(link.conversationId, link.planId)?.recovery ?? null);
    if (!record || !draft || !current() || !this.canSendTeam(link.conversationId) || !runMatchesLink(expected, link)
      || !expected.plan.options.teamExecution || !teamRecoveryAvailable(expectedObservation, expected.plan.options.teamExecution.limits)
      || conversationRecoveryProblem(draft, expected.plan, expectedTeam, expectedObservation)) return;
    const epoch = record.revocationEpoch.get(link.planId) ?? 0;
    record.action = true; this.update(record, { busy: "submit", failure: null, notice: null });
    this.updateRecovery(record, link.planId, { busy: "prepare", prepared: null, consent: false, failure: null, receipt: null });
    try {
      const stored = await this.ports.readProposalWorkPlan({ ...this.context, conversationId: link.conversationId, planId: link.planId });
      if (!this.kernel.live || !current()) return;
      if (!same(stored, link)) throw new Error("The original conversation plan changed");
      const status = await this.currentRun(record, link, expected, true, current); if (!status) return;
      const [team, observation] = await Promise.all([
        this.ports.readTeamExecution({ ...this.context, planId: link.planId, afterWork: null, afterMessage: null, limit: 16 }),
        this.ports.teamRecoveryState({ ...this.context, planId: link.planId }),
      ]);
      if (!this.kernel.live || !current()) return;
      if (BigInt(team.effectiveVersion.lease.generation) > BigInt(observation.state.lease.generation)
        || !same(team.effectiveVersion, observation.state.effectiveVersion) || !same(team.roster, expectedTeam.roster) || !same(team.effectiveVersion, expectedTeam.effectiveVersion)
        || !same(observation.state.lease, expectedObservation.state.lease) || !same(observation.state.effectiveVersion, expectedObservation.state.effectiveVersion)
        || !status.plan.options.teamExecution || !teamRecoveryAvailable(observation, status.plan.options.teamExecution.limits)
        || conversationRecoveryProblem(draft, status.plan, team, observation)) throw new Error("The recovery basis changed. Read the team records again");
      const members = draft.members.map(member => ({ memberId: member.original?.memberId ?? this.ports.identity(),
        roleVersionId: unchangedConversationRecoveryMember(member) ? member.original!.roleVersionId : this.ports.identity(),
        displayName: member.displayName, role: member.role, config: member.config, unitIds: member.unitIds, toolHandles: member.toolHandles, kinds: member.kinds }));
      const recipient = members[draft.members.findIndex(member => member.key === draft.recipientKey)], unit = status.plan.scope.find(unit => unit.unitId === draft.unitId);
      if (!recipient || !unit || (record.revocationEpoch.get(link.planId) ?? 0) !== epoch || this.teamDraft(link.conversationId, link.planId)?.recovery?.editSeq !== draft.editSeq) return;
      const wire = { ...this.context, projectId: link.projectId, preparationId: this.ports.identity(), recovery: {
        projectId: link.projectId, planId: link.planId, expectedLease: structuredClone(observation.state.lease), expectedEffectiveVersion: structuredClone(observation.state.effectiveVersion), members,
        work: { workId: this.ports.identity(), memberId: recipient.memberId, kind: draft.kind, instructions: draft.instructions, postIds: draft.postIds,
          priorWork: draft.priorWork, target: { unitId: unit.unitId, locale: status.plan.locale, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId } } } };
      if (!validateRequestWorkPlanTeamRecoveryPrepare(wire)) throw new Error("Invalid original team recovery input");
      const { sessionToken: _token, ...request } = wire;
      const pending: ConversationRecoveryPending = { kind: "team-recovery", conversationId: link.conversationId, submittedSeq: draft.editSeq, request, authorization: null };
      this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq,
        editSeq: nextEditSeq(record.input.value.editSeq), pending }, dirty: true, outcome: "unknown" });
      record.submitting = pending; this.publish();
      if (!await this.persist(record) || !this.kernel.live || !current() || !same(record.input.value.pending, pending)
        || this.teamDraft(link.conversationId, link.planId)?.recovery?.editSeq !== draft.editSeq || (record.revocationEpoch.get(link.planId) ?? 0) !== epoch) return;
      const value = await this.ports.prepareTeamRecovery({ ...this.context, ...request }, status.plan, observation);
      // The owner retains a dispatched preparation even after its view is hidden or newer input arrives.
      if (!this.kernel.live) return;
      this.updateRecovery(record, link.planId, { prepared: value, preparedRequest: request, preparedSeq: draft.editSeq, preparedPlan: status.plan,
        preparedEffects: [...status.effects], memberKeys: draft.members.map(member => member.key), unresolvedWork: observation.state.unresolvedWork, epoch, consent: false });
    } catch (error) { this.failRecovery(record, link.planId, error); }
    finally { this.finishRecovery(record, link.planId); }
  }
  async authorizeTeamRecovery(link: ConversationPlanLink, expected: WorkPlanStatusView, sequence: string, current: () => boolean,
    permission: Pick<WorkPlanTeamRecoveryAuthorizeRequest, "checkerExecutions" | "toolExecution" | "applicationToolExecutions">) {
    const record = this.records.get(link.conversationId), state = record && this.recoveryState(record, link.planId), pending = record?.input.value.pending;
    if (!record || !state?.prepared || !state.preparedPlan || !state.preparedRequest || !state.consent || state.busy || record.action || record.job || !current()
      || pending?.kind !== "team-recovery" || pending.authorization || !same(pending.request, state.preparedRequest) || sequence !== state.preparedSeq
      || this.teamDraft(link.conversationId, link.planId)?.recovery?.editSeq !== sequence || state.epoch !== (record.revocationEpoch.get(link.planId) ?? 0)) return;
    const capture = structuredClone(state), permissions = structuredClone(permission), originalLink = structuredClone(link), originalStatus = structuredClone(expected);
    record.action = true; this.update(record, { busy: "submit", failure: null }); this.updateRecovery(record, link.planId, { busy: "authorize", failure: null });
    try {
      const status = await this.currentRun(record, originalLink, originalStatus, true, current); if (!status) return;
      const [team, observation] = await Promise.all([
        this.ports.readTeamExecution({ ...this.context, planId: link.planId, afterWork: null, afterMessage: null, limit: 16 }),
        this.ports.teamRecoveryState({ ...this.context, planId: link.planId }),
      ]);
      if (!this.kernel.live || !current() || !recoveryBasisMatches(capture.prepared!, observation, team) || !status.plan.options.teamExecution
        || !teamRecoveryAvailable(observation, status.plan.options.teamExecution.limits) || !same(status.effects, capture.preparedEffects)
        || state.epoch !== (record.revocationEpoch.get(link.planId) ?? 0) || !this.recoveryState(record, link.planId).consent
        || this.teamDraft(link.conversationId, link.planId)?.recovery?.editSeq !== sequence) return;
      const authorization = { projectId: link.projectId, planId: link.planId, preparationId: capture.preparedRequest!.preparationId,
        baseLease: structuredClone(capture.prepared!.preview.baseLease), recovery: { actionId: this.ports.identity(), digest: capture.prepared!.preview.digest,
          confirmed: true, effects: [...capture.preparedEffects] }, ...permissions };
      const submitted: ConversationRecoveryPending = { ...pending, authorization };
      this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq: nextEditSeq(record.input.value.editSeq), pending: submitted }, dirty: true, outcome: "unknown" });
      record.submitting = submitted; this.publish();
      if (!await this.persist(record) || !this.kernel.live || !current() || !same(record.input.value.pending, submitted)
        || state.epoch !== (record.revocationEpoch.get(link.planId) ?? 0) || !this.recoveryState(record, link.planId).consent
        || this.teamDraft(link.conversationId, link.planId)?.recovery?.editSeq !== sequence) return;
      const { baseLease: _base, ...request } = authorization;
      const receipt = await this.ports.authorizeTeamRecovery({ ...this.context, ...request }, capture.prepared!);
      if (!this.kernel.live) return;
      const sameInput = this.teamDraft(link.conversationId, link.planId)?.recovery?.editSeq === sequence;
      this.retainRecoveryReceipt(record, submitted, receipt);
      if (state.epoch === (record.revocationEpoch.get(link.planId) ?? 0)
        && sameInput) this.updateRecovery(record, link.planId, { receipt, readyEpoch: record.revocationEpoch.get(link.planId) ?? 0, consent: false, prepared: null });
      this.onRecorded(); this.update(record, { outcome: "recorded", failure: null }); await this.resolve(record, submitted);
    } catch (error) { this.failRecovery(record, link.planId, error); }
    finally { this.finishRecovery(record, link.planId); }
  }
  private retainRecoveryReceipt(record: RecordState, pending: ConversationRecoveryPending, receipt: TeamRecoveryReceipt) {
    if (!pending.authorization || receipt.workId !== pending.request.recovery.work.workId) throw new Error("The recovery receipt does not match the original work");
    const link = { projectId: record.input.key.projectId, conversationId: record.input.key.conversationId, planId: pending.request.recovery.planId };
    const editSeq = nextEditSeq(record.input.value.editSeq), state = this.recoveryState(record, link.planId);
    const drafts = record.input.value.teamDrafts?.map(draft => {
      if (draft.planId !== link.planId) return draft;
      const recovery = draft.recovery;
      const members = recovery?.members.map((member, index) => {
        const capturedIndex = member.original ? pending.request.recovery.members.findIndex(value => value.memberId === member.original?.memberId)
          : recovery.editSeq === pending.submittedSeq ? index : same(state.preparedRequest, pending.request) ? state.memberKeys.indexOf(member.key) : -1;
        const original = pending.request.recovery.members[capturedIndex];
        return original ? { ...member, original: structuredClone(original) } : member;
      });
      return { ...draft, ...(recovery && members && !same(recovery.members, members) ? { recovery: { ...recovery, members, editSeq } } : {}),
        recoveryRecorded: { request: pending.request, authorization: pending.authorization!, receipt: structuredClone(receipt) } };
    });
    this.changed++; this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, teamDrafts: drafts }, dirty: true });
  }

  private recoveryStartCurrent(record: RecordState, status: WorkPlanStatusView, actionId?: string) {
    const state = this.recoveryState(record, status.plan.planId), receipt = state.receipt;
    return !!receipt && (!actionId || receipt.actionId === actionId) && status.state === "active"
      && same(receipt.effectiveVersion.lease, status.lease) && state.readyEpoch === (record.revocationEpoch.get(status.plan.planId) ?? 0)
      && BigInt(status.expiresAt) > BigInt(Math.floor(this.ports.now() / 1000));
  }
  canStartTeamRecovery(conversationId: string, status: WorkPlanStatusView) {
    const record = this.records.get(conversationId);
    return !!record && this.runAvailable(record, status.plan.planId) && this.recoveryStartCurrent(record, status);
  }
  async startTeamRecovery(link: ConversationPlanLink, originalStatus: WorkPlanStatusView, current: () => boolean = () => true) {
    const record = this.records.get(link.conversationId), receipt = record && this.recoveryState(record, link.planId).receipt;
    if (!record || !receipt || !current() || !this.canStartTeamRecovery(link.conversationId, originalStatus)) return;
    record.action = true; this.update(record, { busy: "check", runBusy: { planId: link.planId, kind: "start" }, runFailure: null });
    try {
      const status = await this.currentRun(record, structuredClone(link), structuredClone(originalStatus), true, current); if (!status) return;
      if (this.recoveryState(record, link.planId).receipt !== receipt || (record.revocationEpoch.get(link.planId) ?? 0) !== this.recoveryState(record, link.planId).readyEpoch) return;
      const editSeq = nextEditSeq(record.input.value.editSeq), pending: ConversationRunPending = { kind: "work-plan-start", conversationId: link.conversationId,
        submittedSeq: editSeq, expectedAttemptId: receipt.attemptId, request: { projectId: link.projectId, planId: link.planId,
          actionId: receipt.actionId, expectedGeneration: receipt.effectiveVersion.lease.generation } };
      this.queueRun(record, pending, editSeq);
      await this.performRun(record, pending, current);
    } catch (error) { this.runFailed(record, link.planId, error); }
    finally { this.finishRun(record); }
  }
  async closeTeamRecovery(link: ConversationPlanLink) {
    const record = this.records.get(link.conversationId), pending = record?.input.value.pending;
    if (!record || !this.kernel.live || record.action || record.job || pending?.kind !== "team-recovery" || pending.request.recovery.planId !== link.planId) return;
    record.action = true; this.update(record, { busy: "check", failure: null });
    this.updateRecovery(record, link.planId, { busy: "close", consent: false, prepared: null, receipt: null, failure: null });
    try {
      await this.ports.closeTeamRecoveryPreparation({ ...this.context, ...pending.request });
      if (!this.kernel.live) return;
      const recovery = await this.recoverTeamRecovery(pending);
      if (!this.kernel.live) return;
      if (recovery.outcome.kind === "recorded") { this.retainRecoveryReceipt(record, pending, recovery.outcome.receipt); this.onRecorded(); await this.resolve(record, pending); }
      else if (recovery.outcome.kind === "fenced-not-applied") await this.resolve(record, pending, "fenced-not-applied");
      this.update(record, { outcome: recovery.outcome.kind === "pending" ? "blocked" : recovery.outcome.kind === "recorded" ? "recorded" : "blocked" });
    } catch (error) { this.failRecovery(record, link.planId, error); }
    finally { this.finishRecovery(record, link.planId); }
  }
  private async recoverTeamRecovery(pending: ConversationRecoveryPending) {
    if (pending.authorization) {
      const result = await this.ports.teamRecoverySettlement({ ...this.context, ...pending.authorization });
      if (result.settlement.outcome.kind === "recorded" && result.settlement.outcome.receipt.workId !== pending.request.recovery.work.workId)
        throw new Error("The recovery receipt belongs to different original work");
      return { outcome: result.settlement.outcome.kind === "pending" ? { kind: "pending" as const, replay: "blocked" as const } : result.settlement.outcome };
    }
    const result = await this.ports.readTeamRecoveryPreparation({ ...this.context, ...pending.request });
    return { outcome: BigInt(result.lease.generation) > BigInt(pending.request.recovery.expectedLease.generation) && result.hostCallbacksDrained
      ? { kind: "fenced-not-applied" as const } : { kind: "pending" as const, replay: "blocked" as const } };
  }

  private canPrepare(record: RecordState) {
    const { planning, value, busy, failure } = record.input;
    return this.kernel.live && !record.action && !busy && !value.pending && !failure
      && planning.messageIds.length > 0 && planning.messageIds.length <= 16 && validAiLimits(planning.config)
      && !!planning.config.endpoint.trim() && !!planning.config.model.trim()
      && (planning.purpose !== "knowledge" || workspaceSelectionIds(planning.selection).length > 0);
  }
  async preparePlanning(conversationId: string, current: () => boolean = () => true) {
    const record = this.records.get(conversationId); if (!record || !this.canPrepare(record) || !current()) return;
    const before = record.input.planning;
    let failureKind: "selection" | "request" = "selection";
    record.action = true;
    this.update(record, { planning: { ...before, busy: "prepare", prepared: null, consent: false, failure: null } });
    try {
      const live = () => this.kernel.live && record.input.planning.sequence === before.sequence && current();
      const scope = await checkPlanningSelection(this.context, before.selection, live, this.ports.captureSelection);
      if (!live()) return;
      failureKind = "request";
      const prepared = await this.ports.preparePlanning({ ...this.context, conversationId, config: structuredClone(before.config),
        selectedMessageIds: [...before.messageIds], scope, ...(before.purpose ? { purpose: before.purpose } : {}) });
      if (!live()) return;
      failureKind = "selection";
      if (!planningSelectionMatchesPreview(before.selection, prepared) || (prepared.preview.purpose ?? null) !== before.purpose) throw new Error("The planning source selection or purpose has changed");
      await checkPlanningSelection(this.context, before.selection, live, this.ports.captureSelection);
      if (!live()) return;
      // Host retains one capture. Another thread's earlier preview cannot remain confirmable.
      for (const other of this.records.values()) if (other !== record && other.input.planning.prepared) this.editPlanning(other, {});
      this.update(record, { planning: { ...record.input.planning, prepared } });
    } catch (error) { if (this.kernel.live && record.input.planning.sequence === before.sequence) this.update(record, { planning: { ...record.input.planning, failure: { kind: failureKind, cause: commandFailure(error) } } });
    } finally {
      record.action = false;
      if (this.kernel.live) {
        this.update(record, { planning: { ...record.input.planning, busy: null } });
        if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record);
      }
    }
  }
  async startPlanning(conversationId: string, current: () => boolean = () => true) {
    const record = this.records.get(conversationId), before = record?.input.planning, prepared = before?.prepared;
    if (!record || !before || !prepared || !before.consent || !this.canPrepare(record) || !current()) return;
    record.action = true;
    this.update(record, { planning: { ...before, busy: "start", failure: null } });
    try {
      await this.ports.validatePlanning({ ...this.context, preparationId: prepared.preparationId }, prepared);
      if (!this.kernel.live || record.input.planning.sequence !== before.sequence || !record.input.planning.consent || !current()) {
        if (this.kernel.live) this.invalidatePlanning(conversationId);
        return;
      }
      const actionId = this.ports.identity(), editSeq = nextEditSeq(record.input.value.editSeq);
      const consent = { actionId, attemptId: actionId, taskId: this.ports.identity(), previewDigest: prepared.previewDigest,
        expiresAtMs: String(this.ports.now() + Math.min(prepared.preview.config.timeoutSeconds, 120) * 1000), shareMessages: true, shareUnits: prepared.preview.scope.kind === "units" };
      const pending: ConversationDraftPending = { kind: "planning", preparationId: prepared.preparationId, submittedSeq: editSeq,
        request: { ...record.input.key, consent } };
      record.submitting = pending;
      this.changed++;
      this.update(record, { value: { ...record.input.value, messageEditSeq: record.input.value.messageEditSeq ?? record.input.value.editSeq, editSeq, pending }, dirty: true, outcome: null, notice: null,
        planning: { ...record.input.planning, prepared: null, consent: false } });
      if (!await this.persist(record) || !this.kernel.live) return;
      this.update(record, { busy: "submit", failure: null });
      await this.ports.startPlanning({ ...this.context, conversationId, preparationId: prepared.preparationId, consent });
      if (!this.kernel.live) return;
      this.onRecorded(); this.update(record, { busy: null, outcome: "recorded" });
      await this.resolve(record, pending);
    } catch (error) {
      if (!this.kernel.live) return;
      record.submitting = null;
      if (record.input.value.pending?.kind === "planning") this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
      else if (record.input.planning.sequence === before.sequence) this.update(record, { planning: { ...record.input.planning, prepared: null, consent: false, failure: { kind: "request", cause: commandFailure(error) } } });
    } finally {
      record.action = false; record.submitting = null;
      if (this.kernel.live) {
        this.update(record, { planning: { ...record.input.planning, busy: null } });
        if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record);
      }
    }
  }
  private writeJob(record: RecordState): JournalJob {
    return { kind: "write", request: { sessionToken: this.context.sessionToken, write: {
      key: record.input.key, expectedRevision: record.input.head.revision, writerId: this.writerId, value: structuredClone(canonicalConversationDraft(record.input.value)) } } };
  }
  private settledValue(current: ConversationDraftValue, target: ConversationDraftResolveTarget, editSeq: string, disposition: ConversationDraftDisposition = "recorded"): ConversationDraftValue {
    if (target.kind === "revocation") return { ...current, editSeq,
      revocations: current.revocations?.filter(slot => !same(slot, target.revocation)) };
    const pending = target.pending;
    const cleared = pending.kind === "append" && (current.messageEditSeq ?? current.editSeq) === pending.submittedSeq;
    let edits = current.proposalEdits;
    if (pending.kind === "proposal-revision") edits = edits?.flatMap(edit => {
      if (edit.proposalId !== pending.request.proposalId || edit.expectedRevisionId !== pending.request.expectedRevisionId) return [edit];
      return edit.editSeq === pending.submittedSeq && same(edit.content, pending.request.content) ? [] : [{ ...edit, editSeq, expectedRevisionId: pending.request.revisionId }];
    });
    let teamDrafts = current.teamDrafts;
    if (disposition === "recorded" && pending.kind === "team-question-response") teamDrafts = teamDrafts?.map(draft => draft.planId !== pending.request.planId ? draft : { ...draft,
      questions: draft.questions?.filter(value => value.questionPostId !== pending.request.response.questionPostId || value.editSeq !== pending.submittedSeq) });
    if (disposition === "recorded" && isConversationTeamPending(pending)) {
      const kind = pending.kind === "team-message" ? "guidance" : "publication";
      teamDrafts = teamDrafts?.map(draft => {
        const part = draft[kind];
        return draft.planId === pending.request.lease.planId && part?.editSeq === pending.submittedSeq
          ? { ...draft, [kind]: { ...part, body: "", editSeq } } : draft;
      });
    }
    return { ...current, editSeq, text: cleared ? "" : current.text,
      messageEditSeq: cleared ? editSeq : current.messageEditSeq ?? current.editSeq,
      pending: same(current.pending, pending) ? null : current.pending, proposalEdits: edits?.length ? edits : undefined, teamDrafts };
  }
  private async executeJob(record: RecordState, job: JournalJob): Promise<boolean> {
    this.update(record, { journalBusy: true });
    try {
      const head = job.kind === "write" ? await this.ports.write(job.request) : await this.ports.resolve(job.request);
      if (head.value === null) throw new Error("A journal write returned no input head");
      const submitted = job.kind === "write" ? job.request.write.value : job.request.resolve.write.value;
      let value = record.input.value;
      const patch: Partial<ConversationInput> = {};
      if (job.kind === "resolve") {
        const { target, disposition } = job.request.resolve;
        value = value.editSeq === submitted.editSeq ? head.value : this.settledValue(value, target, value.editSeq, disposition);
        patch.notice = disposition === "fenced-not-applied" ? target.kind === "pending" && target.pending.kind === "team-question-response" ? "teamQuestionClosed" : "runNotApplied" : target.kind === "pending" ? this.recordedNotice(target.pending)
          : ({ pause: "runPaused", stop: "runStopped", "take-over": "runTakenOver" } as const)[target.revocation.request.command];
        if (target.kind === "pending") { patch.outcome = disposition === "recorded" ? "recorded" : null; patch.failure = null; }
        else { const states = new Map(record.input.revocationStates); states.delete(target.revocation.request.actionId); patch.revocationStates = states; }
      }
      record.job = null;
      this.update(record, { head, value, dirty: !same(head.value, canonicalConversationDraft(value)), journalBusy: false,
        failure: record.input.failure?.kind === "journal" ? null : record.input.failure, ...patch }, true);
      return true;
    } catch (error) {
      // The original frame remains available after an uncertain acknowledgement.
      record.job = job.kind === "write" && isCommandError(error) && error.outcome === "rejected" && error.code === "limit-exceeded" ? null : job;
      this.update(record, { journalBusy: false, failure: { kind: "journal", cause: commandFailure(error) } }); return false;
    }
  }
  private queueJournal(record: RecordState, operation: () => Promise<boolean>) {
    const flight = this.kernel.enqueue(record.input.key.conversationId, operation)
      .finally(() => { if (record.writing === flight) record.writing = null; });
    record.writing = flight; return flight;
  }
  private async flushRecord(record: RecordState) {
    if (!this.kernel.live || record.job || record.input.failure?.kind === "journal") return false;
    while (this.kernel.live && record.input.dirty) if (!await this.executeJob(record, this.writeJob(record))) return false;
    return !record.input.dirty;
  }
  private async persist(record: RecordState): Promise<boolean> {
    // A new pending request can arrive after the active flush's last dirty
    // check. Its completed flight does not prove that newer input is saved.
    while (record.writing) if (!await record.writing) return false;
    return this.queueJournal(record, () => this.flushRecord(record));
  }
  async retryJournal(conversationId: string) {
    const record = this.records.get(conversationId);
    if (!record || !this.kernel.live || record.writing || record.input.journalBusy) return;
    const job = record.job;
    if (!job) { this.update(record, { failure: null }, true); await this.persist(record); return; }
    const success = await this.queueJournal(record, () => this.executeJob(record, job));
    if (success && record.input.dirty) await this.persist(record);
  }
  private resolveTarget(record: RecordState, target: ConversationDraftResolveTarget, disposition: ConversationDraftDisposition) {
    return this.queueJournal(record, async () => {
      if (!await this.flushRecord(record)) return false;
      const current = record.input.value;
      if (target.kind === "pending" ? !same(current.pending, target.pending)
        : !(current.revocations ?? []).some(slot => same(slot, target.revocation))) return false;
      const editSeq = nextEditSeq(current.editSeq), value = canonicalConversationDraft(this.settledValue(current, target, editSeq, disposition));
      // Keep the unresolved slot in memory until this exact local clear is acknowledged.
      this.changed++; this.update(record, { value: { ...current, editSeq }, dirty: true });
      const job: JournalJob = { kind: "resolve", request: { sessionToken: this.context.sessionToken,
        resolve: { write: { key: record.input.key, expectedRevision: record.input.head.revision, writerId: this.writerId, value }, target, disposition } } };
      if (!await this.executeJob(record, job)) return false;
      return await this.flushRecord(record);
    });
  }
  private resolve(record: RecordState, pending: ConversationDraftPending, disposition: ConversationDraftDisposition = "recorded") {
    return this.resolveTarget(record, { kind: "pending", pending }, disposition);
  }
  private async performLocal(record: RecordState) {
    record.submitting = record.input.value.pending; this.publish();
    if (!await this.persist(record) || !this.kernel.live) return;
    const pending = record.input.value.pending; if (!pending || !locallyReplayableConversationRequest(pending)) return;
    this.update(record, { busy: "submit", failure: null });
    if (pending.kind === "create") await this.ports.create({ sessionToken: this.context.sessionToken, ...pending.request });
    else if (pending.kind === "append") await this.ports.append({ sessionToken: this.context.sessionToken, ...pending.request });
    else if (pending.kind === "proposal-capture") await this.ports.captureProposal({ sessionToken: this.context.sessionToken, ...pending.request });
    else if (pending.kind === "proposal-revision") await this.ports.reviseProposal({ sessionToken: this.context.sessionToken, ...pending.request });
    if (!this.kernel.live) return;
    this.recordCaptureAcknowledgement(record, pending);
    this.onRecorded(); this.update(record, { busy: null, outcome: "recorded" });
    await this.resolve(record, pending);
  }
  private async submit(record: RecordState) {
    if (!this.kernel.live || record.action || !locallyReplayableConversationRequest(record.input.value.pending)) return;
    record.action = true;
    try {
      await this.performLocal(record);
    } catch (error) { record.submitting = null; this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
    } finally { record.action = false; record.submitting = null; if (this.kernel.live) { this.publish(); if (record.input.dirty && !record.input.failure && !record.job) void this.persist(record); } }
  }
  async check(conversationId: string) {
    const record = this.records.get(conversationId), pending = record?.input.value.pending;
    if (!record || !pending || !this.kernel.live || record.action || record.input.busy || record.job) return;
    record.action = true; this.update(record, { busy: "check", failure: null });
    try {
      if (pending.kind === "team-recovery") {
        const recovery = await this.recoverTeamRecovery(pending);
        if (!this.kernel.live) return;
        if (recovery.outcome.kind === "recorded") {
          this.retainRecoveryReceipt(record, pending, recovery.outcome.receipt); this.onRecorded();
          this.update(record, { outcome: "recorded" }); await this.resolve(record, pending);
        } else if (recovery.outcome.kind === "fenced-not-applied") {
          this.update(record, { outcome: "blocked" }); await this.resolve(record, pending, "fenced-not-applied");
        } else this.update(record, { outcome: "blocked" });
        return;
      }
      const recovery = await this.recover(pending);
      if (!this.kernel.live) return;
      const outcome = recovery.outcome;
      this.update(record, { busy: null, outcome: outcome.kind === "recorded" ? "recorded" : outcome.kind === "mismatch" ? "mismatch"
        : outcome.kind === "pending" && outcome.replay === "explicit-same-request" ? "absent" : "blocked" });
      if (outcome.kind === "recorded") {
        this.recordCaptureAcknowledgement(record, pending); this.onRecorded(); await this.resolve(record, pending);
      }
      else if (outcome.kind === "fenced-not-applied") { if (isRunPending(pending)) this.forgetReadyRun(record, pending.request.planId); await this.resolve(record, pending, "fenced-not-applied"); }
    } catch (error) { this.update(record, { busy: null, outcome: "unknown", failure: { kind: "action", cause: commandFailure(error) } });
    } finally { record.action = false; if (this.kernel.live) this.update(record, { busy: null }); }
  }
  async retry(conversationId: string, current: () => boolean = () => true) {
    const record = this.records.get(conversationId);
    if (record?.input.value.pending?.kind === "team-question-response") { await this.retryQuestionResponse(record, record.input.value.pending, current); return; }
    if (record && isConversationTeamPending(record.input.value.pending)) { await this.retryTeam(record, record.input.value.pending, current); return; }
    if (record && isRunPending(record.input.value.pending)) { await this.retryRun(record, record.input.value.pending, current); return; }
    if (record?.input.outcome === "absent" && !record.job && locallyReplayableConversationRequest(record.input.value.pending)) await this.submit(record);
  }
  private recordCaptureAcknowledgement(record: RecordState, pending: ConversationDraftPending) {
    if (pending.kind === "proposal-capture" && !record.input.capturedResultIds.includes(pending.request.resultId)) this.update(record, { capturedResultIds: [...record.input.capturedResultIds, pending.request.resultId] });
    if (pending.kind === "proposal-work-plan") this.update(record, { workPlan: { ...record.input.workPlan, prepared: null, consent: false, executionConsent: emptyExecutionConsent() } });
    if (isRunPending(pending)) {
      this.forgetReadyRun(record, pending.request.planId);
      if (pending.kind === "work-plan-start") {
        const recovery = this.recoveryState(record, pending.request.planId);
        if (recovery.receipt?.actionId === pending.request.actionId) this.updateRecovery(record, pending.request.planId, { receipt: null, consent: false });
      }
    }
  }
  private recordedNotice(pending: ConversationDraftPending): NonNullable<ConversationInput["notice"]> {
    switch (pending.kind) {
      case "create": return "threadCreated";
      case "append": return "messageSaved";
      case "planning": return "planningRecorded";
      case "proposal-capture": case "proposal-revision": return "proposalRecorded";
      case "proposal-work-plan": return "workPlanRecorded";
      case "work-plan-start": return "runStarted";
      case "work-plan-control": {
        const notices: Record<WorkPlanCommand, NonNullable<ConversationInput["notice"]>> = { pause: "runPaused", stop: "runStopped", "take-over": "runTakenOver", continue: "runContinued" };
        return notices[pending.request.command];
      }
      case "team-question-response": return "teamQuestionResponded";
      case "team-recovery": return "teamRecoveryRecorded";
      case "team-message": return "teamMessageSaved";
      case "team-publication": return "teamPublicationSaved";
    }
  }
  private recover(pending: Exclude<ConversationDraftPending, { kind: "team-recovery" }>) {
    const sessionToken = this.context.sessionToken;
    switch (pending.kind) {
      case "create": return this.ports.recoverCreate({ sessionToken, ...pending.request });
      case "append": return this.ports.recoverMessage({ sessionToken, ...pending.request });
      case "planning": return this.ports.recoverPlanning({ sessionToken, ...pending.request });
      case "proposal-capture": return this.ports.recoverProposalCapture({ sessionToken, ...pending.request });
      case "proposal-revision": return this.ports.recoverProposalRevision({ sessionToken, ...pending.request });
      case "proposal-work-plan": return this.ports.recoverProposalWorkPlan({ sessionToken, projectId: this.context.projectId, authorization: pending.request });
      case "team-question-response": return this.recoverQuestionResponse(pending);
      case "team-message": case "team-publication": return this.recoverTeam(pending);

      case "work-plan-start": case "work-plan-control": {
        const record = this.records.get(pending.conversationId);
        if (!record) return Promise.reject(new Error("The conversation input is not open"));
        return this.recoverRun(record, pending);
      }
    }
  }
  async flush(): Promise<boolean> {
    const records = [...this.records.values()];
    if (records.some(record => record.action || record.revoking.size > 0 || record.job || record.input.failure?.kind === "journal")) return false;
    return (await Promise.all(records.map(record => this.persist(record)))).every(Boolean);
  }
  lifecycleParticipant(): LifecycleParticipant {
    return { id: "conversation-input", area: "tasks", scope: { kind: "project", ...this.context },
      inspect: intent => {
        if (["navigate", "language", "close-view", "restore"].includes(intent.kind)) return { status: "ready", revision: "retained-conversation-input" };
        const records = [...this.records.values()];
        return { status: records.some(record => record.action || record.revoking.size > 0) ? "blocked" : records.some(record => record.input.dirty || record.job) ? "dirty" : "ready",
          revision: JSON.stringify([this.changed, records.map(record => [record.input.key.conversationId, record.input.head.revision, record.input.dirty, record.action, [...record.revoking]])]) };
      },
      prepareLeave: async (_intent, proof, current) => {
        const changed = this.changed;
        return proof() && current() && await this.flush() && current() && changed === this.changed;
      }, reveal: this.onReveal };
  }
  retire() { if (this.kernel.live) { this.kernel.retire(); this.publish({ retired: true }); } }
}
