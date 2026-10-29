import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import type { ProjectView } from "../../../projectCommands";
import { SessionReads } from "../../../sessionReads";
import { ProjectLifecycle, type LifecycleParticipant } from "../../platform/projectLifecycle";
import { TranslationDrafts } from "../editor/translationDrafts";
import StrategyOwnerHost from "./StrategyOwnerHost";

const control = vi.hoisted(() => {
  const input: { busy: boolean; pending: { kind: string } | null } = { busy: false, pending: null };
  const owner = { journalSeq: "1", journalDirty: false, current: () => input,
    blocked: () => input.busy, flush: vi.fn<() => Promise<boolean>>() };
  return { input, owner };
});
vi.mock("../../../StrategyDraftSession", () => ({
  StrategyDraftSession: ({ children }: PropsWithChildren) => <>{children}</>,
  useStrategyDraftSession: () => control.owner,
}));
const project: ProjectView = { sessionToken: "strategy-owner", locator: "/synthetic/strategy-owner", reconciliationState: "settled",
  metadata: { projectId: "10000000-0000-4000-8000-000000000001", displayName: "Synthetic strategy", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const disposals: (() => void)[] = [];
beforeEach(() => {
  control.input.busy = false; control.input.pending = null;
  control.owner.journalSeq = "1"; control.owner.journalDirty = false;
  control.owner.flush.mockReset().mockResolvedValue(true);
});
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });
function mount() {
  const lifecycle = new ProjectLifecycle(), reads = new SessionReads({ projectId: project.metadata.projectId, sessionToken: project.sessionToken });
  const drafts = new TranslationDrafts({ context: reads.context, reads });
  let participant: LifecycleParticipant | null = null;
  render(<StrategyOwnerHost project={project} lifecycle={lifecycle} drafts={drafts} onOwner={() => {}} onReveal={() => {}}
    onParticipant={value => { participant = value; }}/>);
  disposals.push(() => { drafts.retire(); reads.retire(); lifecycle.dispose(); });
  function current() { if (!participant) throw new Error("Missing strategy lifecycle participant"); return participant; }
  return { participant: current() };
}
it("retains a locally saved unknown request across view changes and permits project exit without replay", () => {
  control.input.pending = { kind: "start" };
  const { participant } = mount();
  expect(participant.inspect({ kind: "navigate" }).status).toBe("ready");
  expect(participant.inspect({ kind: "close-project" }).status).toBe("ready");
  expect(control.owner.flush).not.toHaveBeenCalled();
});
it("waits for the local write and refuses exit when newer input arrives during it", async () => {
  control.owner.journalDirty = true;
  let finish!: () => void;
  control.owner.flush.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = () => { control.owner.journalDirty = false; resolve(true); }; }));
  const { participant } = mount(), intent = { kind: "close-project" as const };
  expect(participant.inspect(intent).status).toBe("dirty");
  const leaving = participant.prepareLeave(intent, () => true, () => true);
  control.owner.journalSeq = "2"; finish();
  expect(await leaving).toBe(false);
  control.owner.journalDirty = true;
  control.owner.flush.mockImplementationOnce(async () => { control.owner.journalDirty = false; return true; });
  expect(await participant.prepareLeave(intent, () => true, () => true)).toBe(true);
  expect(participant.inspect(intent).status).toBe("ready");
});
