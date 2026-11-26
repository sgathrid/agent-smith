import { stderrClause } from './failure-text.ts';

export interface Answer {
  text(fragment: string, messageKey?: string): void;
  work(): void;
  providerFinal(text: string | undefined, kind: 'authoritative' | 'includes-streamed'): void;
  value(): string;
}

const BOOKKEEPING_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  opencode: new Set(['todowrite']),
  kimi: new Set(['SetTodoList']),
  claude: new Set(['TodoWrite']),
  codex: new Set(['todo_list']),
  agy: new Set(),
};

export function isBookkeepingTool(provider: string, toolName: string): boolean {
  return BOOKKEEPING_TOOLS[provider]?.has(toolName) ?? false;
}

export function emptyResponseVerdict(
  response: string,
  stderr: string,
  options: { status?: 'malformed' | 'denied'; detail?: string } = {},
): { status: 'malformed' | 'denied'; error: string } | undefined {
  if (response.trim() !== '') return undefined;
  return {
    status: options.status ?? 'malformed',
    error: `no output${options.detail ?? ''}${stderrClause(stderr)}`,
  };
}

function unstreamedSuffix(resultText: string, seenBeforeWork: readonly string[]): string {
  let rest = resultText;
  for (const chunk of seenBeforeWork) {
    if (chunk === '') continue;
    const trimmed = rest.trimStart();
    if (trimmed.startsWith(chunk)) {
      rest = trimmed.slice(chunk.length);
    }
  }
  return rest.trim() === '' ? '' : rest.trimStart();
}

export function createAnswer(): Answer {
  let current = '';
  let lastKey: string | undefined;
  let hasMessage = false;
  let explicitlyCleared = false;
  const seenBeforeWork: string[] = [];

  return {
    text(fragment: string, messageKey?: string): void {
      explicitlyCleared = false;
      if (messageKey !== undefined && hasMessage && messageKey === lastKey) {
        current += fragment;
      } else {
        if (current.trim() !== '') seenBeforeWork.push(current);
        current = fragment;
        lastKey = messageKey;
        hasMessage = true;
      }
    },
    work(): void {
      if (current.trim() !== '') seenBeforeWork.push(current);
      current = '';
      lastKey = undefined;
      hasMessage = false;
      explicitlyCleared = false;
    },
    providerFinal(text: string | undefined, kind: 'authoritative' | 'includes-streamed'): void {
      if (text === undefined) return;
      if (text.trim() === '') {
        current = '';
        lastKey = undefined;
        hasMessage = false;
        explicitlyCleared = true;
        return;
      }
      if (kind === 'authoritative') {
        current = text;
        lastKey = undefined;
        hasMessage = true;
        explicitlyCleared = false;
        return;
      }
      if (!explicitlyCleared && current.trim() === '') {
        const suffix = unstreamedSuffix(text, seenBeforeWork);
        if (suffix !== '') {
          current = suffix;
          lastKey = undefined;
          hasMessage = true;
        }
      }
    },
    value(): string {
      return current.trim() === '' ? '' : current;
    },
  };
}
