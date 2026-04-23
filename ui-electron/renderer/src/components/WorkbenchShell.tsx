import type { ComponentProps } from "react";

import {
  TERMINAL_HEIGHT_DEFAULT,
  TERMINAL_HEIGHT_MAX,
  TERMINAL_HEIGHT_MIN,
  WORKBENCH_LEFT_DEFAULT,
  WORKBENCH_LEFT_MAX,
  WORKBENCH_LEFT_MIN,
  WORKBENCH_RIGHT_DEFAULT,
  WORKBENCH_RIGHT_MAX,
  WORKBENCH_RIGHT_MIN,
} from "../hooks/useWorkbenchLayout";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { RightPanel } from "./RightPanel";
import { HorizontalSplitter, Splitter } from "./Splitter";
import { TerminalsPanel } from "./TerminalsPanel";

type FileTreeProps = ComponentProps<typeof FileTree>;
type EditorPaneProps = ComponentProps<typeof EditorPane>;
type RightPanelProps = Omit<ComponentProps<typeof RightPanel>, "onCollapse">;
type TerminalsPanelProps = ComponentProps<typeof TerminalsPanel>;

interface WorkbenchShellProps {
  workspaceTitle: string;
  leftPaneWidth: number;
  leftPaneCollapsed: boolean;
  onShowLeftPane: () => void;
  onToggleLeftPane: () => void;
  onResizeLeftPane: (width: number) => void;
  fileTree: FileTreeProps;
  editor: EditorPaneProps;
  rightPaneWidth: number;
  rightPaneCollapsed: boolean;
  onShowRightPane: () => void;
  onToggleRightPane: () => void;
  onResizeRightPane: (width: number) => void;
  rightPanel: RightPanelProps;
  terminalOpen: boolean;
  terminalHeight: number;
  onResizeTerminal: (height: number) => void;
  terminals: TerminalsPanelProps;
}

export function WorkbenchShell({
  workspaceTitle,
  leftPaneWidth,
  leftPaneCollapsed,
  onShowLeftPane,
  onToggleLeftPane,
  onResizeLeftPane,
  fileTree,
  editor,
  rightPaneWidth,
  rightPaneCollapsed,
  onShowRightPane,
  onToggleRightPane,
  onResizeRightPane,
  rightPanel,
  terminalOpen,
  terminalHeight,
  onResizeTerminal,
  terminals,
}: WorkbenchShellProps): JSX.Element {
  return (
    <div className="workbench-column">
      <div className="workbench">
        {leftPaneCollapsed ? (
          <button
            type="button"
            className="pane-collapsed-rail"
            onClick={onShowLeftPane}
            aria-label="Show workspace panel"
            title="Show workspace panel"
          >
            Files
          </button>
        ) : (
          <>
            <section className="pane" style={{ width: leftPaneWidth }}>
              <header className="pane-header">
                <span className="pane-header-title">{workspaceTitle}</span>
                <button
                  type="button"
                  className="pane-header-action"
                  onClick={onToggleLeftPane}
                  aria-label="Hide workspace panel"
                  title="Hide workspace panel"
                >
                  Hide
                </button>
              </header>
              <div className="pane-body">
                <FileTree {...fileTree} />
              </div>
            </section>
            <Splitter
              width={leftPaneWidth}
              min={WORKBENCH_LEFT_MIN}
              max={WORKBENCH_LEFT_MAX}
              defaultWidth={WORKBENCH_LEFT_DEFAULT}
              side="left"
              onResize={onResizeLeftPane}
              ariaLabel="Resize workspace panel"
            />
          </>
        )}
        <section className="pane editor-pane">
          <EditorPane {...editor} />
        </section>
        {rightPaneCollapsed ? (
          <button
            type="button"
            className="pane-collapsed-rail pane-collapsed-rail-right"
            onClick={onShowRightPane}
            aria-label="Show side panel"
            title="Show side panel"
          >
            Panel
          </button>
        ) : (
          <>
            <Splitter
              width={rightPaneWidth}
              min={WORKBENCH_RIGHT_MIN}
              max={WORKBENCH_RIGHT_MAX}
              defaultWidth={WORKBENCH_RIGHT_DEFAULT}
              side="right"
              onResize={onResizeRightPane}
              ariaLabel="Resize side panel"
            />
            <section className="pane" style={{ width: rightPaneWidth }}>
              <RightPanel {...rightPanel} onCollapse={onToggleRightPane} />
            </section>
          </>
        )}
      </div>
      {terminalOpen && (
        <>
          <HorizontalSplitter
            height={terminalHeight}
            min={TERMINAL_HEIGHT_MIN}
            max={TERMINAL_HEIGHT_MAX}
            defaultHeight={TERMINAL_HEIGHT_DEFAULT}
            onResize={onResizeTerminal}
            ariaLabel="Resize terminal pane"
          />
          <div className="terminal-pane" style={{ height: terminalHeight }}>
            <TerminalsPanel {...terminals} />
          </div>
        </>
      )}
    </div>
  );
}
