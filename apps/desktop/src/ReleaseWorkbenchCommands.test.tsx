import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/releaseCommands.contract.json";
import reviewFixture from "../test/fixtures/reviewCommands.contract.json";
import type { EditorTarget } from "./TranslationWorkbench";
import { ReleaseWorkbench } from "./ReleaseWorkbench";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type ReleasePreparationCommandPayload, type ReleaseBuildPendingCommandPayload,
  type ReleaseRecordCommandPayload, type ReleasePreviewCommandPayload, type ReleaseDeliveryPendingCommandPayload, type ReleaseDeliveryCommandPayload, type ReleaseBlockerCommandPayload } from "./workbenchCommands";
import type { PluginBuildPrepareRequest, ReleaseView, DeliveryPreview, DeliveryView } from "./releaseCommands";
import type { ProjectView } from "./projectCommands";
import { validateResponseReleases, validateResponsePreview, validateResponseDelivery } from "./generated/release.validators";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { pluginBuildInventory, pluginBuildPackage, pluginBuildView, pluginBuildWorkflow } from "./testSupport/pluginBuildFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const project: ProjectView = { sessionToken:fixture.requests.session.sessionToken,locator:"isolated",reconciliationState:"settled",
  metadata:{projectId:fixture.requests.session.projectId,displayName:"Release commands",sourceLocale:"en",targetLocales:["zh-CN"],metadataRevision:"1"} };
const scope = {projectId:project.metadata.projectId,sessionToken:project.sessionToken,area:"release" as const};
let owner: ReturnType<typeof useReleaseDraftSession>, reads: ReturnType<typeof useSessionReads>, registry: ReturnType<typeof useWorkbenchCommands>;
let release: ReleaseView, destination: DeliveryPreview, delivery: DeliveryView;
function Probe() { const value=useReleaseDraftSession(),queries=useSessionReads(),commands=useWorkbenchCommands();
  useLayoutEffect(()=>{owner=value;reads=queries;registry=commands;});return null; }
function Harness({consumer=true,onOpenTranslation}:{consumer?:boolean;onOpenTranslation?:(target:EditorTarget,locale:string)=>boolean|Promise<boolean>}) { return <><Probe/>{consumer?<ReleaseWorkbench project={project} disabled={false} onOpenTranslation={onOpenTranslation ? async (target,locale)=>await onOpenTranslation(target,locale) : undefined}/>:null}</>; }
function calls(command:string) {return invoke.mock.calls.filter(([name])=>name===command);}
function requests(command:string) {return calls(command).map(([,args])=>args.request);}
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
function preparation(): ReleasePreparationCommandPayload {
  const value=owner.current();if(!value.buildChoice)throw new Error("Expected checked installed builder");
  return {kind:"release-preparation",editSeq:value.editSeq,build:structuredClone(value.buildChoice),choices:structuredClone(owner.choices()),
    sourceLocale:project.metadata.sourceLocale,targetLocales:[...project.metadata.targetLocales],eligibilityBasis:value.eligibility?.basis??null};
}
function environmentKey() { return ["release-plugin-environment",owner.current().buildChoice]; }
function record(): ReleaseRecordCommandPayload {return{kind:"release-record",releaseId:release.releaseId,releaseActionId:release.actionId,attemptId:release.attemptId,manifestSha256:release.manifestSha256};}
function preview(overwrite=owner.current().overwrite): ReleasePreviewCommandPayload {
  const value=owner.current();if(!value.preview||!value.selection)throw new Error("Expected original destination preview");
  return {...record(),kind:"release-preview",selectionId:value.selection.selectionId,previewId:value.preview.previewId,overwrite};
}
function buildPending(): ReleaseBuildPendingCommandPayload {
  const value=owner.current().pending;if(value?.kind!=="build")throw new Error("Expected original build");
  return {kind:"release-build-pending",intent:structuredClone(value.intent),editSeq:value.editSeq};
}
function exportPending(): ReleaseDeliveryPendingCommandPayload {
  const value=owner.current().pending;if(!value||value.kind!=="export")throw new Error("Expected original export");
  return {kind:"release-delivery-pending",pendingKind:"export",actionId:value.request.actionId,releaseId:value.request.releaseId,
    selectionId:value.selection.selectionId,previewId:value.request.previewId,overwriteConflicts:value.request.overwriteConflicts,
    recoverySelectionId:value.recoverySelection?.selectionId??null,delivery:value.receipt?structuredClone(value.receipt):null};
}
beforeEach(async()=>{
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  await i18n.changeLanguage("en-US");invoke.mockReset();
  const releases:unknown=structuredClone(fixture.responses.releases);if(!validateResponseReleases(releases))throw new Error("Invalid immutable releases fixture");release=releases[0];
  const checkedPreview:unknown=structuredClone(fixture.responses.preview);if(!validateResponsePreview(checkedPreview))throw new Error("Invalid preview fixture");destination=checkedPreview;
  const checkedDelivery:unknown=structuredClone(fixture.responses.delivery);if(!validateResponseDelivery(checkedDelivery))throw new Error("Invalid delivery fixture");delivery=checkedDelivery;
  invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
    const request=args?.request;
    if(command==="list_releases")return[release];
    if(command==="read_plugin_inventory")return pluginBuildInventory;
    if(command==="read_plugin_package")return pluginBuildPackage;
    if(command==="read_plugin_build")return pluginBuildView;
    if(command==="read_content_scope")return{currentSnapshot:release.sourceSnapshotId,revision:"1"};
    if(command==="read_review_eligibility"){
      const locales=request.locales;if(!Array.isArray(locales)||!locales.every(value=>typeof value==="string"))throw new Error("Expected explicit locale capture");
      return {policyVersion:release.policyVersion,sourceSnapshotId:release.sourceSnapshotId,basis:release.eligibilityBasis,ready:true,
        locales:locales.map(locale=>({locale,ready:true,blockers:[],exceptions:[],checkedUnits:2,blockerCount:0,exceptionCount:0}))};
    }
    if(command==="create_execution_identity")return fixture.responses.identity;
    if(command==="prepare_plugin_build")return {...pluginBuildWorkflow.review,attemptId:request.attemptId,choices:request.choices,eligibilityBasis:request.expectedEligibilityBasis,sourceSnapshotId:release.sourceSnapshotId};
    if(command==="choose_delivery_folder")return fixture.responses.selection;
    if(command==="preview_delivery")return destination;
    if(command==="list_deliveries")return[];
    if(command==="export_release"||command==="read_delivery_action"||command==="reconcile_delivery")return{...delivery,actionId:request.actionId};
    throw new Error(command);
  });
});
afterEach(()=>{
  cleanup();
  if(originalScrollIntoView)Object.defineProperty(HTMLElement.prototype,"scrollIntoView",originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype,"scrollIntoView");
});
async function open(onOpenTranslation?:(target:EditorTarget,locale:string)=>boolean|Promise<boolean>) {
  const user=userEvent.setup(),view=render(<Harness onOpenTranslation={onOpenTranslation ? async (target,locale)=>await onOpenTranslation(target,locale) : undefined}/>,project);
  await user.click(screen.getByRole("button",{name:i18n.t("release.title")}));
  await waitFor(()=>expect(reads.client.getQueryState(reads.key(environmentKey()))?.status).toBe("success"));
  await waitFor(()=>expect(reads.client.getQueryState(reads.key(environmentKey()))?.fetchStatus).toBe("idle"));
  return {user,view};
}
async function prepared() {
  const rendered=await open();await rendered.user.click(screen.getByRole("checkbox",{name:"zh-CN"}));
  await rendered.user.type(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})}),"i18n/zh.json");
  await waitFor(()=>expect(registry.describe("release.assess-build",scope,preparation())?.availability.enabled).toBe(true));
  await rendered.user.click(screen.getByRole("button",{name:i18n.t("release.check")}));
  await waitFor(()=>expect(registry.describe("release.prepare-build",scope,preparation())?.availability.enabled).toBe(true));return rendered;
}
async function exportReady() {
  const rendered=await open();await rendered.user.click(await screen.findByRole("button",{name:new RegExp(release.createdAt)}));
  await rendered.user.click(screen.getByRole("button",{name:i18n.t("release.chooseFolder")}));
  await rendered.user.click(screen.getByRole("button",{name:i18n.t("release.preview")}));
  await waitFor(()=>expect(owner.current().preview).toEqual(destination));return rendered;
}

it("registers thirty-one scoped Release commands and routes readiness and build through the same buttons and captured mapping",async()=>{
  const {user}=await prepared(),dispatch=vi.spyOn(registry,"dispatch"),payload=preparation();
  expect(registry.list(scope).filter(value=>value.category==="release").map(value=>value.id).sort()).toEqual([
    "release.assess-build","release.cancel-task","release.cancel-workflow-task","release.check-build","release.check-check-workflow","release.check-export","release.choose-destination","release.choose-release","release.close-check-workflow",
    "release.confirm-builder","release.confirm-checker","release.confirm-overwrite","release.confirm-workflow-checker","release.discard-build","release.export","release.finish-artifact-check",
    "release.open-blocker","release.prepare-artifact-check","release.prepare-build","release.prepare-check-workflow","release.preview-destination","release.reauthorize-destination",
    "release.reconcile-delivery","release.record-build","release.retry-build","release.retry-cancellation","release.retry-workflow-cancellation","release.run-check-workflow","release.start-artifact-check","release.start-build","release.stop-check-workflow",
  ]);

  await user.click(screen.getByRole("button",{name:i18n.t("releasePlugin.capture")}));
  await waitFor(()=>expect(calls("prepare_plugin_build")).toHaveLength(1));
  expect(dispatch).toHaveBeenCalledWith("release.prepare-build",scope,payload);
  expect(requests("prepare_plugin_build")[0]).toMatchObject({choices:[{locale:"zh-CN",outputPaths:["i18n/zh.json"],configuration:[]}],expectedEligibilityBasis:release.eligibilityBasis});
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it("rejects wrong preparation, hidden and failed fresh Query scopes before allocating a build identity",async()=>{
  const {view}=await prepared(),payload=preparation();
  expect(registry.dispatch("release.prepare-build",scope,{...payload,choices:[{...payload.choices[0],outputPaths:["another.json"]}]})).toBe(false);
  expect(registry.dispatch("release.prepare-build",{...scope,sessionToken:"old"},payload)).toBe(false);
  const query=reads.client.getQueryCache().find({queryKey:reads.key(environmentKey()),exact:true})!;
  act(()=>query.setState({status:"error",error:new Error("Current builder read failed")}));
  expect(registry.describe("release.prepare-build",scope,payload)?.availability.enabled).toBe(false);
  await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("releasePlugin.capture")})).toBeDisabled());
  view.rerender(<Harness consumer={false}/>,project);expect(registry.describe("release.prepare-build",scope,payload)).toBeUndefined();
  expect(calls("create_execution_identity")).toHaveLength(0);
});

it.each(["error","contradiction"] as const)("retains a removed replacement builder Query's %s during identity and prevents build dispatch",async change=>{
  const {view}=await prepared(),identity=deferred<string>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  act(()=>{expect(registry.dispatch("release.prepare-build",scope,preparation())).toBe(true);expect(registry.dispatch("release.prepare-build",scope,preparation())).toBe(false);});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));view.rerender(<Harness consumer={false}/>,project);
  const key=reads.key(environmentKey());
  act(()=>{reads.client.removeQueries({queryKey:key,exact:true});reads.client.setQueryData(key,{...pluginBuildView,settingsRevision:change==="contradiction"?"2":pluginBuildView.settingsRevision});
    if(change==="error")reads.client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:"error",error:new Error("Replacement failed")});
    reads.client.removeQueries({queryKey:key,exact:true});});
  await act(async()=>identity.resolve(fixture.responses.identity));await waitFor(()=>expect(owner.current().busy).toBe(false));
  expect(calls("prepare_plugin_build")).toHaveLength(0);expect(owner.current().attempt).toBeNull();
});

it("continues a checked build through pure consumer unmount and Query eviction and disposes its flight witness",async()=>{
  const {view}=await prepared(),identity=deferred<string>(),original=invoke.getMockImplementation()!,dispose=vi.fn(),watch=reads.watchExactQuery.bind(reads);
  vi.spyOn(reads,"watchExactQuery").mockImplementation(key=>{const witness=watch(key);return{current:witness.current,dispose:()=>{dispose();witness.dispose();}};});
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  act(()=>{expect(registry.dispatch("release.prepare-build",scope,preparation())).toBe(true);});await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));
  view.rerender(<Harness consumer={false}/>,project);act(()=>reads.client.removeQueries({queryKey:reads.key(environmentKey()),exact:true}));
  await act(async()=>identity.resolve(fixture.responses.identity));await waitFor(()=>expect(owner.current().prepared?.review.attemptId).toBe(fixture.responses.identity));
  expect(calls("prepare_plugin_build")).toHaveLength(1);expect(dispose).toHaveBeenCalledTimes(1);
});

it.each(["retire","destroy"] as const)("blocks a captured build after session %s and releases its exact Query listener",async mode=>{
  const {view}=await prepared(),identity=deferred<string>(),original=invoke.getMockImplementation()!,dispose=vi.fn(),watch=reads.watchExactQuery.bind(reads);
  vi.spyOn(reads,"watchExactQuery").mockImplementation(key=>{const witness=watch(key);return{current:witness.current,dispose:()=>{dispose();witness.dispose();}};});
  invoke.mockImplementation((command:string,args)=>command==="create_execution_identity"?identity.promise:original(command,args));
  act(()=>{expect(registry.dispatch("release.prepare-build",scope,preparation())).toBe(true);});await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));
  if(mode==="retire")act(()=>reads.retire());else{view.unmount();expect(dispose).toHaveBeenCalledTimes(1);}
  await act(async()=>identity.resolve(fixture.responses.identity));expect(calls("prepare_plugin_build")).toHaveLength(0);expect(dispose).toHaveBeenCalledTimes(1);
});

it("reconciles the original preparation without renewing its identity and retains the first uncertainty after a later rejected replay",async()=>{
  await prepared();const original=invoke.getMockImplementation()!;let sent=0;
  invoke.mockImplementation((command:string,args)=>command==="prepare_plugin_build"?Promise.reject(++sent===1?new Error("ACK lost"):
    {code:"permission-denied",outcome:"rejected",stage:"execution-adopt",recoveryRequired:false}):original(command,args));
  await act(async()=>{registry.dispatch("release.prepare-build",scope,preparation());});await waitFor(()=>expect(owner.current().pending?.kind).toBe("build"));
  const payload=buildPending(),request:PluginBuildPrepareRequest=requests("prepare_plugin_build")[0];
  expect(registry.dispatch("release.retry-build",scope,payload)).toBe(false);
  if(payload.intent.kind!=="prepare-build")throw new Error("Expected fixed preparation intent");
  expect(registry.dispatch("release.check-build",scope,{...payload,intent:{kind:"prepare-build",request:{...payload.intent.request,attemptId:fixtureIdentity(991)}}})).toBe(false);
  act(()=>{owner.setName("zh-CN","newer.json");reads.client.clear();});
  await act(async()=>{expect(registry.dispatch("release.check-build",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.current().busy).toBe(false));expect(owner.current().pending).toMatchObject({uncertain:true,retryAllowed:false});
  expect(registry.describe("release.retry-build",scope,payload)?.availability.enabled).toBe(false);
  expect(requests("prepare_plugin_build")).toEqual([request,request]);expect(owner.current().names["zh-CN"]).toBe("newer.json");expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("start_plugin_build")).toHaveLength(0);
});

it("exports a checked immutable release despite current builder and history errors using only its exact destination consent",async()=>{
  const {user}=await exportReady();
  const key=reads.key(environmentKey());act(()=>reads.client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:"error",error:new Error("Unavailable builder")}));
  act(()=>reads.client.getQueryCache().find({queryKey:reads.key(["release-list"]),exact:true})!.setState({status:"error",error:new Error("History failed")}));
  const payload=preview(true);expect(registry.dispatch("release.confirm-overwrite",scope,{...payload,previewId:fixtureIdentity(999)})).toBe(false);
  await user.click(screen.getByRole("checkbox",{name:i18n.t("release.overwrite")}));
  expect(registry.describe("release.export",scope,payload)?.availability.enabled).toBe(true);
  await user.click(screen.getByRole("button",{name:i18n.t("release.export")}));await waitFor(()=>expect(owner.current().result?.state).toBe(delivery.state));
  expect(requests("export_release")[0]).toMatchObject({releaseId:release.releaseId,selectionId:destination.selectionId,previewId:destination.previewId,overwriteConflicts:true});
  expect(calls("read_review_eligibility")).toHaveLength(0);expect(calls("prepare_plugin_build")).toHaveLength(0);
});

it("revokes the prior overwrite command immediately when a replacement preview is requested and keeps it revoked on failure",async()=>{
  const {user}=await exportReady();await user.click(screen.getByRole("checkbox",{name:i18n.t("release.overwrite")}));
  const payload=preview(),response=deferred<DeliveryPreview>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="preview_delivery"?response.promise:original(command,args));
  await user.click(screen.getByRole("button",{name:i18n.t("release.preview")}));
  expect(owner.current().preview).toBeNull();expect(owner.current().overwrite).toBe(false);expect(registry.dispatch("release.export",scope,payload)).toBe(false);
  await act(async()=>{response.reject(new Error("Preview failed"));await response.promise.catch(()=>{});});
  expect(registry.dispatch("release.confirm-overwrite",scope,payload)).toBe(false);expect(owner.current().overwrite).toBe(false);expect(calls("export_release")).toHaveLength(0);
});

it("recovers an original export through explicit directory reauthorization without recapturing or exporting another release",async()=>{
  await exportReady();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="export_release"?Promise.reject(new Error("Export ACK lost"))
    :command==="read_delivery_action"?Promise.reject(new Error("Original directory lease unavailable")):original(command,args));
  await act(async()=>{registry.dispatch("release.confirm-overwrite",scope,preview(true));registry.dispatch("release.export",scope,preview());});
  await waitFor(()=>expect(owner.current().pending?.kind).toBe("export"));await waitFor(()=>expect(owner.current().busy).toBe(false));
  const pending=exportPending(),request=requests("export_release")[0];
  expect(registry.dispatch("release.check-export",scope,{...pending,actionId:fixtureIdentity(999)})).toBe(false);
  expect(registry.dispatch("release.choose-release",scope,record())).toBe(false);
  invoke.mockImplementation((command:string,args)=>command==="choose_delivery_folder"?Promise.resolve({...fixture.responses.selection,selectionId:fixtureIdentity(998)}):original(command,args));
  await act(async()=>{expect(registry.dispatch("release.reauthorize-destination",scope,pending)).toBe(true);});
  await waitFor(()=>expect(owner.current().busy).toBe(false));const recovered=exportPending();
  expect(registry.dispatch("release.check-export",scope,pending)).toBe(false);
  await act(async()=>{expect(registry.dispatch("release.check-export",scope,recovered)).toBe(true);});
  expect(owner.current().pending).toBeNull();expect(owner.current().result?.actionId).toBe(request.actionId);
  expect(requests("read_delivery_action")).toEqual([
    {...fixture.requests.session,actionId:request.actionId,selectionId:fixture.responses.selection.selectionId},
    {...fixture.requests.session,actionId:request.actionId,selectionId:fixtureIdentity(998)}]);
  expect(calls("export_release")).toHaveLength(1);expect(calls("create_execution_identity")).toHaveLength(1);
});


it("reconciles a checked historical delivery with exact files and action identity without starting another export",async()=>{
  const original=invoke.getMockImplementation()!,saved:DeliveryView={...delivery,state:"unknown",files:delivery.files.map(file=>({...file,state:"unknown",actualSha256:null}))};
  invoke.mockImplementation((command:string,args)=>command==="list_deliveries"?Promise.resolve([saved]):original(command,args));
  await exportReady();const selection=owner.current().selection;if(!selection)throw new Error("Expected original directory selection");
  const payload:ReleaseDeliveryCommandPayload={...record(),kind:"release-delivery",selectionId:selection.selectionId,delivery:structuredClone(saved)};
  await waitFor(()=>expect(registry.describe("release.reconcile-delivery",scope,payload)?.availability.enabled).toBe(true));
  expect(registry.dispatch("release.reconcile-delivery",scope,{...payload,delivery:{...saved,files:saved.files.map(file=>({...file,expectedSha256:"different"}))}})).toBe(false);
  await act(async()=>{expect(registry.dispatch("release.reconcile-delivery",scope,payload)).toBe(true);});
  expect(requests("reconcile_delivery")).toEqual([{...fixture.requests.session,actionId:saved.actionId,selectionId:selection.selectionId}]);
  expect(owner.current().result?.deliveryId).toBe(saved.deliveryId);expect(owner.current().result?.state).toBe(delivery.state);
  expect(calls("export_release")).toHaveLength(0);expect(calls("create_execution_identity")).toHaveLength(0);
});

it.each(["current","wrong-target","hidden"] as const)("routes only the current checked blocker target during %s without a business mutation",async mode=>{
  const unitId=reviewFixture.responses.target.unitId,response=deferred<unknown>(),original=invoke.getMockImplementation()!,navigate=vi.fn().mockResolvedValue(true);
  invoke.mockImplementation(async(command:string,args)=>{
    if(command==="read_review_eligibility")return{policyVersion:release.policyVersion,sourceSnapshotId:release.sourceSnapshotId,basis:release.eligibilityBasis,ready:false,
      locales:[{locale:"zh-CN",ready:false,blockers:[{unitId,nativeKey:"Blocked entry",code:"missing-approval",reference:null}],exceptions:[],checkedUnits:1,blockerCount:1,exceptionCount:0}]};
    if(command==="read_review_target")return response.promise;return original(command,args);
  });
  const {user,view}=await open(navigate);await user.click(screen.getByRole("checkbox",{name:"zh-CN"}));await user.type(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})}),"i18n/zh.json");await user.click(screen.getByRole("button",{name:i18n.t("release.check")}));
  await waitFor(()=>expect(owner.current().eligibility?.ready).toBe(false));
  const payload:ReleaseBlockerCommandPayload={kind:"release-blocker",editSeq:owner.current().editSeq,eligibilityBasis:release.eligibilityBasis,sourceSnapshotId:release.sourceSnapshotId,unitId,locale:"zh-CN"};
  expect(registry.dispatch("release.open-blocker",scope,{...payload,unitId:fixtureIdentity(999)})).toBe(false);
  await user.click(screen.getByRole("button",{name:i18n.t("translation.openEditor")}));await waitFor(()=>expect(calls("read_review_target")).toHaveLength(1));
  if(mode==="hidden")view.rerender(<Harness consumer={false}/>,project);
  await act(async()=>response.resolve({...reviewFixture.responses.target,unitId:mode==="wrong-target"?fixtureIdentity(999):unitId}));
  if(mode==="current")expect(navigate).toHaveBeenCalledExactlyOnceWith({unitId,sourceRevisionId:reviewFixture.responses.target.sourceRevisionId,
    key:reviewFixture.responses.target.nativeKey,sourceText:reviewFixture.responses.target.sourceText},"zh-CN");
  else expect(navigate).not.toHaveBeenCalled();expect(calls("prepare_plugin_build")).toHaveLength(0);expect(calls("export_release")).toHaveLength(0);
});


it("does not publish an assessment from a failed replacement Query removed while the explicit eligibility read is pending",async()=>{
  const {user,view}=await open();await user.click(screen.getByRole("checkbox",{name:"zh-CN"}));await user.type(screen.getByRole("textbox",{name:i18n.t("releasePlugin.paths",{locale:"zh-CN"})}),"i18n/zh.json");
  const response=deferred<unknown>(),original=invoke.getMockImplementation()!;let expected:unknown;
  invoke.mockImplementation(async(command:string,args)=>{if(command==="read_review_eligibility"){expected=await original(command,args);return response.promise;}return original(command,args);});
  act(()=>{expect(registry.dispatch("release.assess-build",scope,preparation())).toBe(true);});
  await waitFor(()=>expect(calls("read_review_eligibility")).toHaveLength(1));view.rerender(<Harness consumer={false}/>,project);
  const key=reads.key(environmentKey());
  act(()=>{reads.client.removeQueries({queryKey:key,exact:true});reads.client.setQueryData(key,pluginBuildView);
    reads.client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:"error",error:new Error("Replacement failed")});reads.client.removeQueries({queryKey:key,exact:true});});
  await act(async()=>response.resolve(expected));await waitFor(()=>expect(owner.current().busy).toBe(false));
  expect(owner.current().eligibility).toBeNull();expect(owner.current().assessment).toBeNull();expect(calls("create_execution_identity")).toHaveLength(0);
});

it("rechecks its flight Query after identity and the final source read instead of dispatching from an earlier successful witness",async()=>{
  const {view}=await prepared(),response=deferred<unknown>(),original=invoke.getMockImplementation()!;let sourceReads=0,expected:unknown;
  invoke.mockImplementation(async(command:string,args)=>{if(command==="read_content_scope"&&++sourceReads===2){expected=await original(command,args);return response.promise;}return original(command,args);});
  act(()=>{expect(registry.dispatch("release.prepare-build",scope,preparation())).toBe(true);});
  await waitFor(()=>expect(calls("create_execution_identity")).toHaveLength(1));await waitFor(()=>expect(sourceReads).toBe(2));view.rerender(<Harness consumer={false}/>,project);
  const key=reads.key(environmentKey());
  act(()=>{reads.client.removeQueries({queryKey:key,exact:true});reads.client.setQueryData(key,{...pluginBuildView,settingsRevision:"2"});reads.client.removeQueries({queryKey:key,exact:true});});
  await act(async()=>response.resolve(expected));await waitFor(()=>expect(owner.current().busy).toBe(false));expect(calls("prepare_plugin_build")).toHaveLength(0);
});
