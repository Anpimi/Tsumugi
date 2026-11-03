import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, useRef, useState } from "react";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ConnectionDraftProvider } from "./ConnectionDraftSession";
import { ConnectionManager, type ConnectionManagerHandle } from "./ConnectionManager";
import { Sheet } from "./design-system/Dialog";
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
function setupEmbedded(initialVisible = true) {
  const ref = createRef<ConnectionManagerHandle>(), onReveal = vi.fn();
  function Settings() {
    const [visible, setVisible] = useState(initialVisible);
    return <Sheet open onOpenChange={() => {}} title="Application settings" closeLabel="Close settings">
      <button type="button" onClick={() => setVisible(false)}>General section</button>
      <button type="button" onClick={() => setVisible(true)}>Connection section</button>
      <ConnectionManager ref={ref} disabled={false} presentation="embedded" visible={visible} onReveal={() => { onReveal(); setVisible(true); }}/>
    </Sheet>;
  }
  return { ref, onReveal, ...render(<ApplicationReadProvider><ConnectionDraftProvider><Settings/></ConnectionDraftProvider></ApplicationReadProvider>) };
}
async function fill(user:ReturnType<typeof userEvent.setup>,name="Synthetic A") {
  await user.type(screen.getByLabelText(i18n.t("connections.name")),name);
  await user.type(screen.getByLabelText(i18n.t("connections.endpoint")),"https://example.test/v1/chat/completions");
  await user.type(screen.getByLabelText(i18n.t("connections.model")),"Synthetic model");
}
async function open(user:ReturnType<typeof userEvent.setup>) {await user.click(screen.getByRole("button",{name:i18n.t("connections.open")}));await screen.findByText(i18n.t("connections.empty"));}
beforeEach(async()=>{await i18n.changeLanguage("en-US");current=empty();actions=new Map();invoke.mockReset().mockImplementation(async(command,args)=>{
  if(command === "read_model_connection_keys")return [];if(command === "read_model_connections")return structuredClone(current);if(command === "change_model_connections")return actions.get(args.request.actionId)??commit(args.request);
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
    invoke.mockImplementation(async(command,args)=>{if(command === "read_model_connection_keys")return [];if(command === "read_model_connections")return structuredClone(current);if(command === "change_model_connections"){request=args.request;return write;}throw new Error(command);});
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await waitFor(()=>expect(request).toBeDefined());
    const name=screen.getByLabelText(i18n.t("connections.name"));expect(name).toBeEnabled();await user.clear(name);await user.type(name,"Synthetic B 日本語 مرحبا 👩🏽‍💻 é");
    await act(async()=>resolve(commit(request)));await screen.findByText(i18n.t("connections.notices.saved-newer-draft"));expect(name).toHaveValue("Synthetic B 日本語 مرحبا 👩🏽‍💻 é");expect(screen.getByRole("button",{name:i18n.t("connections.save")})).toBeEnabled();
  });
  it("checks the same uncertain action across panel close without replaying a committed write",async()=>{
    invoke.mockImplementation(async(command,args)=>{if(command === "read_model_connection_keys")return [];if(command === "read_model_connections")return structuredClone(current);if(command === "change_model_connections"){commit(args.request);throw {code:"outcome-unknown",stage:"model-connections",outcome:"unknown",recoveryRequired:true};}
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
    invoke.mockImplementation(async command=>{if(command === "read_model_connection_keys")return [];if(command === "read_model_connections")return current;throw {code:"invalid-input",stage:"model-connections",outcome:"rejected",recoveryRequired:false,reason:"ai-endpoint"};});
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));
    await screen.findByText(i18n.t("connections.errors.endpoint"));expect(screen.getByLabelText(i18n.t("connections.endpoint"))).toHaveAttribute("aria-invalid","true");expect(screen.getByLabelText(i18n.t("connections.endpoint"))).toHaveAccessibleDescription(i18n.t("connections.errors.endpoint"));expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Synthetic A");
  });
  it("requires a current discard confirmation before opening another record",async()=>{
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.click(screen.getByRole("button",{name:i18n.t("connections.new")}));
    await screen.findByRole("heading",{name:i18n.t("connections.switchTitle")});await user.click(screen.getByRole("button",{name:i18n.t("connections.keepDraft")}));expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Synthetic A");
  });
});

describe("connections embedded in application settings", () => {
  it.each([
    { locale: "en-US", title: "Model connections", name: "Connection name", credential: "Credential environment variable", check: "Check account status" },
    { locale: "zh-CN", title: "模型连接档案", name: "连接名称", credential: "凭据环境变量名", check: "查询账号状态" },
  ])("keeps the connection labels and account action readable in $locale", async copy => {
    await i18n.changeLanguage(copy.locale); setupEmbedded();
    expect(await screen.findByRole("heading", { name: copy.title })).toBeVisible();
    expect(screen.getByRole("textbox", { name: copy.name })).toHaveAttribute("id", "connection-name");
    expect(screen.getByRole("textbox", { name: copy.credential })).toHaveAttribute("id", "connection-credentialEnv");
    expect(screen.getByRole("button", { name: copy.check })).toBeEnabled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Application settings");
    expect(screen.queryByRole("button", { name: i18n.t("connections.open") })).not.toBeInTheDocument();
    expect(invoke.mock.calls.some(([command]) => command === "read_chatgpt_account")).toBe(false);
  });

  it("observes connections only in the visible section and keeps its draft when switching away and back", async () => {
    const user = userEvent.setup(); setupEmbedded(false);
    expect(invoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Connection section" }));
    await screen.findByText(i18n.t("connections.empty")); await fill(user);
    const name = screen.getByLabelText(i18n.t("connections.name"));
    await user.click(screen.getByRole("button", { name: "General section" }));
    expect(name).not.toBeVisible();
    const reads = invoke.mock.calls.filter(([command]) => command === "read_model_connections").length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(invoke.mock.calls.filter(([command]) => command === "read_model_connections")).toHaveLength(reads);
    await user.click(screen.getByRole("button", { name: "Connection section" }));
    await screen.findByText(i18n.t("connections.empty"));
    expect(screen.getByLabelText(i18n.t("connections.name"))).toBe(name);
    expect(name).toHaveValue("Synthetic A");
    expect(invoke.mock.calls.some(([command]) => command === "change_model_connections")).toBe(false);
  });

  it("preserves B and the original save while the connections section is hidden", async () => {
    let resolve!: (value: ModelConnectionReceipt) => void, request!: ModelConnectionChange;
    const write = new Promise<ModelConnectionReceipt>(yes => { resolve = yes; });
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_model_connections") return structuredClone(current);
      if (command === "change_model_connections") { request = args.request; return write; }
      throw new Error(command);
    });
    const user = userEvent.setup(); setupEmbedded();
    await screen.findByText(i18n.t("connections.empty")); await fill(user);
    await user.click(screen.getByRole("button", { name: i18n.t("connections.save") }));
    await waitFor(() => expect(request).toBeDefined());
    const name = screen.getByLabelText(i18n.t("connections.name"));
    await user.clear(name); await user.type(name, "Newer B 日本語 مرحبا 👩🏽‍💻 é");
    await user.click(screen.getByRole("button", { name: "General section" }));
    await act(async () => { resolve(commit(request)); });
    await user.click(screen.getByRole("button", { name: "Connection section" }));
    await screen.findByText(i18n.t("connections.notices.saved-newer-draft"));
    expect(name).toHaveValue("Newer B 日本語 مرحبا 👩🏽‍💻 é");
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("connections.save") })).toBeEnabled());
    expect(current.snapshot.profiles[0].name).toBe("Synthetic A");
    expect(invoke.mock.calls.filter(([command]) => command === "change_model_connections")).toHaveLength(1);
  });

  it.each([
    { locale: "en-US", unknown: "Could not confirm whether the save succeeded. Your pending request and newer edits are kept. Check the save status before saving again.", exit: "Unsaved connection draft", discard: "Discard draft and exit" },
    { locale: "zh-CN", unknown: "保存结果尚不确定，原请求与最新修改均已保留。再次保存前，请先查询上次保存的状态。", exit: "存在未保存的连接草稿", discard: "丢弃草稿并退出" },
  ])("reveals an unknown save for original-action recovery and holds the checked exit permit in $locale", async copy => {
    await i18n.changeLanguage(copy.locale);
    invoke.mockImplementation(async (command, args) => {
      if (command === "read_model_connections") return structuredClone(current);
      if (command === "change_model_connections") {
        commit(args.request); throw { code: "outcome-unknown", stage: "model-connections", outcome: "unknown", recoveryRequired: true };
      }
      if (command === "read_model_connection_action") return actions.get(args.request.actionId);
      throw new Error(command);
    });
    const user = userEvent.setup(), result = setupEmbedded();
    await screen.findByText(i18n.t("connections.empty")); await fill(user);
    await user.click(screen.getByRole("button", { name: i18n.t("connections.save") }));
    await screen.findByRole("region", { name: i18n.t("connections.recoveryTitle") });
    const request = invoke.mock.calls.find(([command]) => command === "change_model_connections")![1].request;
    await user.click(screen.getByRole("button", { name: "General section" }));
    let exit!: ReturnType<ConnectionManagerHandle["prepareExit"]>;
    act(() => { exit = result.ref.current!.prepareExit(() => true); });
    expect(await exit).toBeNull(); expect(result.onReveal).toHaveBeenCalledOnce();
    await screen.findByRole("region", { name: i18n.t("connections.recoveryTitle") });
    expect(screen.getByText(copy.unknown)).toBeVisible();
    await user.click(screen.getByRole("button", { name: i18n.t("connections.reconcile") }));
    await screen.findByText(i18n.t("connections.notices.saved"));
    await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("connections.refresh") })).toBeEnabled());
    expect(invoke).toHaveBeenCalledWith("read_model_connection_action", { request: { actionId: request.actionId } });
    expect(invoke.mock.calls.filter(([command]) => command === "change_model_connections")).toHaveLength(1);
    const name = screen.getByLabelText(i18n.t("connections.name"));
    await user.type(name, " B");
    await user.click(screen.getByRole("button", { name: "General section" }));
    let intentCurrent = true;
    act(() => { exit = result.ref.current!.prepareExit(() => intentCurrent); });
    await screen.findByRole("heading", { name: i18n.t("connections.exitTitle") });
    expect(screen.getByRole("heading", { name: copy.exit })).toBeVisible();
    expect(screen.getByRole("button", { name: copy.discard })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: i18n.t("connections.discardAndExit") }));
    const permit = await exit;
    expect(permit?.current()).toBe(true); expect(name).toBeDisabled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    intentCurrent = false; expect(permit?.current()).toBe(false);
    act(() => { permit?.release(); }); expect(name).toBeEnabled();
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

describe("system-key settings input lifetime",()=>{
  let keys:Map<string,string>;
  beforeEach(()=>{
    keys=new Map();invoke.mockImplementation(async(command,args)=>{
      if(command === "read_model_connections")return structuredClone(current);
      if(command === "read_model_connection_action")return actions.get(args.request.actionId)??null;
      if(command === "read_model_connection_key")return {reference:args.request.reference,availability:keys.has(args.request.reference)?"available":"missing"};
      if(command === "read_model_connection_keys")return [...keys.keys()].map(reference=>({reference,availability:"available"}));
      if(command === "save_model_connection_key"){keys.set(args.request.change.actionId,args.request.secret);return commit(args.request.change);}
      if(command === "remove_model_connection_key"){keys.delete(args.request.reference);return {reference:args.request.reference,availability:"missing"};}
      if(command === "change_model_connections")return commit(args.request);
      throw new Error(command);
    });
  });
  async function secure(user:ReturnType<typeof userEvent.setup>){await user.selectOptions(screen.getByLabelText(i18n.t("connections.keySource")),"keychain");return screen.findByLabelText(i18n.t("connections.keyInput"));}
  it.each(["en-US","zh-CN"])("saves, rotates, and removes one system key without a model call in %s",async locale=>{
    await i18n.changeLanguage(locale);const user=userEvent.setup();setup();await open(user);await fill(user);const input=await secure(user);
    expect(input).toHaveAttribute("type","password");await user.type(input,"synthetic-A");await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));
    await screen.findByText(i18n.t("connections.notices.saved"));expect(input).toHaveValue("");expect(keys.size).toBe(1);const old=[...keys.keys()][0];
    await user.type(input,"synthetic-B");await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await waitFor(()=>expect(keys.size).toBe(2));
    expect(current.snapshot.profiles[0].connection.credentialReference).not.toBe(old);
    await user.click(screen.getByText(i18n.t("connections.keyHistory")));await user.click(await screen.findByRole("button",{name:i18n.t("connections.keyHistoryRemove",{number:"1"})}));
    await waitFor(()=>expect(keys.has(old)).toBe(false));expect(keys.size).toBe(1);
    await user.click(await screen.findByRole("button",{name:i18n.t("connections.keyRemove")}));await screen.findByText(i18n.t("connections.keyMissing"));expect(keys.size).toBe(0);
    expect(JSON.stringify(current)).not.toContain("synthetic-A");expect(JSON.stringify(current)).not.toContain("synthetic-B");
    expect(invoke.mock.calls.every(([command])=>command.includes("model_connection"))).toBe(true);
  });
  it("clears submitted A immediately but retains a newly typed B after A is acknowledged",async()=>{
    const user=userEvent.setup();setup();await open(user);await fill(user);const input=await secure(user);await user.type(input,"synthetic-A");
    let resolve!:(value:ModelConnectionReceipt)=>void, request!:ModelConnectionChange;const promise=new Promise<ModelConnectionReceipt>(yes=>resolve=yes);
    const normal=invoke.getMockImplementation()!;invoke.mockImplementation(async(command,args)=>{if(command === "save_model_connection_key"){request=args.request.change;return promise;}return normal(command,args);});
    await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await waitFor(()=>expect(request).toBeDefined());expect(input).toHaveValue("");
    await user.type(input,"synthetic-B");await act(async()=>resolve(commit(request)));await screen.findByText(i18n.t("connections.notices.saved-newer-draft"));
    expect(input).toHaveValue("synthetic-B");expect(screen.getByRole("button",{name:i18n.t("connections.save")})).toBeEnabled();
  });
  it("clears unsent secrets on close and when authentication source changes",async()=>{
    const user=userEvent.setup();setup();await open(user);await fill(user);await user.type(await secure(user),"synthetic-unsent");
    await user.click(screen.getByRole("button",{name:i18n.t("connections.close")}));await user.click(screen.getByRole("button",{name:i18n.t("connections.open")}));
    expect(screen.getByLabelText(i18n.t("connections.keyInput"))).toHaveValue("");
    await user.type(screen.getByLabelText(i18n.t("connections.keyInput")),"synthetic-unsent");await user.selectOptions(screen.getByLabelText(i18n.t("connections.keySource")),"environment");
    await secure(user);expect(screen.getByLabelText(i18n.t("connections.keyInput"))).toHaveValue("");
    expect(invoke.mock.calls.filter(([command])=>command === "save_model_connection_key")).toHaveLength(0);
  });
  it("shows recoverable storage failure without reporting saved or retaining the secret",async()=>{
    const user=userEvent.setup();setup();await open(user);await fill(user);const input=await secure(user);await user.type(input,"synthetic-failed");
    const normal=invoke.getMockImplementation()!;invoke.mockImplementation(async(command,args)=>{if(command === "save_model_connection_key")throw {code:"storage-failed",stage:"model-connections",outcome:"rejected",recoveryRequired:false,reason:"api-key-secure-storage"};return normal(command,args);});
    await user.click(screen.getByRole("button",{name:i18n.t("connections.save")}));await screen.findByText(i18n.t("connections.keyWriteFailed"));expect(input).toHaveValue("");
    expect(screen.queryByText(i18n.t("connections.notices.saved"))).not.toBeInTheDocument();expect(current.snapshot.profiles).toHaveLength(0);
    expect(screen.getByLabelText(i18n.t("connections.name"))).toHaveValue("Synthetic A");
  });
});

it("checks status again after an unconfirmed delete and does not display an old available result",async()=>{
  const reference="55555555-5555-4555-8555-555555555555";
  current=makeView([{id:profileId,revision:"1",name:"System fixture",archived:false,connection:{endpoint:"http://127.0.0.1:9/v1/chat/completions",model:"synthetic",credentialEnv:"",credentialReference:reference,tokenField:"max_tokens"}}],"1");
  let available=true;invoke.mockImplementation(async(command,args)=>{
    if(command === "read_model_connections")return structuredClone(current);
    if(command === "read_model_connection_key")return {reference:args.request.reference,availability:available?"available":"missing"};
    if(command === "remove_model_connection_key"){available=false;throw {code:"outcome-unknown",stage:"model-connections",outcome:"unknown",recoveryRequired:true};}
    throw new Error(command);
  });
  const user=userEvent.setup();setup();await user.click(screen.getByRole("button",{name:i18n.t("connections.open")}));await user.click(await screen.findByRole("button",{name:"System fixture"}));
  await user.click(await screen.findByRole("button",{name:i18n.t("connections.keyRemove")}));await screen.findByText(i18n.t("connections.keyMissing"));
  expect(screen.queryByText(i18n.t("connections.keyAvailable"))).not.toBeInTheDocument();expect(screen.queryByText(i18n.t("connections.keyRemoved"))).not.toBeInTheDocument();
  expect(current.snapshot.profiles[0].connection.credentialReference).toBe(reference);
});

it("drops the secret-only dirty marker when closing the actual settings sheet unmounts its editor",async()=>{
  const reference="55555555-5555-4555-8555-555555555555";
  current=makeView([{id:profileId,revision:"1",name:"System fixture",archived:false,connection:{endpoint:"http://127.0.0.1:9/v1/chat/completions",model:"synthetic",credentialEnv:"",credentialReference:reference,tokenField:"max_tokens"}}],"1");
  invoke.mockImplementation(async(command,args)=>{
    if(command === "read_model_connections")return structuredClone(current);
    if(command === "read_model_connection_key")return {reference:args.request.reference,availability:"available"};
    throw new Error(command);
  });
  function ActualSheet(){const [open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>Reopen settings</button>
    <Sheet open={open} onOpenChange={setOpen} title="Application settings" closeLabel="Close settings">
      <ConnectionManager disabled={false} presentation="embedded" visible={open}/>
    </Sheet></>;}
  const user=userEvent.setup();render(<ApplicationReadProvider><ConnectionDraftProvider><ActualSheet/></ConnectionDraftProvider></ApplicationReadProvider>);
  await user.click(await screen.findByRole("button",{name:"System fixture"}));await user.type(await screen.findByLabelText(i18n.t("connections.keyInput")),"synthetic-unsent");
  expect(screen.getByRole("button",{name:i18n.t("connections.save")})).toBeEnabled();await user.click(screen.getByRole("button",{name:"Close settings"}));
  await user.click(await screen.findByRole("button",{name:"Reopen settings"}));expect(await screen.findByLabelText(i18n.t("connections.keyInput"))).toHaveValue("");
  expect(screen.getByRole("button",{name:i18n.t("connections.save")})).toBeDisabled();
});
