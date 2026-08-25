import { useMemo } from 'react';
import {
  useTrueFoundryApprovals,
  useTrueFoundrySandboxId,
  useTrueFoundryToolResponses,
} from '@truefoundry/assistant-ui-runtime';
import { useAuiState } from '@truefoundry/trueforge-ui/assistant-ui';
// @ts-expect-error - shared JS module, aliased in vite.config.ts
import { resultOf } from '@evidence';

/**
 * One place that reads agent state, so the rail cannot quietly read the wrong thing.
 *
 * It quietly did, for a while: `useTrueFoundryToolResponses()` sounds like "the tool responses so
 * far" and is actually "ask-user tool calls waiting on an answer". The Did panel was wired to it
 * and could never have shown anything. Real executions live on the assistant messages, as
 * tool-call parts carrying a result.
 */

export type Execution = {
  toolName: string;
  command: string | null;
  output: string;
  exitCode: number | null;
  /** False when the envelope shape was not recognised - an unread result, not an empty one. */
  understood?: boolean;
};

/** Parse a JSON string if it is one, otherwise hand it back. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The executed command, from the tool call's own arguments. */
export function commandOf(args: unknown, toolName?: string): string | null {
  const parsed = typeof args === 'string' ? tryParse(args) : args;
  if (parsed && typeof parsed === 'object') {
    const a = parsed as { command?: unknown; cmd?: unknown; script?: unknown };
    for (const value of [a.command, a.cmd, a.script]) {
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return toolName ?? null;
}

export function useAgentState() {
  const messages = useAuiState(({ thread }) => thread.messages) as unknown;
  const approvals = useTrueFoundryApprovals();
  const questions = useTrueFoundryToolResponses();
  const sandboxId = useTrueFoundrySandboxId();

  const executions = useMemo<Execution[]>(() => {
    const list = Array.isArray(messages) ? messages : [];
    const found: Execution[] = [];
    for (const message of list) {
      const parts = (message as { content?: unknown })?.content;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const p = part as { type?: string; toolName?: string; args?: unknown; result?: unknown };
        // A tool call with no result yet is in flight, not an execution.
        if (p?.type !== 'tool-call' || p.result === undefined) continue;
        /**
         * Parsed by the shared module, not here.
         *
         * There used to be a local `unwrap` beside this line. Sharing `isGreen` was not enough:
         * the rule was shared while the parsing that feeds it was not, so on four real envelope
         * shapes - a snake_case exit code, a numeric-string exit code, an empty `result` masking a
         * populated `output`, and an MCP text-part array - the CLI read FAILED and this panel
         * rendered "Last run passed". The safety surface disagreeing with the verifier, in the
         * direction of reassurance.
         */
        const parsed = resultOf({ content: p.result }, commandOf(p.args, p.toolName)) as Execution;
        found.push({ ...parsed, toolName: p.toolName ?? 'tool' });
      }
    }
    return found;
  }, [messages]);

  return {
    executions,
    pendingApprovals: approvals?.pending ?? [],
    respondToApproval: approvals?.respond,
    pendingQuestions: questions?.pending ?? [],
    sandboxId,
  };
}
