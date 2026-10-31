import { SessionReadProvider, useSessionReads } from "../SessionReadProvider";
import { ApplicationReadProvider } from "../ApplicationReadProvider";
import { ExecutionTaskSession } from "../ExecutionTaskSession";
import { executionContext } from "../executionCommands";
import type { ProjectView } from "../projectCommands";
import { useState, useEffect, isValidElement, type ReactNode } from "react";
import { render, act } from "@testing-library/react";
import { TranslationDraftSession } from "../TranslationDraftSession";
import { McpSharingSession } from "../McpSharingSession";
import { TranslationImportSession } from "../TranslationImportSession";
import { ReviewDraftSession } from "../ReviewDraftSession";
import { SourceDraftSession } from "../SourceDraftSession";
import { ResourceDraftSession } from "../ResourceDraftSession";
import { ArenaDraftSession } from "../ArenaDraftSession";
import { ReleaseDraftSession } from "../ReleaseDraftSession";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "../workbenchCommands";
import type { ChangeScope } from "../sessionReads";
import { installSourceDraftFixture } from "./sourceDraftFixture";

let currentReads: ReturnType<typeof useSessionReads> | undefined;
function ReadControl() {
  const reads = useSessionReads();
  useEffect(() => { currentReads = reads; return () => { if (currentReads === reads) currentReads = undefined; }; }, [reads]);
  return null;
}
/** Synthetic invalidation, independent of native registration and heartbeat timing. */
export async function refreshWorkbenchReads(scopes: ChangeScope[] = ["execution"]) {
  await act(async () => { currentReads?.invalidate(scopes); });
}

export function WorkbenchTestShell({ children, project: retainedProject }: { children: ReactNode; project?: ProjectView }) {
  const [commands] = useState(() => new WorkbenchCommands());
  const project = (isValidElement<{project?: ProjectView}>(children) ? children.props.project : undefined) ?? retainedProject;
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}>
    {project ? <SessionReadProvider key={`${project.metadata.projectId}:${project.sessionToken}`} context={executionContext(project)} bridge={false}><ReadControl/><TranslationDraftSession project={project}><McpSharingSession project={project}><ExecutionTaskSession project={project}><TranslationImportSession project={project}><ReviewDraftSession project={project}><ResourceDraftSession project={project}><SourceDraftSession project={project}><ArenaDraftSession project={project}><ReleaseDraftSession project={project}>{children}</ReleaseDraftSession></ArenaDraftSession></SourceDraftSession></ResourceDraftSession></ReviewDraftSession></TranslationImportSession></ExecutionTaskSession></McpSharingSession></TranslationDraftSession></SessionReadProvider> : children}
  </WorkbenchCommandsProvider></ApplicationReadProvider>;
}

export function renderWorkbench(ui: ReactNode, project?: ProjectView) {
  let currentProject = project ?? (isValidElement<{project?: ProjectView}>(ui) ? ui.props.project : undefined);
  if (currentProject) installSourceDraftFixture();
  const result = render(<WorkbenchTestShell project={currentProject}>{ui}</WorkbenchTestShell>);
  const rerender = result.rerender;
  return { ...result, rerender: (next: ReactNode, nextProject?: ProjectView) => {
    currentProject = nextProject ?? (isValidElement<{project?: ProjectView}>(next) ? next.props.project : undefined) ?? currentProject;
    rerender(<WorkbenchTestShell project={currentProject}>{next}</WorkbenchTestShell>);
  } };
}
