import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { IncrementalMaintenance } from "./IncrementalMaintenance";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import type { MaintenanceAssessment } from "./workPlanCommands";
import type { ProjectView } from "./projectCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import type { WorkspaceArea } from "./WorkbenchFrame";
import { useSessionReads } from "./SessionReadProvider";

const invoke=vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const snapshot=fixtureIdentity(300);
const project:ProjectView={sessionToken:"maintenance-session",locator:"isolated",reconciliationState:"settled",
  metadata:{projectId:fixtureIdentity(500),displayName:"Synthetic maintenance",sourceLocale:"en",targetLocales:["zh-CN"],metadataRevision:"1"}};
let owner:ReturnType<typeof useAiPreparation>, manual:ReturnType<typeof useTranslationDraftSession>, reads:ReturnType<typeof useSessionReads>, assessment:MaintenanceAssessment;
function Probe(){const value=useAiPreparation(), draft=useTranslationDraftSession(), session=useSessionReads();useLayoutEffect(()=>{owner=value;manual=draft;reads=session;});return null;}
const navigate=vi.fn(async(_area:WorkspaceArea)=>true);
function Harness(){return <AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe/>
  <IncrementalMaintenance project={project} active disabled={false} onOpenManual={navigate}/></AiPreparationSession>;}
beforeEach(async()=>{
  await i18n.changeLanguage("en-US");navigate.mockClear();
  assessment={projectId:project.metadata.projectId,sourceSnapshotId:snapshot,locale:"zh-CN",after:0,limit:100,nextOrdinal:100,
    coverage:"finite-current-source-window; explicit-unit-and-literal-possible-resource-impact; historical-and-external-query-coverage-unknown",digest:"a".repeat(64),
    rows:[1,2,3,4].map(index=>({unitId:fixtureIdentity(900+index),sourceRevisionId:fixtureIdentity(910+index),nativeKey:`Entry ${index}`,
      sourceText:`Original ${index}`,translationText:index===1?null:`Translation ${index}`,selectionId:index===1?null:fixtureIdentity(920+index),translationRevisionId:index===1?null:fixtureIdentity(930+index),
      reviewBasis:"b".repeat(64),protection:{unitId:fixtureIdentity(900+index),locale:"zh-CN",revision:"1",protected:index===2},mappingUnresolved:index===3,
      reasons:index===4?[]:[index===3?"correspondence-unresolved":"translation-missing"],suggested:index===3?"unresolved":index===4?"keep":"repair"}))};
  invoke.mockReset().mockImplementation(async(command:string,{request}:{request:Record<string,unknown>})=>{
    if(command==="read_context_strategy_default")return null;
    if(command==="read_content_scope")return{revision:"1",currentSnapshot:snapshot};
    if(command==="read_maintenance_assessment")return{...structuredClone(assessment),after:request.after};
    throw new Error(command);
  });
});afterEach(cleanup);
async function open(){const result=render(<Harness/>,project),user=userEvent.setup();
  act(()=>{owner.setConfig({...owner.config,model:"Newer config B"});manual.begin({unitId:fixtureIdentity(999),locale:"zh-CN",sourceRevisionId:fixtureIdentity(998),key:"Manual",sourceText:"Separate"},null,null,"Manual B");});
  await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.title")}));
  await screen.findByRole("heading",{name:"Entry 1"});return{...result,user};}

it("captures only explicit repair choices, excludes protected and unresolved mappings, and preserves independent B drafts",async()=>{
  const {user}=await open();await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.capture")}));
  expect(owner.selected).toEqual([fixtureIdentity(901)]);expect(owner.maintenance?.choices.filter(choice=>choice.excluded).map(choice=>choice.unitId)).toEqual([fixtureIdentity(902),fixtureIdentity(903)]);
  expect(screen.getByRole("checkbox",{name:i18n.t("ai.maintenance.exclude",{name:"Entry 2"})})).toBeDisabled();
  await user.selectOptions(screen.getByRole("combobox",{name:i18n.t("ai.maintenance.actionFor",{name:"Entry 4"})}),"repair");
  expect(owner.selected).toEqual([fixtureIdentity(901),fixtureIdentity(904)]);expect(owner.consent).toBe(false);expect(owner.preparedPlan).toBeNull();
  expect(owner.config.model).toBe("Newer config B");expect(manual.current()?.text).toBe("Manual B");
  expect(invoke.mock.calls.every(([command])=>["read_context_strategy_default","read_content_scope","read_maintenance_assessment"].includes(command))).toBe(true);
  await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.review")}));expect(navigate).toHaveBeenCalledWith("review");
  await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.source")}));expect(navigate).toHaveBeenCalledWith("source");
});

it("retains captured choices through changed or failed current reads and requires explicit replacement",async()=>{
  const {user}=await open();await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.capture")}));
  await user.selectOptions(screen.getByRole("combobox",{name:i18n.t("ai.maintenance.actionFor",{name:"Entry 1"})}),"recheck");
  const before=structuredClone(owner.maintenance);assessment={...assessment,digest:"c".repeat(64),rows:assessment.rows.map(row=>({...row,sourceRevisionId:fixtureIdentity(950)}))};
  await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.refresh")}));await screen.findByText(i18n.t("ai.maintenance.changed"));
  expect(owner.maintenance).toEqual(before);expect(owner.selected).toEqual([]);
  const original=invoke.getMockImplementation()!;invoke.mockImplementation((command,args)=>command==="read_maintenance_assessment"?Promise.reject(new Error("Synthetic read failure")):original(command,args));
  await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.refresh")}));await screen.findByText(i18n.t("ai.maintenance.failed"));
  expect(owner.maintenance).toEqual(before);expect(owner.config.model).toBe("Newer config B");expect(manual.current()?.text).toBe("Manual B");
  expect(screen.queryByText(i18n.t("ai.maintenance.empty"))).not.toBeInTheDocument();
});

it("keeps window changes explicit and refuses an old edit sequence without clearing the newer choice",async()=>{
  const {user}=await open();await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.capture")}));
  expect(screen.getByRole("button",{name:i18n.t("execution.nextPage")})).toBeDisabled();
  const seq=owner.editSeq,choice=owner.maintenance!.choices[0];
  act(()=>{expect(owner.editMaintenance({...choice,action:"recheck"},seq)).toBe(true);expect(owner.editMaintenance({...choice,action:"repair"},seq)).toBe(false);});
  expect(owner.maintenance?.choices[0].action).toBe("recheck");
  await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.discard")}));
  expect(owner.maintenance).toBeNull();expect(manual.current()?.text).toBe("Manual B");
  await user.click(screen.getByRole("button",{name:i18n.t("execution.nextPage")}));
  await waitFor(()=>expect(invoke.mock.calls.some(([command,args])=>command==="read_maintenance_assessment"&&args.request.after===100)).toBe(true));
  await user.click(screen.getByRole("button",{name:i18n.t("ai.maintenance.title")}));
  expect(reads.client.getQueryState(reads.key(["source-scope"]))?.isInvalidated).toBe(false);
});
