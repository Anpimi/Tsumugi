import { SessionReadProvider, useSessionReads } from "../SessionReadProvider";
import { ExecutionTaskSession } from "../ExecutionTaskSession";
import { executionContext } from "../executionCommands";
import type { ProjectView } from "../projectCommands";
import { useState, useEffect, useMemo, isValidElement, type ReactNode } from "react";
import { render, act } from "@testing-library/react";
import { WorkbenchNavigation, WorkspaceViewProvider, WorkspaceViewMemory, useWorkspaceViewChanges, type WorkspaceArea } from "../WorkbenchFrame";
import { TranslationDraftSession } from "../TranslationDraftSession";
import { TranslationImportSession } from "../TranslationImportSession";
import { ReviewDraftSession } from "../ReviewDraftSession";
import { SourceDraftSession } from "../SourceDraftSession";
import { ResourceDraftSession } from "../ResourceDraftSession";
import { ArenaDraftSession } from "../ArenaDraftSession";
import { ReleaseDraftSession } from "../ReleaseDraftSession";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "../workbenchCommands";
import type { ChangeScope } from "../sessionReads";

let currentReads: ReturnType<typeof useSessionReads> | undefined;
function ReadControl() {
  const reads = useSessionReads();
  useWorkspaceViewChanges();
  useEffect(() => { currentReads = reads; return () => { if (currentReads === reads) currentReads = undefined; }; }, [reads]);
  return null;
}
/** Synthetic invalidation, independent of native registration and heartbeat timing. */
export async function refreshWorkbenchReads(scopes: ChangeScope[] = ["execution"]) {
  await act(async () => { currentReads?.invalidate(scopes); });
}

function WorkbenchTestShell({ children, project: retainedProject }: { children: ReactNode; project?: ProjectView }) {
  const [area, setArea] = useState<WorkspaceArea>("overview");
  const [commands] = useState(() => new WorkbenchCommands());
  const project = (isValidElement<{project?: ProjectView}>(children) ? children.props.project : undefined) ?? retainedProject;
  const memory = useMemo(() => new WorkspaceViewMemory(), [project?.sessionToken, project?.metadata.projectId]);
  return <WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area, memory, activate: setArea, deactivate: closing => setArea(current => current === closing ? "overview" : current) }}>
    <WorkbenchNavigation area={area} hasProject disabled={false} onNavigate={setArea} />
    {project ? <SessionReadProvider key={`${project.metadata.projectId}:${project.sessionToken}`} context={executionContext(project)} bridge={false}><ReadControl/><TranslationDraftSession project={project}><ExecutionTaskSession project={project}><TranslationImportSession project={project}><ReviewDraftSession project={project}><ResourceDraftSession project={project}><SourceDraftSession project={project}><ArenaDraftSession project={project}><ReleaseDraftSession project={project}>{children}</ReleaseDraftSession></ArenaDraftSession></SourceDraftSession></ResourceDraftSession></ReviewDraftSession></TranslationImportSession></ExecutionTaskSession></TranslationDraftSession></SessionReadProvider> : children}
  </WorkspaceViewProvider></WorkbenchCommandsProvider>;
}

export function renderWorkbench(ui: ReactNode, project?: ProjectView) {
  let currentProject = project ?? (isValidElement<{project?: ProjectView}>(ui) ? ui.props.project : undefined);
  const result = render(<WorkbenchTestShell project={currentProject}>{ui}</WorkbenchTestShell>);
  const rerender = result.rerender;
  return { ...result, rerender: (next: ReactNode, nextProject?: ProjectView) => {
    currentProject = nextProject ?? (isValidElement<{project?: ProjectView}>(next) ? next.props.project : undefined) ?? currentProject;
    rerender(<WorkbenchTestShell project={currentProject}>{next}</WorkbenchTestShell>);
  } };
}
