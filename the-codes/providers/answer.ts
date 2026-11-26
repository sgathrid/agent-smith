import { stderrClause } from './failure-text.ts';

export type ProviderFinalKind = 'final-message' | 'run-prose';

export interface Answer {
  text(fragment: string, messageKey?: string): void;
  emptyMessage(): void;
  work(): void;
  providerFinal(text: string | undefined, kind: ProviderFinalKind): void;
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

export function createAnswer(): Answer {
  let current = '';
  let lastKey: string | undefined;
  let hasMessage = false;
  let sawText = false;
  let blockedByWork = false;

  return {
    text(fragment: string, messageKey?: string): void {
      sawText = true;
      if (messageKey !== undefined && hasMessage && messageKey === lastKey) {
        current += fragment;
      } else {
        current = fragment;
        lastKey = messageKey;
        hasMessage = true;
      }
      if (current.trim() !== '') blockedByWork = false;
    },
    emptyMessage(): void {
      sawText = true;
      current = '';
      lastKey = undefined;
      hasMessage = false;
    },
    work(): void {
      current = '';
      lastKey = undefined;
      hasMessage = false;
      blockedByWork = true;
    },
    providerFinal(text: string | undefined, kind: ProviderFinalKind): void {
      if (text === undefined) return;
      if (text.trim() === '') {
        current = '';
        lastKey = undefined;
        hasMessage = false;
        return;
      }
      if (!sawText) {
        current = text;
        lastKey = undefined;
        hasMessage = true;
        return;
      }
      if (blockedByWork) return;
      if (current.trim() !== '' && kind === 'final-message') {
        current = text;
        lastKey = undefined;
        hasMessage = true;
      }
    },
    value(): string {
      return current.trim() === '' ? '' : current;
    },
  };
}
