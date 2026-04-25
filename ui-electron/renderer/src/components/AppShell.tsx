import { useEffect, useState } from "react";
import type { ComponentProps } from "react";

import { api } from "../lib/api";
import { useTerminalManager, type TerminalContext } from "../hooks/useTerminalManager";
import { useWorkbenchLayout } from "../hooks/useWorkbenchLayout";
import { ApiKeysDialog } from "./ApiKeysDialog";
import { RightPanel } from "./RightPanel";
import { Toolbar } from "./Toolbar";
import { WorkbenchShell } from "./WorkbenchShell";

type ToolbarBaseProps = ComponentProps<typeof Toolbar>;

type RightPanelBaseProps = Omit<
  ComponentProps<typeof RightPanel>,
  "onCollapse"
>;

export interface AppShellProps {
  toolbar: ToolbarBaseProps;
  workbench: {
    home: ComponentProps<typeof WorkbenchShell>["home"];
    workspaceTitle: string;
    fileTree: ComponentProps<typeof WorkbenchShell>["fileTree"];
    editor: ComponentProps<typeof WorkbenchShell>["editor"];
    rightPanel: RightPanelBaseProps;
  };
  apiKeysDialog: Omit<ComponentProps<typeof ApiKeysDialog>, "onClose">;
  activeContext: TerminalContext | null;
  casefileRoot: string | null;
}

export function AppShell({
  toolbar,
  workbench,
  apiKeysDialog,
  activeContext,
  casefileRoot,
}: AppShellProps): JSX.Element {
  const {
    leftPaneWidth,
    setLeftPaneWidth,
    rightPaneWidth,
    setRightPaneWidth,
    leftPaneCollapsed,
    setLeftPaneCollapsed,
    rightPaneCollapsed,
    setRightPaneCollapsed,
    toggleLeftPane,
    toggleRightPane,
    terminalOpen,
    setTerminalOpen,
    terminalHeight,
    setTerminalHeight,
  } = useWorkbenchLayout();
  const {
    terminalSessions,
    activeTerminalId,
    handleNewTerminal,
    handleSelectTerminal,
    handleCloseTerminal,
  } = useTerminalManager({
    activeContext,
    casefileRoot,
    setTerminalOpen,
  });
  const [keysOpen, setKeysOpen] = useState(false);

  useEffect(() => {
    const remove = api().onOpenApiKeys(() => setKeysOpen(true));
    return () => {
      remove();
    };
  }, []);

  useEffect(() => {
    const remove = api().onOpenPreferences(() => {
      window.alert("Preferences will be added in a later update.");
    });
    return () => {
      remove();
    };
  }, []);

  useEffect(() => {
    const removeLeft = api().onToggleLeftPanel(toggleLeftPane);
    const removeRight = api().onToggleRightPanel(toggleRightPane);
    return () => {
      removeLeft();
      removeRight();
    };
  }, [toggleLeftPane, toggleRightPane]);

  return (
    <div className="app">
      <Toolbar
        {...toolbar}
      />
      <WorkbenchShell
        home={workbench.home}
        workspaceTitle={workbench.workspaceTitle}
        leftPaneWidth={leftPaneWidth}
        leftPaneCollapsed={leftPaneCollapsed}
        onShowLeftPane={() => setLeftPaneCollapsed(false)}
        onToggleLeftPane={toggleLeftPane}
        onResizeLeftPane={setLeftPaneWidth}
        fileTree={workbench.fileTree}
        editor={workbench.editor}
        rightPaneWidth={rightPaneWidth}
        rightPaneCollapsed={rightPaneCollapsed}
        onShowRightPane={() => setRightPaneCollapsed(false)}
        onToggleRightPane={toggleRightPane}
        onResizeRightPane={setRightPaneWidth}
        rightPanel={workbench.rightPanel}
        terminalOpen={terminalOpen}
        terminalHeight={terminalHeight}
        onResizeTerminal={setTerminalHeight}
        terminals={{
          sessions: terminalSessions,
          activeSessionId: activeTerminalId,
          onSelect: handleSelectTerminal,
          onNew: handleNewTerminal,
          onClose: handleCloseTerminal,
          onClear: () => setTerminalOpen(false),
        }}
      />
      {keysOpen && <ApiKeysDialog {...apiKeysDialog} onClose={() => setKeysOpen(false)} />}
    </div>
  );
}
