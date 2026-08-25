import { useMemo } from 'react';
import {
  useTrueFoundryApprovals,
  useTrueFoundrySandboxId,
  useTrueFoundryToolResponses,
} from '@truefoundry/assistant-ui-runtime';
import { useAuiState } from '@truefoundry/trueforge-ui/assistant-ui';

/**
 * One place that reads agent state, so the rail cannot quietly read the wrong thing.
 *
 * It quietly did, for a while: `useTrueFoundryToolResponses()` sounds like "the tool responses so
 * far" and is actually "ask-user tool calls waiting on an answer". The Did panel was wired to it
 * and could never have shown anything. Real executions live on the assistant messages, as
 * tool-call parts carrying a result.
 */

export type Execution = { toolName: string; output: string; exitCode: number | null };

/** Unwrap the harness envelope: {success, response: {exitCode, result}}. */
function unwrap(result: unknown): { output: string; exitCode: number | null } {
  if (result == null) return { output: '', exitCode: null };
  const value = typeof result === 'string' ? tryParse(result) : result;
  const inner = (value as { response?: unknown })?.response ?? value;
  if (inner && typeof inner === 'object') {
    const o = inner as { exitCode?: unknown; result?: unknown; output?: unknown };
    return {
      exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
      output: String(o.result ?? o.output ?? (typeof value === 'string' ? value : JSON.stringify(inner))),
    };
  }
  return { output: String(value), exitCode: null };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
        const p = part as { type?: string; toolName?: string; result?: unknown };
        // A tool call with no result yet is in flight, not an execution.
        if (p?.type !== 'tool-call' || p.result === undefined) continue;
        found.push({ toolName: p.toolName ?? 'tool', ...unwrap(p.result) });
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
