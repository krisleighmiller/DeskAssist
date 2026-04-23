import { useEffect, useState } from "react";
import type { ComponentProps } from "react";

import { api } from "../lib/api";
import { useTerminalManager, type TerminalLaneContext } from "../hooks/useTerminalManager";
import { useWorkbenchLayout } from "../hooks/useWorkbenchLayout";
import { ApiKeysDialog } from "./ApiKeysDialog";
import { RightPanel, type RightTabKey } from "./RightPanel";
import { Toolbar } from "./Toolbar";
import { WorkbenchShell } from "./WorkbenchShell";

type ToolbarBaseProps = Omit<
  ComponentProps<typeof Toolbar>,
  "onOpenKeys" | "onToggleTerminal" | "terminalOpen"
>;

type RightPanelBaseProps = Omit<
  ComponentProps<typeof RightPanel>,
  "activeTab" | "onTabChange" | "onCollapse"
>;

export interface AppShellProps {
  toolbar: ToolbarBaseProps;
  workbench: {
    workspaceTitle: string;
    fileTree: ComponentProps<typeof WorkbenchShell>["fileTree"];
    editor: ComponentProps<typeof WorkbenchShell>["editor"];
    rightPanel: RightPanelBaseProps;
  };
  apiKeysDialog: Omit<ComponentProps<typeof ApiKeysDialog>, "onClose">;
  activeLane: TerminalLaneContext | null;
  casefileRoot: string | null;
  /** M2: right-panel tab state is owned by `App` so non-RightPanel
   * surfaces (the FileTree's "Compare with…" action) can switch tabs
   * after triggering an action. The auto-switch effect below still
   * lives here because it reacts to comparison session changes that
   * AppShell already routes through. */
  activeRightTab: RightTabKey;
  onActiveRightTabChange: (tab: RightTabKey) => void;
}

export function AppShell({
  toolbar,
  workbench,
  apiKeysDialog,
  activeLane,
  casefileRoot,
  activeRightTab,
  onActiveRightTabChange,
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
    toggleTerminalOpen,
  } = useTerminalManager({
    activeLane,
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

  // Auto-switch to the chat tab when the focused session becomes a
  // comparison session — comparison chats are only visible inside the
  // chat tab, and a freshly-opened compare-chat would otherwise stay
  // hidden behind whichever tab the user was previously on.
  useEffect(() => {
    const activeSessionId = workbench.rightPanel.chat.activeSessionId;
    if (activeSessionId?.startsWith("compare:")) {
      onActiveRightTabChange("chat");
    }
  }, [workbench.rightPanel.chat.activeSessionId, onActiveRightTabChange]);

  return (
    <div className="app">
      <Toolbar
        {...toolbar}
        onOpenKeys={() => setKeysOpen(true)}
        onToggleTerminal={toggleTerminalOpen}
        terminalOpen={terminalOpen}
      />
      <WorkbenchShell
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
        rightPanel={{
          ...workbench.rightPanel,
          activeTab: activeRightTab,
          onTabChange: onActiveRightTabChange,
        }}
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
