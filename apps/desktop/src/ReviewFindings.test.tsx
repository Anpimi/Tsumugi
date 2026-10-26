import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import type { EditorTarget } from "./TranslationWorkbench";
import { ReviewWorkbench, type ReviewHandle } from "./ReviewWorkbench";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import type { ProjectView } from "./projectCommands";
import type { ReviewFindingDecision, ReviewFindingView, ReviewFindingWrite, ReviewTarget } from "./reviewCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { pluginRuleKeyFixture } from "./testSupport/textReviewFixture";
import { reviewCheckFixture, reviewSummaryFor, reviewSummaryPageFixture, reviewTargetFixture } from "./testSupport/reviewFixture";
import wire from "../test/fixtures/reviewCommands.contract.json";
import { validateResponseCheck } from "./generated/review.validators";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "finding-session", locator: "/synthetic/project", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(970), displayName: "Synthetic findings", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let review!: ReturnType<typeof useReviewDraftSession>;
let manual!: ReturnType<typeof useTranslationDraftSession>;
function Owners() {
  const r = useReviewDraftSession(), m = useTranslationDraftSession();
  useLayoutEffect(() => { review = r; manual = m; });
  return null;
}
let target: ReviewTarget;
let history: ReviewFindingDecision[];
let nextId: number;
let write: (request: ReviewFindingWrite) => Promise<ReviewFindingDecision>;
let readAction: (actionId: string) => Promise<ReviewFindingDecision | null>;
let viewOverride: ReviewFindingView | null;
let issue: string;
function finding(identity = issue) { return { issueId: identity, rule: "plugin:synthetic.advisory", code: "editorial", detail: "Synthetic advisory detail", severity: "warning", waivable: false }; }
function requirement() { return { key: pluginRuleKeyFixture("synthetic.advisory"), inputDigest: "b".repeat(64), scopeDigest: "c".repeat(64), targets: [target.unitId], mandatory: false, waivable: false, notApplicable: null }; }
function receipt(request: ReviewFindingWrite): ReviewFindingDecision {
  return { decisionId: fixtureIdentity(++nextId), request: structuredClone({ ...request, expectedDecisionId: request.expectedDecisionId ?? null }), purpose: "qa", aiOrigin: null, finding: finding(request.issueId), requirement: requirement(), basisEvidence: structuredClone(target.basisEvidence), createdAt: "2026-10-16T00:00:00Z" };
}
function view(offset = 0): ReviewFindingView {
  const matching = history.find(value => value.request.expectedBasis === target.basis && value.request.issueId === issue) ?? null;
  return { unitId: target.unitId, locale: target.locale, basis: target.basis, runId: target.currentCheck?.runId ?? null, semanticRunId: null,
    findings: offset === 0 ? [{ runId: target.currentCheck!.runId, purpose: "qa", aiOrigin: null, finding: finding(), requirement: requirement(), decision: matching }] : [], repairs: [], history: history.slice(offset,offset+20),
    nextOffset: history.length>offset+20 ? offset+20 : null };
}
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function open(onOpenTranslation: (target: EditorTarget, locale: string) => boolean | Promise<boolean> = () => true) {
  const ref = createRef<ReviewHandle>();
  const ui = render(<><ReviewWorkbench ref={ref} project={project} disabled={false} onOpenTranslation={onOpenTranslation} /><Owners /></>,project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button",{name:"Review and QA"}));
  await user.click(await screen.findByRole("button",{name:"first"}));
  await within(screen.getByRole("region",{name:"Advisory findings"})).findByText((_, element) =>
    element?.tagName === "P" && element.textContent === "synthetic.advisory: Synthetic advisory detail");
  await user.type(screen.getByRole("textbox",{name:"Reviewer name"}),"Reviewer A");
  await user.type(screen.getByRole("textbox",{name:"Reason or evidence"}),"Reason A");
  return { user, ref, ui, panel: () => within(screen.getByRole("region",{name:"Advisory findings"})) };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  nextId=980; history=[]; viewOverride=null; issue="a".repeat(64);
  target=reviewTargetFixture({basis:"d".repeat(64)});
  target.currentCheck=reviewCheckFixture(target,fixtureIdentity(975),"completed",{runId:fixtureIdentity(976),rules:[{rule:"plugin:synthetic.advisory",key:requirement().key,mandatory:false,status:"findings",reason:null,findings:[finding()]}]});
  write=async request => { const saved=receipt(request); history.unshift(saved); return saved; };
  readAction=async actionId => history.find(value=>value.request.actionId===actionId)??null;
  invoke.mockReset();
  invoke.mockImplementation(async (command:string,args:{request:Record<string,unknown>}) => {
    if(command==="create_execution_identity") return fixtureIdentity(++nextId);
    if(command==="read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(target)]);
    if(command==="read_review_target") return structuredClone(target);
    if(command==="read_review_history") return {decisions:[],checks:[],waivers:[],fallbacks:[],nextOffset:null};
    if(command==="read_review_findings") return structuredClone(viewOverride??view(Number(args.request.offset)));
    if(command==="read_plugin_text_reviews") return {settingsRevision:"1",entries:[]};
    if(command==="write_review_finding") return write(args.request.finding as ReviewFindingWrite);
    if(command==="read_review_finding_action") return readAction(String(args.request.actionId));
    throw new Error(command);
  });
});
afterEach(cleanup);

it.each([
  { locale:"en-US", title:"Advisory findings", legacyStatus:"Findings", reject:"Reject as false positive" },
  { locale:"zh-CN", title:"参考建议问题", legacyStatus:"发现问题", reject:"标记为误报" },
])("keeps the advisory panel and existing findings status distinct in $locale",async({locale,title,legacyStatus,reject})=>{
  await i18n.changeLanguage(locale);
  const user=userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={()=>true} />,project);
  await user.click(screen.getByRole("button",{name:i18n.t("review.title")}));
  await user.click(await screen.findByRole("button",{name:"first"}));
  const panel=within(await screen.findByRole("region",{name:title}));
  await panel.findByText("Synthetic advisory detail",{exact:false});
  expect(panel.getByRole("button",{name:reject})).toBeDisabled();
  expect(i18n.t("review.findings")).toBe(legacyStatus);
  expect(invoke.mock.calls.some(([command])=>command==="write_review_finding")).toBe(false);
});

it("rejects and explicitly restores exact advisory evidence while retaining its original history",async()=>{
  const {user,panel}=await open();
  await user.click(panel().getByRole("button",{name:"Reject as false positive"}));
  const restore=await panel().findByRole("button",{name:"Restore finding"});
  expect(panel().getAllByText("Synthetic advisory detail").length).toBeGreaterThan(0);
  expect(history[0].request).toMatchObject({runId:target.currentCheck!.runId,issueId:issue,actor:"Reviewer A",reason:"Reason A",disposition:"rejected",expectedDecisionId:null});
  expect(restore).toBeDisabled();
  await user.type(screen.getByRole("textbox",{name:"Reason or evidence"}),"Restore reason");
  await user.click(restore);
  await waitFor(()=>expect(history).toHaveLength(2));
  expect(history[0].request).toMatchObject({disposition:"restored",reason:"Restore reason",expectedDecisionId:history[1].decisionId});
  expect(history[1].request.disposition).toBe("rejected");
});

it("uses the AI finding's independent run while retaining mechanical QA and model provenance",async()=>{
  const aiRun = fixtureIdentity(2450), aiIssue = "f".repeat(64);
  const key = { rule: { id: "meaning", schemaVersion: 1, behaviorVersion: 1 },
    implementation: { kind: "core" as const, validator: { id: "tsumugi.ai-semantic-review", schemaVersion: 1, behaviorVersion: 1 } } };
  const aiRequirement = { ...requirement(), key };
  const aiOrigin = { endpoint: "https://model.example/v1/chat/completions", model: "synthetic-review", recipe: "semantic-review-1",
    attemptId: fixtureIdentity(2451), itemId: fixtureIdentity(2452), inputDigest: "1".repeat(64), resultId: fixtureIdentity(2453),
    resultDigest: "2".repeat(64), semanticInputDigest: aiRequirement.inputDigest, scopeDigest: aiRequirement.scopeDigest };
  const aiFinding = { ...finding(aiIssue), rule: "meaning", detail: "Synthetic model meaning advice" };
  viewOverride = { ...view(), semanticRunId: aiRun,
    findings: [...view().findings, { runId: aiRun, purpose: "ai-semantic", aiOrigin, finding: aiFinding, requirement: aiRequirement, decision: null }] };
  write = async request => {
    const saved: ReviewFindingDecision = { ...receipt(request), purpose: "ai-semantic", aiOrigin, finding: aiFinding, requirement: aiRequirement };
    history.unshift(saved); return saved;
  };
  const { user, panel } = await open();
  const article = panel().getByText("Synthetic model meaning advice", { exact: false }).closest("article");
  if (!article) throw new Error("AI finding article required");
  expect(within(article).getByText("AI suggestion from synthetic-review at https://model.example/v1/chat/completions · recipe semantic-review-1")).toBeVisible();
  await user.click(within(article).getByRole("button", { name: "Reject as false positive" }));
  await waitFor(() => expect(history).toHaveLength(1));
  expect(history[0].request.runId).toBe(aiRun); expect(history[0].request.runId).not.toBe(target.currentCheck!.runId);
  expect(history[0].purpose).toBe("ai-semantic"); expect(target.currentCheck!.runId).toBe(fixtureIdentity(976));
});

it("recovers the original action receipt while preserving newer reason B and independent manual B",async()=>{
  let saved!:ReviewFindingDecision;
  let reads=0;
  write=async request=>{saved=receipt(request);history.unshift(saved);throw new Error("Lost ACK");};
  readAction=async()=>{if(++reads===1)throw new Error("Automatic receipt read unavailable");return saved;};
  const {user,ref,panel}=await open();
  act(()=>{manual.begin({unitId:fixtureIdentity(995),locale:"zh-CN",sourceRevisionId:fixtureIdentity(996),key:"manual",sourceText:"Other entry"},null,null,"Manual B");});
  await user.click(panel().getByRole("button",{name:"Reject as false positive"}));
  await screen.findByRole("region",{name:"Original finding action awaiting confirmation"});
  await user.clear(screen.getByRole("textbox",{name:"Reason or evidence"}));
  await user.type(screen.getByRole("textbox",{name:"Reason or evidence"}),"Reason B");
  await act(async()=>{expect(await ref.current!.allowNavigate()).toBe(false);expect(await ref.current!.allowLeave()).toBe(false);});
  expect(screen.queryByRole("button",{name:"Retry the same action"})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Check saved result"}));
  await waitFor(()=>expect(review.current().pending).toBeNull());
  expect(screen.getByRole("textbox",{name:"Reason or evidence"})).toHaveValue("Reason B");
  expect(manual.current()?.text).toBe("Manual B");
  expect(invoke.mock.calls.filter(([name])=>name==="write_review_finding")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name])=>name==="read_review_finding_action")).toHaveLength(2);
  expect(invoke.mock.calls.find(([name])=>name==="read_review_finding_action")?.[1].request.actionId).toBe(saved.request.actionId);
});

it("retries the same captured action only after the receipt read found no record",async()=>{
  let calls=0;
  write=async request=>{if(++calls===1)throw new Error("Lost transport");const saved=receipt(request);history.unshift(saved);return saved;};
  const {user,panel}=await open();
  await user.click(panel().getByRole("button",{name:"Reject as false positive"}));
  await screen.findByRole("region",{name:"Original finding action awaiting confirmation"});
  await user.type(screen.getByRole("textbox",{name:"Reason or evidence"})," plus B");
  await user.click(screen.getByRole("button",{name:"Retry the same action"}));
  await waitFor(()=>expect(review.current().pending).toBeNull());
  const writes=invoke.mock.calls.filter(([name])=>name==="write_review_finding");
  expect(writes).toHaveLength(2);expect(writes[1][1]).toEqual(writes[0][1]);
  expect(invoke.mock.calls.filter(([name])=>name==="read_review_finding_action")).toHaveLength(1);
  expect(screen.getByRole("textbox",{name:"Reason or evidence"})).toHaveValue("Reason A plus B");
});

it("treats a structurally valid mismatched ACK as unknown and retains the original request",async()=>{
  let original!:ReviewFindingDecision;
  let reads=0;
  write=async request=>{original=receipt(request);history.unshift(original);return {...original,request:{...original.request,reason:"Unrelated acknowledgement"}};};
  readAction=async()=>++reads===1?{...original,request:{...original.request,reason:"Unrelated acknowledgement"}}:original;
  const {user,panel}=await open();
  await user.click(panel().getByRole("button",{name:"Reject as false positive"}));
  await screen.findByRole("region",{name:"Original finding action awaiting confirmation"});
  const originalPending=review.current().pending;
  expect(originalPending?.kind).toBe("finding");
  if(originalPending?.kind!=="finding")throw new Error("Original finding request required");
  expect(originalPending.request.reason).toBe("Reason A");
  expect(review.current().pendingUncertain).toBe(true);
  expect(screen.queryByRole("button",{name:"Retry the same action"})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Check saved result"}));
  await waitFor(()=>expect(review.current().pending).toBeNull());
  expect(history).toHaveLength(1);
});

it("does not dispatch after the checked finding view changes during identity allocation",async()=>{
  const identity=pending<string>();
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((name,args)=>name==="create_execution_identity"?identity.promise:original(name,args));
  const {user,panel}=await open();
  await user.click(panel().getByRole("button",{name:"Reject as false positive"}));
  target={...target,currentCheck:{...target.currentCheck!,runId:fixtureIdentity(999)}};
  await refreshWorkbenchReads(["review"]);
  await act(async()=>identity.resolve(fixtureIdentity(998)));
  await waitFor(()=>expect(review.inFlight()).toBe(false));
  expect(invoke.mock.calls.filter(([name])=>name==="write_review_finding")).toHaveLength(0);
  expect(screen.getByRole("textbox",{name:"Reason or evidence"})).toHaveValue("Reason A");
});

it("records a repair request before using the existing protected manual editor",async()=>{
  const openEditor=vi.fn((destination:EditorTarget,locale:string)=>manual.begin({...destination,locale},null,null));
  const {user,panel}=await open(openEditor);
  act(()=>{manual.begin({unitId:fixtureIdentity(995),locale:"zh-CN",sourceRevisionId:fixtureIdentity(996),key:"manual",sourceText:"Other entry"},null,null,"Manual B");});
  await user.click(panel().getByRole("button",{name:"Record repair request and open editor"}));
  await waitFor(()=>expect(openEditor).toHaveBeenCalledTimes(1));
  expect(history[0].request.disposition).toBe("repair-requested");
  expect(manual.current()?.text).toBe("Manual B");
  expect(screen.getByText("The translation editor is unavailable. Your review remains open.")).toBeVisible();
  expect(invoke.mock.calls.filter(([name])=>name==="save_translation_revision")).toHaveLength(0);
});

it("keeps newer reason edits in place when a repair ACK arrives and does not navigate automatically",async()=>{
  const ack=pending<ReviewFindingDecision>();let request!:ReviewFindingWrite;
  write=async value=>{request=value;return ack.promise;};
  const openEditor=vi.fn(()=>true);
  const {user,panel}=await open(openEditor);
  await user.click(panel().getByRole("button",{name:"Record repair request and open editor"}));
  await waitFor(()=>expect(request).toBeDefined());
  await user.type(screen.getByRole("textbox",{name:"Reason or evidence"})," plus B");
  const saved=receipt(request);history.unshift(saved);
  await act(async()=>ack.resolve(saved));
  await waitFor(()=>expect(review.current().pending).toBeNull());
  expect(screen.getByRole("textbox",{name:"Reason or evidence"})).toHaveValue("Reason A plus B");
  expect(openEditor).not.toHaveBeenCalled();
});

it("reaches older repair requests using bounded history pages and leaves failed reads unwritable",async()=>{
  let previous: ReviewFindingDecision | null = null;
  for(let index=0;index<21;index++) {
    const saved=receipt({projectId:project.metadata.projectId,actionId:fixtureIdentity(1000+index),unitId:target.unitId,locale:target.locale,
      expectedBasis:target.basis,runId:fixtureIdentity(1100+index),issueId:issue,expectedDecisionId:previous?.decisionId??null,
      disposition:index===0?"repair-requested":index%2===1?"rejected":"restored",actor:"Earlier reviewer",reason:`Earlier repair ${index}`});
    history.unshift(saved);previous=saved;
  }
  const {user,panel}=await open();
  const historyHeading=panel().getByText("Advisory finding decision history");
  const historyElement=historyHeading.closest("details");
  if(!historyElement)throw new Error("Finding history section required");
  const historyPanel=within(historyElement);
  await user.click(historyHeading);
  expect(historyPanel.getByText("Earlier repair 20")).toBeVisible();
  expect(historyPanel.queryByText("Earlier repair 0")).toBeNull();
  await user.click(panel().getByRole("button",{name:"More finding history"}));
  expect(await historyPanel.findByText("Earlier repair 0")).toBeVisible();
  const requests=invoke.mock.calls.filter(([name])=>name==="read_review_findings").map(([,args])=>args.request);
  expect(requests.some(request=>request.offset===20&&request.limit===20)).toBe(true);
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((name,args)=>name==="read_review_findings"?Promise.reject(new Error("Unavailable")):original(name,args));
  await user.click(panel().getByRole("button",{name:"Refresh advisory findings"}));
  expect(await panel().findByRole("alert")).toHaveTextContent("Advisory finding history is unavailable");
  expect(panel().queryByRole("button",{name:"Reject as false positive"})).toBeNull();
  expect(screen.getByRole("textbox",{name:"Reason or evidence"})).toHaveValue("Reason A");
});


it("renders R2 diagnostics from its exact run while R1 and reason B remain captured",async()=>{
  function checked(runId:string,detail:string,suggestion:string,end:number) {
    const raw:unknown=structuredClone(wire.responses.check);
    if(!validateResponseCheck(raw)||!raw.evidence)throw new Error("Full QA fixture required");
    const required=requirement();
    return reviewCheckFixture(target,fixtureIdentity(975),"completed",{runId,rules:[{rule:"plugin:synthetic.advisory",key:required.key,mandatory:false,status:"findings",reason:null,findings:[finding()]}],
      evidence:{...raw.evidence,requiredChecks:{...raw.evidence.requiredChecks,requirements:[required]},
        diagnostics:[{key:required.key,code:"editorial",target:target.unitId,detail,suggestion,resourceEntry:null,
          location:{field:"translation",range:{encoding:"utf16",start:0,end}}}]}});
  }
  target.currentCheck=checked(fixtureIdentity(976),"R1 diagnostic","R1 suggestion",1);
  const {user,panel}=await open();
  expect(panel().getByText("R1 diagnostic")).toBeVisible();
  await user.clear(screen.getByRole("textbox",{name:"Reason or evidence"}));
  await user.type(screen.getByRole("textbox",{name:"Reason or evidence"}),"Reason B");
  issue="e".repeat(64);
  target={...target,currentCheck:checked(fixtureIdentity(977),"R2 diagnostic","R2 suggestion",2)};
  await refreshWorkbenchReads(["review"]);
  expect(await panel().findByText("R2 diagnostic")).toBeVisible();
  expect(panel().queryByText("R1 diagnostic")).toBeNull();
  expect(panel().getByText("Suggested wording: R2 suggestion")).toBeVisible();
  expect(panel().queryByText("Suggested wording: R1 suggestion")).toBeNull();
  expect(review.current().selected?.currentCheck?.runId).toBe(fixtureIdentity(976));
  expect(screen.getByRole("textbox",{name:"Reason or evidence"})).toHaveValue("Reason B");
  await user.click(panel().getByRole("button",{name:"Reject as false positive"}));
  await waitFor(()=>expect(history).toHaveLength(1));
  expect(history[0].request.runId).toBe(fixtureIdentity(977));
  expect(history[0].request.issueId).toBe(issue);
});


it("keeps the original pending action when its recovery read fails instead of replaying it blindly",async()=>{
  write=async()=>{throw new Error("Unconfirmed write");};
  readAction=async()=>{throw new Error("Receipt read unavailable");};
  const {user,panel}=await open();
  await user.click(panel().getByRole("button",{name:"Reject as false positive"}));
  await screen.findByRole("region",{name:"Original finding action awaiting confirmation"});
  const original=review.current().pending;
  await user.type(screen.getByRole("textbox",{name:"Reason or evidence"})," plus B");
  expect(screen.queryByRole("button",{name:"Retry the same action"})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Check saved result"}));
  await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name==="read_review_finding_action")).toHaveLength(2));
  expect(review.current().pending).toBe(original);
  expect(invoke.mock.calls.filter(([name])=>name==="write_review_finding")).toHaveLength(1);
  expect(screen.getByRole("textbox",{name:"Reason or evidence"})).toHaveValue("Reason A plus B");
});
