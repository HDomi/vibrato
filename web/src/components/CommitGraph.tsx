import { useMemo } from 'react';
import type { GitCommit } from '../lib/api';
import { GRAPH_COLORS, GRAPH_ROW_HEIGHT, graphX, layoutGitGraph, type GraphEdge } from '../lib/gitGraph';

function edgePath(edge: GraphEdge) {
  const x1 = graphX(edge.from), x2 = graphX(edge.to);
  const middle = GRAPH_ROW_HEIGHT / 2;
  if (edge.half === 'top') return `M ${x1} 0 V ${middle}`;
  if (edge.half === 'bottom') return `M ${x1} ${middle} C ${x1} ${middle + 20}, ${x2} ${middle + 20}, ${x2} ${GRAPH_ROW_HEIGHT}`;
  return `M ${x1} 0 C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${GRAPH_ROW_HEIGHT}`;
}

export default function CommitGraph({ commits, selected, onSelect }: { commits: GitCommit[]; selected?: string | null; onSelect?: (commit: GitCommit) => void }) {
  const graph = useMemo(() => layoutGitGraph(commits), [commits]);
  return (
    <div className="py-1">
      {commits.map((commit, i) => {
        const row = graph.rows[i];
        const current = commit.refs.some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> '));
        return (
          <div key={commit.hash} onClick={onSelect ? () => onSelect(commit) : undefined}
            className={`group flex border-b border-white/[0.035] transition-colors hover:bg-white/[0.035] ${onSelect ? 'cursor-pointer' : ''} ${selected === commit.hash ? 'bg-blue-500/15' : current ? 'bg-violet-400/[0.045]' : ''}`}
            style={{ height: GRAPH_ROW_HEIGHT, minWidth: graph.width + 180 }}>
            <svg aria-hidden="true" width={graph.width} height={GRAPH_ROW_HEIGHT} className="shrink-0 overflow-visible">
              {row.edges.map((edge, j) => <path key={j} d={edgePath(edge)} fill="none" stroke={GRAPH_COLORS[edge.color]} strokeWidth="1.6" opacity="0.65" />)}
              {current && <circle cx={graphX(row.lane)} cy={GRAPH_ROW_HEIGHT / 2} r="9" fill={GRAPH_COLORS[row.color]} opacity="0.12" />}
              <circle cx={graphX(row.lane)} cy={GRAPH_ROW_HEIGHT / 2} r={commit.parents.length > 1 ? 4.5 : 3.5}
                fill={current ? GRAPH_COLORS[row.color] : '#0b0d12'} stroke={GRAPH_COLORS[row.color]} strokeWidth="2" />
            </svg>
            <div className="min-w-0 flex-1 flex flex-col justify-center gap-1 pr-3 pl-1">
              {commit.refs.length > 0 && <div className="flex items-center gap-1 overflow-hidden">
                {commit.refs.map((ref) => {
                  const head = ref === 'HEAD' || ref.startsWith('HEAD -> ');
                  const tag = ref.startsWith('tag: ');
                  return <span key={ref} title={ref}
                    className={`max-w-[180px] truncate rounded border px-1.5 py-px text-[9px] font-medium ${head ? 'border-violet-400/25 bg-violet-400/15 text-violet-200' : tag ? 'border-amber-400/20 bg-amber-400/10 text-amber-200' : 'border-sky-400/20 bg-sky-400/10 text-sky-200'}`}>
                    {head ? `● ${ref.replace('HEAD -> ', '')}` : tag ? ref.slice(5) : ref}
                  </span>;
                })}
              </div>}
              <div className="truncate text-[12px] font-medium text-zinc-200 group-hover:text-white" title={commit.subject}>{commit.subject}</div>
              <div className="flex min-w-0 items-center gap-2 text-[10px] text-zinc-500">
                <span className="shrink-0 font-mono text-violet-300/75" title={commit.hash}>{commit.hash.slice(0, 7)}</span>
                <span className="truncate" title={commit.author}>{commit.author}</span>
                <span className="ml-auto shrink-0 tabular-nums text-zinc-600">{commit.date}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
