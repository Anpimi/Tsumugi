import { SessionReadProvider, useSessionReads } from "../SessionReadProvider";
import { executionContext } from "../executionCommands";
import type { ProjectView } from "../projectCommands";
import { useState, useEffect, isValidElement, type ReactNode } from "react";
import { render, act } from "@testing-library/react";
import { WorkbenchNavigation, WorkspaceViewProvider, type WorkspaceArea } from "../WorkbenchFrame";

let currentReads: ReturnType<typeof useSessionReads> | undefined;
function ReadControl() {
  const reads = useSessionReads();
  useEffect(() => { currentReads = reads; return () => { if (currentReads === reads) currentReads = undefined; }; }, [reads]);
  return null;
}
/** Synthetic invalidation, independent of native registration and heartbeat timing. */
export async function refreshWorkbenchReads() { await act(async () => { currentReads?.invalidate(["execution"]); }); }

function WorkbenchTestShell({ children }: { children: ReactNode }) {
  const [area, setArea] = useState<WorkspaceArea>("overview");
  const project = isValidElement<{project?: ProjectView}>(children) ? children.props.project : undefined;
  return <WorkspaceViewProvider value={{ area, activate: setArea, deactivate: closing => setArea(current => current === closing ? "overview" : current) }}>
    <WorkbenchNavigation area={area} hasProject disabled={false} onNavigate={setArea} />
    {project ? <SessionReadProvider key={project.sessionToken} context={executionContext(project)} bridge={false}><ReadControl/>{children}</SessionReadProvider> : children}
  </WorkspaceViewProvider>;
}

export function renderWorkbench(ui: ReactNode) {
  const result = render(<WorkbenchTestShell>{ui}</WorkbenchTestShell>);
  const rerender = result.rerender;
  return { ...result, rerender: (next: ReactNode) => rerender(<WorkbenchTestShell>{next}</WorkbenchTestShell>) };
}
