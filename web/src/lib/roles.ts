/*
 * Which role a piece of work belongs to, read off the tool calls of the main session (subagent calls are not counted):
 * a spec tool (Notion, Confluence, Google Docs/Drive) is B, a Figma tool is C, a file edit is D, a check (tests, type
 * check, the in-app browser) is E, and the rest (reading, searching, asking) is A. Roles are for display only; the
 * plan's own role (plan_set, a "[C]" tag) comes first, and this backs it up with what was actually done.
 */
import { ROLES, type Role } from './planSet.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'FileChange']);
const HOUSEKEEPING = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch']);
const PLAN_TOOLS = /(?:^|__|\/)(?:plan_step|plan_set)$/;
const MCP = /^(?:mcp__|mcp:)/;
const SPEC_TOOL = /notion|confluence|google_?docs|gdrive|google_?drive/i;
const DESIGN_TOOL = /figma/i;
const BROWSER_TOOL = /^(?:mcp__vibrato__|mcp:vibrato\/)browser_/;
/** Commands that check work rather than do it. */
export const VERIFY_COMMAND = /(?:^|[\s;&|(])(?:npm\s+(?:run\s+)?(?:test|typecheck|lint|check\S*)|pnpm\s+(?:run\s+)?(?:test|typecheck|lint)|yarn\s+(?:test|typecheck|lint)|npx\s+(?:tsc|vitest|jest|playwright\s+test)|tsc(?:\s|$)|node\s+--test|vitest|jest|pytest|go\s+test|cargo\s+test|swift\s+test|xcodebuild\s+test)/;

export interface ToolLike { name: string; input: unknown; isError?: boolean }

/** The role of one main-session tool call, or null for plan bookkeeping. */
export function roleOfTool(t: ToolLike): Role | null {
  if (PLAN_TOOLS.test(t.name) || HOUSEKEEPING.has(t.name)) return null;
  if (EDIT_TOOLS.has(t.name)) return 'D';
  if (BROWSER_TOOL.test(t.name)) return 'E';
  if (MCP.test(t.name) && DESIGN_TOOL.test(t.name)) return 'C';
  if (MCP.test(t.name) && SPEC_TOOL.test(t.name)) return 'B';
  const cmd = (t.input as { command?: unknown } | null)?.command;
  if (t.name === 'Bash' && typeof cmd === 'string' && VERIFY_COMMAND.test(cmd)) return 'E';
  return 'A';
}

/** What a step's work shows per role: the base of its roles and of the evidence line under it. */
export interface RoleEvidence {
  /** Roles seen, in A-E order. */
  roles: Role[];
  spec: number;
  design: number;
  /** Checks run (verify commands, browser tools) and how many failed; whether the last one failed. */
  checks: number;
  checksFailed: number;
  lastCheckFailed: boolean;
}

export function evidenceOf(tools: ToolLike[]): RoleEvidence {
  const seen = new Set<Role>();
  const e: RoleEvidence = { roles: [], spec: 0, design: 0, checks: 0, checksFailed: 0, lastCheckFailed: false };
  for (const t of tools) {
    const r = roleOfTool(t);
    if (!r) continue;
    seen.add(r);
    if (r === 'B') e.spec++;
    if (r === 'C') e.design++;
    if (r === 'E') { e.checks++; if (t.isError) e.checksFailed++; e.lastCheckFailed = !!t.isError; }
  }
  e.roles = ROLES.filter((r) => seen.has(r));
  return e;
}

/** The role a step is shown with: declared, else the most telling role of its work (D > E > C > B > A), marked as guessed. */
export function stepRole(declared: Role | null | undefined, actual: Role[]): { role: Role | null; guessed: boolean } {
  if (declared) return { role: declared, guessed: false };
  for (const r of ['D', 'E', 'C', 'B', 'A'] as const) if (actual.includes(r)) return { role: r, guessed: true };
  return { role: null, guessed: false };
}

/** State of one role chip for a turn. */
export type RoleState = 'unused' | 'planned' | 'running' | 'user' | 'done' | 'failed' | 'stopped';
