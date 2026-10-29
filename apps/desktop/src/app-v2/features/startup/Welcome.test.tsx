import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { InteractionGate } from "../../workspace/interactionGate";
import Welcome from "./Welcome";

afterEach(cleanup);
const recent = [{ locator: "/synthetic/projects/Recent project", lastOpenedAt: 1_700_000_000_000 }];
function fixture(blocked = false) {
  const gate = new InteractionGate(), onOpen = vi.fn(), onChoose = vi.fn(), onManual = vi.fn(), onOpenExisting = vi.fn();
  const tree = (locked = blocked) => <Welcome recent={recent} restoreCandidate={{ locator: "/synthetic/older-project", lastOpenedAt: 1 }} native blocked={locked} gate={gate}
    onOpen={onOpen} onChoose={onChoose} onManual={onManual} onOpenExisting={onOpenExisting}/>;
  const rendered = render(tree()); return { ...rendered, tree, gate, onOpen, onChoose, onManual, onOpenExisting };
}
it.each(["en-US", "zh-CN"] as const)("shows the folder preparation and real recent time in %s without automatically opening or using browser files", async locale => {
  await i18n.changeLanguage(locale); const h = fixture();
  expect(screen.getByText(locale === "en-US" ? "Drop a game, Mod or subtitle folder here" : "把游戏、Mod 或字幕文件夹拖到这里")).toBeVisible();
  expect(h.onOpen).not.toHaveBeenCalled();
  const time = h.container.querySelector("time"); expect(time).toHaveAttribute("datetime", new Date(recent[0].lastOpenedAt).toISOString());
  fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [{ path: "/untrusted/browser/path" }] } });
  expect(h.onChoose).not.toHaveBeenCalled(); expect(h.onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.chooseAndPrepare") }));
  expect(h.onChoose).toHaveBeenCalledOnce();
  await act(async () => { await i18n.changeLanguage(locale === "en-US" ? "zh-CN" : "en-US"); });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.openExisting") })); expect(h.onOpenExisting).toHaveBeenCalledOnce();
});
it("continues the last project only on an unclaimed Enter outside dialogs, controls and composition", async () => {
  await i18n.changeLanguage("en-US"); const h = fixture();
  fireEvent.keyDown(document.body, { key: "Enter", isComposing: true }); fireEvent.keyDown(document.body, { key: "Enter", keyCode: 229 });
  const release = h.gate.pushDialog("another-dialog"); fireEvent.keyDown(document.body, { key: "Enter" }); release();
  fireEvent.keyDown(screen.getByRole("button", { name: i18n.t("startup.openExisting") }), { key: "Enter" });
  expect(h.onOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "Enter" }); expect(h.onOpen).toHaveBeenCalledExactlyOnceWith(recent[0].locator);
  h.rerender(h.tree(true)); fireEvent.keyDown(document.body, { key: "Enter" }); expect(h.onOpen).toHaveBeenCalledOnce();
});
