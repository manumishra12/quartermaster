import { useCallback, useEffect, useId, useRef } from 'react';
import { useAui, useAuiState } from '@truefoundry/trueforge-ui/assistant-ui';
import { MicIcon, MicOffIcon } from './icons';
import { UNSUPPORTED_REASON, useDictation } from './useDictation';

/**
 * Dictation, in the composer's own right-hand slot.
 *
 * `ComposerRightSection` is a real seam: it is in the SDK's `defaultSlots`, so it is part of the
 * public `overrides` map, its default implementation returns `null`, and `ComposerShell` renders it
 * immediately to the left of the send button. So this is not a control bolted beside the composer -
 * it is the empty space the SDK left for one, and it inherits the composer's own layout.
 *
 * Text reaches the draft through `useAui().composer().setText`, which is what the SDK's own
 * `ComposerContainer` uses, re-exported from `@truefoundry/trueforge-ui/assistant-ui`. No textarea
 * is reached for and no input event is faked, so an SDK that changes how the composer is rendered
 * does not break this.
 */

/**
 * The one fact somebody has to have before they press it.
 *
 * Chrome's speech recognition is not on-device: the browser opens a socket to a Google service,
 * sends the audio, and gets text back. This project's entire argument is that a person should know
 * what is being done on their behalf, so a microphone that shipped audio to a third party without
 * saying so would be the product contradicting itself in its own interface. It is on the tooltip,
 * on the button's accessible description, on the badge while it is running, and in the README.
 */
export const DISCLOSURE =
  'Dictate a message. Recognition is done by the browser, which sends the audio to its speech service - Google, in Chrome. Nothing is transcribed on this machine.';

/**
 * Appended, never substituted. What somebody has already typed is theirs, and a dictation button
 * that silently replaced a half-written prompt would be a data-loss bug wearing a microphone.
 */
export function append(existing: string, heard: string): string {
  if (!heard) return existing;
  if (!existing) return heard;
  return /\s$/.test(existing) ? existing + heard : `${existing} ${heard}`;
}

export function Dictation({ disabled, isRunning }: { disabled: boolean; isRunning: boolean }) {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const describedBy = useId();

  /**
   * Two refs, and they are not the same thing.
   *
   * `live` is whatever is in the composer right now, including the words this control has just put
   * there. `base` is the text dictation started from, extended once per committed phrase. Interim
   * words are drawn against `base` and overwritten as they are revised, which is why the composer
   * moves while somebody is speaking instead of stuttering out every partial guess.
   */
  const live = useRef(composerText);
  live.current = composerText;
  const base = useRef('');

  const write = useCallback(
    (next: string) => {
      try {
        aui.composer().setText(next);
      } catch {
        // A runtime that cannot take text must not blank the page - the same rule QuickActions
        // follows, and for the same reason: this is a chat box, not a load-bearing transaction.
      }
    },
    [aui],
  );

  const { status, reason, start, stop } = useDictation({
    onInterim: (heard) => write(append(base.current, heard)),
    onFinal: (heard) => {
      base.current = append(base.current, heard);
      write(base.current);
    },
  });

  const listening = status === 'listening';
  const unsupported = status === 'unsupported';

  useEffect(() => {
    /**
     * Stop when the draft goes.
     *
     * `isRunning` is the SDK telling this slot that the composer is busy, which is what sending
     * looks like from in here. A microphone still live after send is a microphone recording the
     * room while the agent works, and its owner has already stopped thinking about it.
     */
    if (isRunning || disabled) stop();
  }, [isRunning, disabled, stop]);

  /**
   * Pressed to start, pressed again to stop. Never bound to a key, and it never sends.
   *
   * Holding a button down while speaking is unworkable in a text box somebody is also reading, so
   * this is a toggle rather than a literal hold-to-talk. What it is not is an instruction: voice is
   * an input method, the composer fills, and the person still presses send. That is the same rule
   * that keeps allow and deny off the keyboard here - a surface that acted on a sound in the room
   * would have acted before anybody read what it was acting on.
   */
  const toggle = () => {
    if (unsupported || disabled) return;
    if (listening) {
      stop();
      return;
    }
    // Read once, here: everything the person had typed before they pressed the button.
    base.current = live.current;
    start();
  };

  const label = unsupported
    ? `Dictation unavailable. ${UNSUPPORTED_REASON}`
    : listening
      ? 'Stop dictating'
      : 'Dictate a message';

  /**
   * The live region is announced; the badge beside it is not. Both say the same thing, so marking
   * the visible one `aria-hidden` is what stops a screen reader saying it twice.
   */
  const announcement = listening
    ? 'Listening. Your microphone is live and the audio is going to your browser speech service.'
    : reason;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/*
       * Mounted in every state, empty when there is nothing to say.
       *
       * A live region inserted at the same moment as its first text is routinely not announced at
       * all: assistive technology has to be watching the node before the node changes.
       */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>

      <span id={describedBy} className="sr-only">
        {DISCLOSURE}
      </span>

      {listening ? (
        <span
          aria-hidden="true"
          className="inline-flex items-center gap-1.5 rounded-full bg-accent-wash px-2 py-0.5 text-2xs font-[550] text-accent"
        >
          <span className="qm-steps-pulse" />
          Listening
        </span>
      ) : status === 'error' ? (
        <span aria-hidden="true" title={reason} className="max-w-[13rem] truncate text-2xs text-failed">
          {reason}
        </span>
      ) : (
        !unsupported && (
          /*
           * Said in the interface, not only in a tooltip. The tooltip is the stated minimum and it
           * is still there, but somebody who never hovers would never have read it - and on a
           * touchscreen nobody hovers at all, which is exactly where a microphone button is easiest
           * to press without thinking. The composer row wraps, so this takes a line of its own on a
           * narrow screen rather than squeezing the send button.
           */
          <span aria-hidden="true" className="text-2xs text-muted">
            Audio leaves this machine
          </span>
        )
      )}

      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-describedby={describedBy}
        aria-pressed={listening}
        /*
         * `aria-disabled` rather than the `disabled` attribute, on purpose. A disabled button is
         * removed from the tab order, so the one group who most need the reason - people who never
         * see a tooltip - are the only ones who could never reach it.
         */
        aria-disabled={unsupported || disabled || undefined}
        title={unsupported ? UNSUPPORTED_REASON : DISCLOSURE}
        className={[
          'qm-tap inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
          'transition-colors duration-200',
          unsupported || disabled
            ? 'cursor-not-allowed text-muted opacity-50'
            : listening
              ? 'cursor-pointer bg-accent-wash text-accent'
              : status === 'error'
                ? 'cursor-pointer text-failed hover:bg-raised'
                : 'cursor-pointer text-muted hover:bg-raised hover:text-ink',
        ].join(' ')}
      >
        {unsupported ? <MicOffIcon /> : <MicIcon />}
      </button>
    </div>
  );
}
