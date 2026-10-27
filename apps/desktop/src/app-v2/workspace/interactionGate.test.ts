import { describe, expect, it } from "vitest";
import { InteractionGate } from "./interactionGate";

describe("workspace input ownership", () => {
  it("rejects a hidden editor, composition and a dialog underneath another dialog", () => {
    const gate = new InteractionGate();
    gate.setVisibleOwner("one");
    gate.setInputOwner("one", "editor-a");
    expect(gate.canDispatch({ viewId: "one", source: "keyboard", inputOwner: "editor-a" })).toBe(true);
    expect(gate.canDispatch({ viewId: "two", source: "keyboard", inputOwner: "editor-a" })).toBe(false);
    expect(gate.canDispatch({ viewId: "one", source: "keyboard", inputOwner: "editor-b" })).toBe(false);
    gate.setComposing("editor-a", true);
    expect(gate.canDispatch({ viewId: "one", source: "button" })).toBe(false);
    gate.setComposing("editor-a", false);
    const closeFirst = gate.pushDialog("first");
    const closeSecond = gate.pushDialog("second");
    expect(gate.canDispatch({ viewId: "one", source: "palette", dialogId: "first" })).toBe(false);
    expect(gate.canDispatch({ viewId: "one", source: "palette", dialogId: "second" })).toBe(true);
    closeFirst();
    expect(gate.getSnapshot().dialogs).toEqual(["second"]);
    closeSecond();
    expect(gate.canDispatch({ viewId: "one", source: "button" })).toBe(true);
  });

  it("keeps one navigation intent and invalidates it when composition starts", () => {
    const gate = new InteractionGate();
    gate.setVisibleOwner("one");
    const intent = gate.acquireIntent("navigate");
    expect(intent?.current()).toBe(true);
    expect(gate.acquireIntent("close-view")).toBeNull();
    gate.setComposing("editor", true);
    gate.setComposing("editor", false);
    expect(intent?.current()).toBe(false);
    intent?.release();
    const next = gate.acquireIntent("navigate");
    gate.setVisibleOwner("two");
    expect(next?.current()).toBe(false);
    next?.release();
    gate.dispose();
    expect(gate.acquireIntent("navigate")).toBeNull();
  });

  it("owns an editor with no open view without admitting a hidden or stale view", () => {
    const gate = new InteractionGate();
    gate.setInputOwner("closed-view", "hidden-editor");
    expect(gate.getSnapshot().inputOwner).toBeNull();
    gate.setInputOwner(null, "segment-editor-recovery");
    expect(gate.getSnapshot()).toMatchObject({ visibleViewId: null, inputOwner: { viewId: null, ownerId: "segment-editor-recovery" } });
    const close = gate.pushDialog("draft-recovery");
    expect(gate.canDispatch({ viewId: null, source: "keyboard", inputOwner: "segment-editor-recovery", dialogId: "draft-recovery" })).toBe(true);
    expect(gate.canDispatch({ viewId: "closed-view", source: "keyboard", inputOwner: "segment-editor-recovery", dialogId: "draft-recovery" })).toBe(false);
    close(); gate.setVisibleOwner("new-view");
    expect(gate.getSnapshot().inputOwner).toBeNull();
    gate.setInputOwner(null, "stale-recovery-editor");
    expect(gate.getSnapshot().inputOwner).toBeNull();
  });
});
