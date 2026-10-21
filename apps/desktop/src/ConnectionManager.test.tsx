import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, useRef, useState } from "react";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ConnectionDraftProvider } from "./ConnectionDraftSession";
import { ConnectionManager, type ConnectionManagerHandle } from "./ConnectionManager";
import { i18n } from "./i18n";
import type { ConnectionReadView, ModelConnectionChange, ModelConnectionReceipt, ModelConnectionProfile } from "./connectionCommands";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const namespace="22222222-2222-4222-8222-222222222222", profileId="33333333-3333-4333-8333-333333333333", actionId="11111111-1111-4111-8111-111111111111";
function empty():ConnectionReadView{return {snapshot:{storeId:null,revision:"0",lastActionId:null,profiles:[]},basis:{storeId:null,revision:"0",digest:"a".repeat(64)},references:[]};}
let current:ConnectionReadView, actions:Map<string,ModelConnectionReceipt>;
function makeView(profiles:ModelConnectionProfile[],revision:string,last=actionId):ConnectionReadView {
  return {snapshot:{storeId:namespace,revision,lastActionId:last,profiles},basis:{storeId:namespace,revision,digest:"a".repeat(64)},
    references:profiles.filter(p=>!p.archived).map(p=>({storeId:namespace,profileId:p.id,revision:p.revision,digest:"b".repeat(64)}))};
}
function commit(request:ModelConnectionChange) {
  const revision=String(BigInt(request.expected.revision)+1n), profiles=structuredClone(current.snapshot.profiles);let target=profiles.find(p=>p.id===request.edit.profileId);
  if(request.edit.kind === "save") {if(!target){target={id:request.edit.profileId,revision,name:request.edit.name,connection:structuredClone(request.edit.connection),archived:false};profiles.push(target);}else{target.name=request.edit.name;target.connection=structuredClone(request.edit.connection);target.revision=revision;}}
  else if(target){target.archived=request.edit.kind === "archive";target.revision=revision;}
  profiles.sort((a,b)=>a.id.localeCompare(b.id));current=makeView(profiles,revision,request.actionId);
  const receipt={actionId:request.actionId,requestDigest:"c".repeat(64),snapshot:structuredClone(current.snapshot)};actions.set(request.actionId,receipt);return receipt;
}
function setup(ref=createRef<ConnectionManagerHandle>()) {return {ref,...render(<ApplicationReadProvider><ConnectionDraftProvider><ConnectionManager disabled={false} ref={ref}/></ConnectionDraftProvider></ApplicationReadProvider>)};}
async function fill(user:ReturnType<typeof userEvent.setup>,name="Synthetic A") {
  await user.type(screen.getByLabelText(i18n.t("connections.name")),name);
  await user.type(screen.getByLabelText(i18n.t("connections.endpoint")),"https://example.test/v1/chat/completions");
  await user.type(screen.getByLabelText(i18n.t("connections.model")),"Synthetic model");
}
async function open(user:ReturnType<typeof userEvent.setup>) {await user.click(screen.getByRole("button",{name:i18n.t("connections.open")}));await screen.findByText(i18n.t("connections.empty"));}
beforeEach(async()=>{await i18n.changeLanguage("en-US");current=empty();actions=new Map();invoke.mockReset().mockImplementation(async(command,args)=>{
  if(command === "read_model_connections")return structuredClone(current);if(command === "change_model_connections")return actions.get(args.request.actionId)??commit(args.request);
  if(command === "read_model_connection_action")return actions.get(args.request.actionId)??null;throw new Error(command);
});});afterEach(cleanup);

describe("connection settings consumer",()=>{
  it.each(["en-US","zh-CN"])("saves non-secret defaults and retains the draft across close/reopen in %s",async locale=>{
    await i18n.changeLanguage(locale);const user=userEvent.setup();setup();await open(user);await fill(user);
    await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));await user.click(screen.getByRole("button",{name:i18n.t("connections.open")}));
    expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Synthetic A");await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));
    await screen.findByText(i18n.t("connections.notices.saved"));expect(await screen.findByRole("button",{name:"Synthetic A"})).toBeEnabled();
    const calls=invoke.mock.calls.filter(([command])=>command === "change_model_connections");expect(calls).toHaveLength(1);
    expect(calls[0][1].request.edit.connection).toEqual({endpoint:"https://example.test/v1/chat/completions",model:"Synthetic model",credentialEnv:"OPENAI_API_KEY",tokenField:"max_tokens"});
    expect(JSON.stringify(calls[0][1])).not.toContain("apiKey");
  });
  it("keeps B editable while A saves and does not replace it when the acknowledgement arrives",async()=>{
    let resolve!:(value:ModelConnectionReceipt)=>void, request!:ModelConnectionChange;const write=new Promise<ModelConnectionReceipt>(yes=>resolve=yes);
    invoke.mockImplementation(async(command,args)=>{if(command === "read_model_connections")return structuredClone(current);if(command === "change_model_connections"){request=args.request;return write;}throw new Error(command);});
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await waitFor(()=>expect(request).toBeDefined());
    const name=screen.getByLabelText(i18n.t("connections.name"));expect(name).toBeEnabled();await user.clear(name);await user.type(name,"Synthetic B 日本語 مرحبا 👩🏽‍💻 é");
    await act(async()=>resolve(commit(request)));await screen.findByText(i18n.t("connections.notices.saved-newer-draft"));expect(name).toHaveValue("Synthetic B 日本語 مرحبا 👩🏽‍💻 é");expect(screen.getByRole("button",{name:i18n.t("connections.save")})).toBeEnabled();
  });
  it("checks the same uncertain action across panel close without replaying a committed write",async()=>{
    invoke.mockImplementation(async(command,args)=>{if(command === "read_model_connections")return structuredClone(current);if(command === "change_model_connections"){commit(args.request);throw {code:"outcome-unknown",stage:"model-connections",outcome:"unknown",recoveryRequired:true};}
      if(command === "read_model_connection_action")return actions.get(args.request.actionId);throw new Error(command);});
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));
    await screen.findByRole("button",{name:i18n.t("connections.reconcile")});expect(screen.queryByRole("button",{name:i18n.t("connections.retry")})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));await user.click(screen.getByRole("button",{name:i18n.t("connections.open")}));
    await user.click(screen.getByRole("button",{name:i18n.t("connections.reconcile")}));await screen.findByText(i18n.t("connections.notices.saved"));
    expect(invoke.mock.calls.filter(([command])=>command === "change_model_connections")).toHaveLength(1);
  });
  it("offers explicit review before retained B can overwrite an externally changed connection",async()=>{
    const connection={endpoint:"https://example.test/v1/chat/completions",model:"Synthetic model",credentialEnv:"",tokenField:"max_tokens"};current=makeView([{id:profileId,revision:"1",name:"Saved A",connection,archived:false}],"1");
    const user=userEvent.setup();setup();await user.click(screen.getByRole("button",{name:i18n.t("connections.open")}));await user.click(await screen.findByRole("button",{name:"Saved A"}));
    const name=screen.getByLabelText(i18n.t("connections.name"));await user.clear(name);await user.type(name,"Draft B");current=makeView([{...current.snapshot.profiles[0],revision:"2",name:"Saved C"}],"2");
    await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await screen.findByRole("heading",{name:i18n.t("connections.changedTitle")});
    expect(name).toHaveValue("Draft B");expect(invoke.mock.calls.filter(([command])=>command === "change_model_connections")).toHaveLength(0);
    await user.click(screen.getByRole("button",{name:i18n.t("connections.keepAndReview")}));await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await screen.findByText(i18n.t("connections.notices.saved"));expect(current.snapshot.profiles[0].name).toBe("Draft B");
  });
  it("archives and restores with separate exact actions while keeping saved defaults",async()=>{
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await screen.findByText(i18n.t("connections.notices.saved"));
    const original=structuredClone(current.snapshot.profiles[0].connection);await user.click(await screen.findByRole("button",{name:i18n.t("connections.archive")}));await screen.findByText(i18n.t("connections.notices.archive"));
    await user.click(screen.getByLabelText(i18n.t("connections.showArchived")));await user.click(await screen.findByRole("button",{name:i18n.t("connections.restore")}));await screen.findByText(i18n.t("connections.notices.restore"));
    expect(current.snapshot.profiles[0].connection).toEqual(original);expect(current.snapshot.profiles[0].archived).toBe(false);
    const requests=invoke.mock.calls.filter(([command])=>command === "change_model_connections").map(([,args])=>args.request);expect(requests.map(r=>r.edit.kind)).toEqual(["save","archive","restore"]);expect(new Set(requests.map(r=>r.actionId)).size).toBe(3);
  });
  it("keeps a newer draft visible when an older exit confirmation is no longer current",async()=>{
    const user=userEvent.setup(), result=setup();await open(user);await fill(user);let exit!:ReturnType<ConnectionManagerHandle["prepareExit"]>;
    act(()=>{exit=result.ref.current!.prepareExit(()=>true);});await screen.findByRole("heading",{name:i18n.t("connections.exitTitle")});
    const name=screen.getByLabelText(i18n.t("connections.name"));await user.type(name," B");await user.click(screen.getByRole("button",{name:i18n.t("connections.discardAndExit")}));expect(await exit).toBeNull();
    expect(name).toHaveValue("Synthetic A B");expect(screen.getByRole("dialog")).toBeInTheDocument();await screen.findByText(i18n.t("connections.notices.exit-edited"));
  });
  it("shows the field error and keeps all input after a known rejected save",async()=>{
    invoke.mockImplementation(async command=>{if(command === "read_model_connections")return current;throw {code:"invalid-input",stage:"model-connections",outcome:"rejected",recoveryRequired:false,reason:"ai-endpoint"};});
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));
    await screen.findByText(i18n.t("connections.errors.endpoint"));expect(screen.getByLabelText(i18n.t("connections.endpoint"))).toHaveAttribute("aria-invalid","true");expect(screen.getByLabelText(i18n.t("connections.endpoint"))).toHaveAccessibleDescription(i18n.t("connections.errors.endpoint"));expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Synthetic A");
  });
  it("requires a current discard confirmation before opening another record",async()=>{
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.new")}));
    await screen.findByRole("heading",{name:i18n.t("connections.switchTitle")});await user.click(screen.getByRole("button",{name:i18n.t("connections.keepDraft")}));expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Synthetic A");
  });
});

it.each(["button","escape"] as const)("returns keyboard focus to an imperative preparation opener after %s dismissal",async dismissal=>{
  const user=userEvent.setup(),ref=createRef<ConnectionManagerHandle>();
  render(<ApplicationReadProvider><ConnectionDraftProvider><button type="button" onClick={()=>ref.current?.open()}>Manage preparation connection</button><ConnectionManager disabled={false} ref={ref}/></ConnectionDraftProvider></ApplicationReadProvider>);
  const opener=screen.getByRole("button",{name:"Manage preparation connection"});await user.click(opener);
  await screen.findByRole("dialog",{name:i18n.t("connections.title")});
  if(dismissal==="button")await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));else await user.keyboard("{Escape}");
  await waitFor(()=>expect(opener).toHaveFocus());expect(invoke.mock.calls.filter(([command])=>command==="change_model_connections")).toHaveLength(0);
});

it.each(["button", "escape"] as const)("returns to an explicit stable target after its temporary launcher disappears (%s)", async dismissal => {
  const user = userEvent.setup(), ref = createRef<ConnectionManagerHandle>();
  function Launcher() {
    const stable = useRef<HTMLButtonElement>(null), [visible, setVisible] = useState(true);
    return <><button type="button" ref={stable}>Application settings</button>{visible ? <button type="button" onClick={() => {
      if (stable.current) { ref.current?.open(stable.current); setVisible(false); }
    }}>Temporary connection action</button> : null}</>;
  }
  render(<ApplicationReadProvider><ConnectionDraftProvider><Launcher/><ConnectionManager ref={ref} disabled={false} hideTrigger/></ConnectionDraftProvider></ApplicationReadProvider>);
  expect(screen.queryByRole("button", { name: i18n.t("connections.open") })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Temporary connection action" }));
  await screen.findByRole("dialog", { name: i18n.t("connections.title") });
  expect(screen.queryByRole("button", { name: "Temporary connection action" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  if (dismissal === "button") await user.click(screen.getByRole("button", { name: i18n.t("connections.close") }));
  else await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("button", { name: "Application settings" })).toHaveFocus());
  expect(invoke.mock.calls.some(([command]) => command === "change_model_connections")).toBe(false);
});
