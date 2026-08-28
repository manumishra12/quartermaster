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

/**
 * How the last turn ended, as assistant-ui records it.
 *
 * `incomplete` carries the interesting part in `reason`: a turn somebody stopped and a turn that
 * failed are both not-running, and calling either of them finished is a small lie in the panel
 * whose entire job is saying what happened.
 */
export type RunStatus = {
  type: 'running' | 'complete' | 'incomplete' | 'requires-action' | 'unknown';
  reason?: string;
};

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
  /**
   * A joined key, not an object: the store compares snapshots by identity, and a selector returning
   * a fresh object every render never settles. This project has already paid for that once with a
   * blank page, and the lesson is written beside the same pattern in ThreadRow.
   */
  const idKey = useAuiState((s: unknown) => {
    try {
      const state = s as { threadListItem?: { remoteId?: string; id?: string }; thread?: { threadId?: string } };
      return [state?.threadListItem?.remoteId, state?.threadListItem?.id, state?.thread?.threadId]
        .filter(Boolean)
        .join('\u0000');
    } catch {
      return '';
    }
  }) as string;
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

  /**
   * The last thing the assistant said, as text.
   *
   * Needed because a model that cannot call tools prints the JSON it would have sent, and that
   * lands in the transcript as a wall of braces - and, worse, as a question the agent appears to
   * be asking that nothing will ever collect an answer to. The rail is where this is named.
   */
  const finalText = useMemo(() => {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i] as { role?: string; content?: unknown };
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part) => (part as { type?: string })?.type === 'text')
        .map((part) => (part as { text?: string }).text ?? '')
        .join('');
      if (text.trim()) return text;
    }
    return '';
  }, [messages]);

  /**
   * The status of the newest assistant message.
   *
   * Without this the rail had only "is the composer busy", so anything not currently running read
   * as Finished - including a turn the user cancelled and a turn that died on a provider error.
   * Both of those had executions behind them, so the panel showed a tidy record of work under a
   * heading that was wrong about how it ended.
   */
  const runStatus = useMemo<RunStatus>(() => {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i] as { role?: string; status?: { type?: string; reason?: string } };
      if (message?.role !== 'assistant') continue;
      const status = message.status;
      if (!status?.type) return { type: 'unknown' };
      return { type: status.type as RunStatus['type'], reason: status.reason };
    }
    return { type: 'unknown' };
  }, [messages]);

  /**
   * Which session this pane is showing, if the runtime will say.
   *
   * Read from more than one path and defensively. The rail renders outside the thread-list item
   * scope, so the field a row reads is not necessarily present here, and the shape is the SDK's to
   * change. An empty list means nothing is recorded against this conversation - which is the right
   * outcome rather than a failure: a verdict filed under the wrong conversation is worse than no
   * verdict, and this is the one product that cannot afford one in the wrong place.
   */
  const sessionIds = useMemo(() => idKey.split('\u0000').filter(Boolean), [idKey]);

  return {
    executions,
    finalText,
    sessionIds,
    runStatus,
    pendingApprovals: approvals?.pending ?? [],
    respondToApproval: approvals?.respond,
    pendingQuestions: questions?.pending ?? [],
    sandboxId,
  };
}
