import type { TaskInfo } from './agent';

/** One box of the task relation graph: the session at the top, every task it (or a task) spawned below. */
export interface GraphNode {
  id: string;
  /** 'root' for the parent session; else the task. */
  task: TaskInfo | null;
  depth: number;
  /** Top-left corner in graph units. */
  x: number;
  y: number;
}

export interface GraphEdge { from: string; to: string }

export interface GraphLayout { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number }

export const NODE_W = 172;
export const NODE_H = 46;
/** Horizontal distance between depth columns (edge length). */
const GAP_X = 40;
/** Vertical distance between sibling rows. */
const GAP_Y = 10;

export const ROOT_ID = '__session__';

/**
 * Tidy left-to-right tree (what `graph LR` in mermaid draws): the session sits at the left, each
 * depth is one column to the right, leaves take one row each in start order and a parent is
 * centred beside its children. Breadth grows down (scrolls), depth grows right (rarely past 3),
 * which fits the wide, short popover above the composer. A task whose parent is unknown (ended
 * before we saw it, or launched by a teammate) hangs off the session root so nothing is lost.
 */
export function layoutTaskTree(tasks: TaskInfo[]): GraphLayout {
  const known = new Set(tasks.map((t) => t.id));
  const children = new Map<string, TaskInfo[]>();
  for (const t of tasks) {
    const parent = t.parentId && known.has(t.parentId) && t.parentId !== t.id ? t.parentId : ROOT_ID;
    const l = children.get(parent) ?? [];
    l.push(t);
    children.set(parent, l);
  }
  for (const l of children.values()) l.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let maxDepth = 0;
  // Leaf rows are handed out top to bottom; a parent's row is the middle of its children's span.
  let nextRow = 0;
  const seen = new Set<string>();
  const place = (id: string, task: TaskInfo | null, depth: number): number => {
    seen.add(id);
    maxDepth = Math.max(maxDepth, depth);
    const kids = (children.get(id) ?? []).filter((k) => !seen.has(k.id));
    let row: number;
    if (!kids.length) row = nextRow++;
    else {
      const rows = kids.map((k) => { edges.push({ from: id, to: k.id }); return place(k.id, k, depth + 1); });
      row = (rows[0] + rows[rows.length - 1]) / 2;
    }
    nodes.push({ id, task, depth, x: depth * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) });
    return row;
  };
  place(ROOT_ID, null, 0);
  // Keep parents before children for a natural tab / paint order.
  nodes.sort((a, b) => a.depth - b.depth || a.y - b.y);
  return { nodes, edges, width: (maxDepth + 1) * (NODE_W + GAP_X) - GAP_X, height: Math.max(nextRow, 1) * (NODE_H + GAP_Y) - GAP_Y };
}

/**
 * What the relation graph shows: tasks still running, failed or stopped. A completed task drops out,
 * unless something it spawned is still shown, so a parent stays until all of its children are done.
 */
export function visibleTasks(tasks: TaskInfo[]): TaskInfo[] {
  const children = new Map<string, TaskInfo[]>();
  for (const t of tasks) if (t.parentId && t.parentId !== t.id) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  const keep = new Map<string, boolean>();
  const shown = (t: TaskInfo): boolean => {
    const known = keep.get(t.id);
    if (known !== undefined) return known;
    keep.set(t.id, t.status !== 'completed'); // provisional, guards against a parent cycle
    const v = t.status !== 'completed' || (children.get(t.id) ?? []).some(shown);
    keep.set(t.id, v);
    return v;
  };
  return tasks.filter(shown);
}

/** Short label for a chip or node: the agent type for subagents, else what kind of task it is. */
export function taskKind(t: TaskInfo): string {
  if (t.subagentType) return t.subagentType;
  switch (t.type) {
    case 'local_agent': return 'agent';
    case 'local_bash': return 'shell';
    case 'local_workflow': return 'workflow';
    case 'monitor': return 'monitor';
    case 'mcp_task': return 'mcp';
    default: return t.type.replace(/^local_/, '');
  }
}

/** Compact "1.2k" / "35k" token count. */
export function shortTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
