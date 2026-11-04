/*
 * The plan as written in the reply (Settings > "Always plan" asks for it, and it is the only plan when an agent
 * has no task-list tool): a "Plan" / "진행 계획" line followed by a numbered list, then "✓ 2. how it was done"
 * as each step finishes, and a "Result:" / "결과:" line at the end.
 */
const PLAN_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:진행\s*계획|계획|plan)\s*(?:\*\*|__)?\s*[:：]?\s*(?:\*\*)?\s*$/i;
const PLAN_ITEM = /^\s*(\d{1,2})[.)]\s+(.+?)\s*$/;
const DONE_MARK = /^\s*(?:[-*]\s+)?(?:✓|✔|✅|☑|\[x\])\s*(\d{1,2})\s*[.):]?\s*(.*)$/i;
const DONE_AFTER = /^\s*(\d{1,2})[.)]\s*(?:✓|✔|✅)\s*(.*)$/;
const RESULT_LINE = /^\s*(?:#{1,6}\s*)?(?:[-*]\s+)?(?:\*\*|__)?\s*(?:최종\s*)?(?:결과|result)\s*(?:\*\*|__)?\s*[:：]\s*(.*)$/i;
const plainLine = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

/** The last numbered list under a plan heading in these messages. */
export function textPlan(texts: string[]): string[] | null {
  let found: string[] | null = null;
  for (const text of texts) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!PLAN_HEAD.test(lines[i])) continue;
      const steps: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(PLAN_ITEM);
        if (m && !DONE_AFTER.test(lines[j])) { steps[Number(m[1]) - 1] = plainLine(m[2]); continue; }
        if (!lines[j].trim() && !steps.length) continue;
        if (!lines[j].trim() || /^\s{2,}\S/.test(lines[j])) continue; // blank lines and indented details inside the list
        break;
      }
      const list = steps.filter(Boolean);
      if (list.length >= 2) found = list;
    }
  }
  return found;
}

/** "✓ 2. how" lines: step number (1-based) -> how it was done. */
export function doneMarks(texts: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const m = line.match(DONE_MARK) ?? line.match(DONE_AFTER);
      if (m) out.set(Number(m[1]), plainLine(m[2]));
    }
  }
  return out;
}

/** What follows the last "Result:" marker: its line, or with more lines under it, all of it (markdown). */
export function resultOf(texts: string[]): { text: string; full: boolean } | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const lines = texts[i].split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      const m = lines[j].match(RESULT_LINE);
      if (!m) continue;
      const head = m[1].replace(/^(?:\*\*|__)\s*/, '').trim();
      const body = lines.slice(j + 1).join('\n').trim();
      if (body && (!head || body.includes('\n'))) return { text: head ? `${head}\n\n${body}` : body, full: true };
      const rest = plainLine(head) || plainLine(body);
      if (rest) return { text: rest, full: false };
    }
  }
  return null;
}
