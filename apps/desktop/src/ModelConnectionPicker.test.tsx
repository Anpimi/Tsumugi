import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConnectionPicker, PreparationBudgetSummary } from "./ModelConnectionPicker";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { defaultAiConfig } from "./aiCommands";
import { i18n } from "./i18n";
import { connectionFixture } from "./testSupport/connectionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ConnectionReadView } from "./connectionCommands";
const invoke = vi.hoisted(()=>vi.fn());vi.mock("@tauri-apps/api/core",()=>({invoke}));
const config={...defaultAiConfig,endpoint:"https://example.test/v1",model:"Synthetic model",credentialEnv:"SYNTHETIC_REFERENCE",maxRequests:4,maxOutputTokens:37,
  connectionProfile:{storeId:fixtureIdentity(700),profileId:fixtureIdentity(701),revision:"1",digest:"a".repeat(64)}};
let view=connectionFixture([config]);
beforeEach(async()=>{await i18n.changeLanguage("en-US");view=connectionFixture([config]);view.snapshot.profiles[0].name="日本語 {{player}} 👩🏽‍💻 é";invoke.mockReset().mockImplementation(async command=>{if(command==="read_model_connections")return structuredClone(view);throw new Error(command);});});afterEach(cleanup);
function setup(linked=false){const selected=vi.fn((_view:ConnectionReadView|null,_id:string,_seq:number)=>true),manage=vi.fn();return {selected,manage,...render(<ApplicationReadProvider><ModelConnectionPicker config={linked?config:defaultAiConfig} label={i18n.t("connections.choose")} active disabled={false} editSeq={7} onSelect={selected} onOpenSettings={manage}/></ApplicationReadProvider>)};}
it.each(["en-US","zh-CN"])("chooses literal named facts with the original edit sequence and no model request in %s",async locale=>{
 await i18n.changeLanguage(locale);const user=userEvent.setup(),result=setup();const option=await screen.findByRole("option",{name:"日本語 {{player}} 👩🏽‍💻 é · Synthetic model"});expect(option).toBeEnabled();
 await user.selectOptions(screen.getByRole("combobox",{name:i18n.t("connections.choose")}),config.connectionProfile.profileId);
 expect(result.selected).toHaveBeenCalledWith(expect.objectContaining({references:[config.connectionProfile]}),config.connectionProfile.profileId,7);
 expect(invoke.mock.calls.every(([command])=>command==="read_model_connections")).toBe(true);
 await user.click(screen.getByRole("button",{name:i18n.t("connections.manage")}));expect(result.manage).toHaveBeenCalledOnce();
});
it("shows an obsolete captured choice and preserves the original config until explicit reselection",async()=>{
 const user=userEvent.setup(),result=setup(true);await screen.findByText(i18n.t("connections.selectionCurrent"));
 view.snapshot.revision="2";view.basis.revision="2";view.snapshot.profiles[0].revision="2";view.references[0].revision="2";view.references[0].digest="b".repeat(64);
 await user.click(screen.getByRole("button",{name:i18n.t("connections.refresh")}));await screen.findByText(i18n.t("connections.selectionChanged"));
 expect(screen.getByRole("combobox")).toHaveValue("captured");expect(result.selected).not.toHaveBeenCalled();expect(config.connectionProfile.revision).toBe("1");
 await user.selectOptions(screen.getByRole("combobox"),config.connectionProfile.profileId);expect(result.selected.mock.calls[0][0]?.references[0].revision).toBe("2");
});
it("keeps recovery inside the picker and supports explicit one-time mode when saved facts cannot be read",async()=>{
 invoke.mockRejectedValue({code:"storage-failed",stage:"model-connections",outcome:"rejected",reason:"model-connections-storage"});const user=userEvent.setup(),result=setup(true);
 await screen.findByText(i18n.t("connections.readFailed"));await user.selectOptions(screen.getByRole("combobox"),"");expect(result.selected).toHaveBeenCalledWith(null,"",7);
 invoke.mockImplementation(async()=>structuredClone(view));await user.click(screen.getByRole("button",{name:i18n.t("connections.refresh")}));await screen.findByText(i18n.t("connections.selectionCurrent"));expect(invoke.mock.calls).toHaveLength(2);
});
it("shows sharing and request limits without duplicating the Arena shared request budget",()=>{
 render(<PreparationBudgetSummary config={{...config,shareTerms:true,shareContext:false}} perRequest/>);
 expect(screen.getByText(i18n.t("connections.sharingTerms"))).toBeInTheDocument();expect(screen.getByText(/37 output tokens/)).toBeInTheDocument();expect(screen.queryByText(/4 requests/)).not.toBeInTheDocument();
});
it("describes incomplete numeric input without substituting defaults or showing NaN",()=>{
 render(<PreparationBudgetSummary config={{...config,maxRequests:Number.NaN}}/>);expect(screen.getByText(i18n.t("connections.incompleteBudget"))).toBeInTheDocument();expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
});
it.each(["en-US","zh-CN"])("keeps the sharing summary within its explicit discussion profile in %s",async locale=>{
 await i18n.changeLanguage(locale);
 const {rerender}=render(<PreparationBudgetSummary config={config}/>);
 expect(screen.getByText(i18n.t("ai.costUnknown"))).toBeInTheDocument();
 rerender(<PreparationBudgetSummary config={config} policy={{profile:"current-plan-1"}}/>);
 expect(screen.getByText(i18n.t("ai.discussions.costUnknown"))).toBeInTheDocument();
 expect(screen.queryByText(i18n.t("ai.discussions.artifactCostUnknown"))).not.toBeInTheDocument();
 rerender(<PreparationBudgetSummary config={config} policy={{profile:"current-plan-2"}}/>);
 expect(screen.getByText(i18n.t("ai.discussions.artifactCostUnknown"))).toBeInTheDocument();
 expect(screen.queryByText(i18n.t("ai.costUnknown"))).not.toBeInTheDocument();
 rerender(<PreparationBudgetSummary config={config}/>);
 expect(screen.getByText(i18n.t("ai.costUnknown"))).toBeInTheDocument();
 expect(invoke).not.toHaveBeenCalled();
});
