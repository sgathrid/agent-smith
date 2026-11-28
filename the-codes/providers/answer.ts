import { stderrClause } from './failure-text.ts';

export type ProviderFinalKind = 'final-message' | 'run-prose';

export interface Answer {
  text(fragment: string, messageKey?: string): void;
  emptyMessage(): void;
  tool(name: string): void;
  work(): void;
  providerFinal(text: string | undefined, kind: ProviderFinalKind): void;
  value(): string;
  /** The key of the message `value()` came from; undefined when it came from no keyed message or is empty. */
  answerKey(): string | undefined;
}

const BOOKKEEPING_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  opencode: new Set(['todowrite']),
  kimi: new Set(['TodoList']),
  claude: new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']),
  codex: new Set(['todo_list']),
  agy: new Set(['update_steps']),
};

function isBookkeepingTool(provider: string, toolName: string): boolean {
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

export function createAnswer(provider: string): Answer {
  let current = '';
  let lastKey: string | undefined;
  let hasMessage = false;
  let sawText = false;
  let blockedByWork = false;

  function work(): void {
    current = '';
    lastKey = undefined;
    hasMessage = false;
    blockedByWork = true;
  }

  return {
    text(fragment: string, messageKey?: string): void {
      if (fragment === '') return;
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
    tool(name: string): void {
      if (!isBookkeepingTool(provider, name)) work();
    },
    work,
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
        hasMessage = true;
      }
    },
    value(): string {
      return current.trim() === '' ? '' : current;
    },
    answerKey(): string | undefined {
      return current.trim() === '' ? undefined : lastKey;
    },
  };
}
