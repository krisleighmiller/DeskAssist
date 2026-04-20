import { useEffect, useState } from "react";
import type { FileTreeNode } from "../types";

interface FileTreeProps {
  root: FileTreeNode | null;
  activePath: string | null;
  hasWorkspace: boolean;
  error: string | null;
  onOpenFile: (path: string) => void;
}

function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.type !== b.type) {
    return a.type === "dir" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

interface NodeProps {
  node: FileTreeNode;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  depth: number;
}

function TreeNode({ node, expanded, toggle, activePath, onOpenFile, depth }: NodeProps): JSX.Element {
  if (node.type === "file") {
    const isActive = activePath === node.path;
    return (
      <div
        className={`tree-row${isActive ? " active" : ""}`}
        style={{ paddingLeft: depth * 10 + 8 }}
        onClick={() => onOpenFile(node.path)}
        title={node.path}
      >
        <span className="twisty"> </span>
        <span className="icon">·</span>
        <span>{node.name}</span>
      </div>
    );
  }
  const isOpen = expanded.has(node.path);
  const sorted = [...(node.children ?? [])].sort(compareNodes);
  return (
    <div>
      <div
        className="tree-row"
        style={{ paddingLeft: depth * 10 + 4 }}
        onClick={() => toggle(node.path)}
        title={node.path}
      >
        <span className="twisty">{isOpen ? "▾" : "▸"}</span>
        <span className="icon">▣</span>
        <span>{node.name}</span>
      </div>
      {isOpen && sorted.length > 0 && (
        <div>
          {sorted.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              expanded={expanded}
              toggle={toggle}
              activePath={activePath}
              onOpenFile={onOpenFile}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  root,
  activePath,
  hasWorkspace,
  error,
  onOpenFile,
}: FileTreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Auto-expand the root whenever a new tree arrives.
  useEffect(() => {
    if (root) {
      setExpanded((prev) => {
        if (prev.has(root.path)) return prev;
        const next = new Set(prev);
        next.add(root.path);
        return next;
      });
    }
  }, [root]);

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  if (error) {
    return <div className="file-tree"><div className="empty">Error: {error}</div></div>;
  }
  if (!hasWorkspace) {
    return (
      <div className="file-tree">
        <div className="empty">No workspace selected. Choose one from the toolbar.</div>
      </div>
    );
  }
  if (!root) {
    return <div className="file-tree"><div className="empty">Loading...</div></div>;
  }

  return (
    <div className="file-tree">
      <TreeNode
        node={root}
        expanded={expanded}
        toggle={toggle}
        activePath={activePath}
        onOpenFile={onOpenFile}
        depth={0}
      />
    </div>
  );
}
