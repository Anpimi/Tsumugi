import { useState, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { WorkbenchNavigation, WorkspaceViewProvider, type WorkspaceArea } from "../WorkbenchFrame";

function WorkbenchTestShell({ children }: { children: ReactNode }) {
  const [area, setArea] = useState<WorkspaceArea>("overview");
  return <WorkspaceViewProvider value={{ area, activate: setArea, deactivate: closing => setArea(current => current === closing ? "overview" : current) }}>
    <WorkbenchNavigation area={area} hasProject disabled={false} onNavigate={setArea} />
    {children}
  </WorkspaceViewProvider>;
}

export function renderWorkbench(ui: ReactNode) {
  const result = render(<WorkbenchTestShell>{ui}</WorkbenchTestShell>);
  const rerender = result.rerender;
  return { ...result, rerender: (next: ReactNode) => rerender(<WorkbenchTestShell>{next}</WorkbenchTestShell>) };
}
