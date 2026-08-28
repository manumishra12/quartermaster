import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Dictation on the Web Speech API, and the two things that are honest to say about it.
 *
 * It was chosen because it needs no dependency, no account and no key. A project whose whole claim
 * is that a stranger can clone it and watch it work cannot ship a microphone that first wants a
 * transcription vendor's credentials.
 *
 * What that costs is where the audio goes. Chrome does not recognise speech on the machine: it
 * streams the microphone to a Google service and streams text back. So this is not local, and the
 * interface has to say so before anybody presses the button rather than in a changelog afterwards.
 * The sentence lives beside the control in `Dictation.tsx`; this file's job is to make the states
 * that sentence describes real - including the two that are only ever bad news.
 *
 * It is also not universal. `SpeechRecognition` is Chrome and Edge; Firefox and Safari do not
 * implement it at all. An unsupported browser gets a control that says it cannot, never one that
 * looks live and does nothing.
 */

/**
 * The slice of the API this touches.
 *
 * TypeScript's DOM library ships `SpeechRecognitionResultList` and the result types but not the
 * recogniser itself, and the vendor-prefixed constructor is in no library at all. Declaring the
 * three methods and three handlers used here is smaller than a dependency and states exactly what
 * this code leans on, so an SDK or a browser that changes anything else cannot break it quietly.
 */
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechCapableWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

/**
 * Read when it is asked for, never captured at module load.
 *
 * Capturing it at import time would decide support before a test could install one, and would also
 * be wrong in a browser that only defines the prefixed name.
 */
export function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const capable = window as SpeechCapableWindow;
  return capable.SpeechRecognition ?? capable.webkitSpeechRecognition;
}

export type DictationStatus = 'unsupported' | 'idle' | 'listening' | 'error';

export const UNSUPPORTED_REASON =
  'This browser has no speech recognition. Chrome and Edge have it; Firefox and Safari do not.';

/**
 * What went wrong, in words somebody can act on.
 *
 * The failure this prevents is a microphone that stops and explains nothing: a person cannot tell
 * a refused permission from a broken button, so they press it again, and again.
 */
const REASONS: Record<string, string> = {
  'not-allowed': 'Microphone permission was refused. Allow it in your browser settings and try again.',
  'service-not-allowed': 'The browser refused its speech service for this page.',
  'audio-capture': 'No microphone was found.',
  network: 'The speech service could not be reached.',
  'no-speech': 'Nothing was heard.',
};

export type Dictation = {
  status: DictationStatus;
  /** Empty unless there is something a person needs telling. */
  reason: string;
  start: () => void;
  stop: () => void;
};

export function useDictation(handlers: {
  /** Called as the words arrive, so the composer moves while somebody is still speaking. */
  onInterim: (text: string) => void;
  /** Called once the service has committed a phrase and will not revise it. */
  onFinal: (text: string) => void;
}): Dictation {
  /**
   * Held in a ref for the same reason the shortcut handlers are: a caller passes an object literal,
   * which is a new identity on every render. With that in a dependency array the recogniser would
   * be torn down and rebuilt mid-sentence, and the sentence would be lost.
   */
  const latest = useRef(handlers);
  latest.current = handlers;

  const [supported] = useState(() => speechRecognitionConstructor() !== undefined);
  const [status, setStatus] = useState<DictationStatus>(supported ? 'idle' : 'unsupported');
  const [reason, setReason] = useState(supported ? '' : UNSUPPORTED_REASON);

  const recognition = useRef<SpeechRecognitionLike | null>(null);

  /**
   * Let the microphone go, now, and make sure nothing it says afterwards is listened to.
   *
   * `abort` rather than `stop`, and the difference is the whole point: `stop` asks the service for
   * one last result, which arrives after the component has gone and lands in a composer that no
   * longer exists. Handlers are detached first because `abort` itself fires `onend`.
   */
  const release = useCallback(() => {
    const live = recognition.current;
    recognition.current = null;
    if (!live) return;
    live.onresult = null;
    live.onerror = null;
    live.onend = null;
    try {
      live.abort();
    } catch {
      // A recogniser the browser has already torn down is not news.
    }
  }, []);

  const stop = useCallback(() => {
    const live = recognition.current;
    // Optimistic, and deliberately not waiting for `onend`: the indicator saying the microphone is
    // live must go out the moment somebody asks for it to, not one network round trip later.
    setStatus((was) => (was === 'listening' ? 'idle' : was));
    if (!live) return;
    try {
      live.stop();
    } catch {
      release();
    }
  }, [release]);

  const start = useCallback(() => {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setStatus('unsupported');
      setReason(UNSUPPORTED_REASON);
      return;
    }

    // Never two live recognisers. A second `start()` on a running one throws, and a second
    // instance would hold the microphone open after the first is forgotten.
    release();

    const next = new Recognition();
    // Until the person presses stop, rather than until the first pause. A dictated prompt has
    // pauses in it, and a recogniser that ends at the first one turns a sentence into a fragment.
    next.continuous = true;
    next.interimResults = true;

    next.onresult = (event) => {
      let settled = '';
      let pending = '';
      // From `resultIndex`, because `results` accumulates across the session and re-reading it from
      // zero would append every phrase again on every event.
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const heard = result?.[0]?.transcript ?? '';
        if (result?.isFinal) settled += heard;
        else pending += heard;
      }
      // Committed first: what is still being said has to be measured from the text the committed
      // phrase just added, or the two overlap and the composer stutters.
      if (settled.trim()) latest.current.onFinal(settled.trim());
      latest.current.onInterim(pending.trim());
    };

    next.onerror = (event) => {
      // We caused this one, by calling `abort`. Reporting it would turn every clean stop into an
      // error the person has to read and dismiss.
      if (event.error === 'aborted') return;
      setStatus('error');
      setReason(REASONS[event.error] ?? `Dictation stopped: ${event.error}.`);
    };

    next.onend = () => {
      recognition.current = null;
      // Only from listening: an error has already said what happened and must not be overwritten
      // by the `onend` that follows it.
      setStatus((was) => (was === 'listening' ? 'idle' : was));
    };

    recognition.current = next;
    // Set before starting, so a `start()` that fails synchronously - which is how a denied
    // permission arrives in some builds - has the last word rather than the first.
    setStatus('listening');
    setReason('');
    try {
      next.start();
    } catch {
      recognition.current = null;
      setStatus('error');
      setReason('Dictation could not start.');
    }
  }, [release]);

  useEffect(() => {
    /**
     * Two ways a live microphone gets left behind, and both are covered here.
     *
     * Unmounting is the obvious one. `pagehide` is the other: a link followed, a tab closed, a
     * reload - none of which unmount anything, and all of which would otherwise leave the recording
     * indicator lit on a page nobody is looking at. It fires where `beforeunload` does not,
     * including a back-forward cache freeze.
     */
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [release]);

  return { status, reason, start, stop };
}
