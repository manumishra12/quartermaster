import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Dictation is tested against a fake recogniser, never a real one.
 *
 * jsdom has no Web Speech API, and a test that needed one would only run on a machine with a
 * microphone and somebody willing to talk to it. Every state this control can be in - unsupported,
 * refused, listening, finished - is reachable here by hand.
 */

const setText = vi.fn();
const send = vi.fn();
let composerText = '';

vi.mock('@truefoundry/trueforge-ui/assistant-ui', () => ({
  useAui: () => ({ composer: () => ({ setText, send }) }),
  useAuiState: (select: (state: { composer: { text: string } }) => unknown) =>
    select({ composer: { text: composerText } }),
}));

const { Dictation } = await import('./Dictation');

type ResultEvent = { resultIndex: number; results: SpeechRecognitionResultList };

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  onresult: ((event: ResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeRecognition.instances.push(this);
  }
}

/** The shape `onresult` actually receives: an array-like of array-likes. */
function heard(...phrases: Array<{ transcript: string; isFinal: boolean }>): SpeechRecognitionResultList {
  const list = phrases.map(({ transcript, isFinal }) => ({ 0: { transcript }, isFinal, length: 1 }));
  return list as unknown as SpeechRecognitionResultList;
}

function speech(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

function withApi() {
  speech().SpeechRecognition = FakeRecognition;
}

function withoutApi() {
  delete speech().SpeechRecognition;
  delete speech().webkitSpeechRecognition;
}

function latest(): FakeRecognition {
  return FakeRecognition.instances[FakeRecognition.instances.length - 1]!;
}

beforeEach(() => {
  setText.mockReset();
  send.mockReset();
  composerText = '';
  FakeRecognition.instances = [];
  withApi();
});

describe('dictation in the composer', () => {
  test('a browser without the API gets a control that says so, not one that looks live', async () => {
    /**
     * Prevents: present-and-broken. `SpeechRecognition` is Chrome and Edge only, so in Firefox and
     * Safari a plain microphone button would take the press, do nothing, and give the person no
     * way to tell a missing API from a bug. The reason has to be on the control itself, and the
     * control has to stay reachable by keyboard so somebody who never sees a tooltip can hear it.
     */
    withoutApi();
    const user = userEvent.setup();
    render(<Dictation disabled={false} isRunning={false} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleName(/chrome and edge have it/i);

    await user.click(button);
    expect(setText).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  test('a refused microphone says it was refused', async () => {
    /**
     * Prevents: silent failure. A denied permission arrives as an error event and nothing else -
     * no words appear, the button goes quiet, and the person presses it again because the interface
     * never told them the browser had said no.
     */
    const user = userEvent.setup();
    render(<Dictation disabled={false} isRunning={false} />);

    await user.click(screen.getByRole('button', { name: /dictate/i }));
    act(() => latest().onerror?.({ error: 'not-allowed' }));

    expect(screen.getByRole('status')).toHaveTextContent(/permission was refused/i);
    expect(screen.getByRole('status')).toHaveTextContent(/browser settings/i);
  });

  test('a final transcript is added to what is already there, not put in its place', async () => {
    /**
     * Prevents: dictation eating a half-written prompt. Somebody types a sentence, reaches for the
     * microphone to finish it, and a control that called setText with only the transcript would
     * throw the typed half away with no undo anywhere in this interface.
     */
    composerText = 'check the ledger';
    const user = userEvent.setup();
    render(<Dictation disabled={false} isRunning={false} />);

    await user.click(screen.getByRole('button', { name: /dictate/i }));
    act(() => latest().onresult?.({ resultIndex: 0, results: heard({ transcript: 'and run the tests', isFinal: true }) }));

    expect(setText).toHaveBeenLastCalledWith('check the ledger and run the tests');
  });

  test('words appear while they are still being said, and are revised rather than repeated', async () => {
    /**
     * Prevents: a microphone that looks dead for the length of a sentence. Interim results are the
     * only feedback that the audio is getting anywhere, and drawing each one against the committed
     * text rather than the last interim is what stops "and run" "and run the tests" accumulating.
     */
    composerText = 'check the ledger';
    const user = userEvent.setup();
    render(<Dictation disabled={false} isRunning={false} />);

    await user.click(screen.getByRole('button', { name: /dictate/i }));
    act(() => latest().onresult?.({ resultIndex: 0, results: heard({ transcript: 'and run', isFinal: false }) }));
    expect(setText).toHaveBeenLastCalledWith('check the ledger and run');

    act(() => latest().onresult?.({ resultIndex: 0, results: heard({ transcript: 'and run the tests', isFinal: false }) }));
    expect(setText).toHaveBeenLastCalledWith('check the ledger and run the tests');
  });

  test('nothing it hears is ever sent', async () => {
    /**
     * Prevents: voice becoming an instruction to act. Dictation fills the composer; the person
     * still presses send. It is the same decision that keeps allow and deny off the keyboard here -
     * a surface that acted on a sound in the room would have acted before anybody read it.
     */
    const user = userEvent.setup();
    render(<Dictation disabled={false} isRunning={false} />);

    await user.click(screen.getByRole('button', { name: /dictate/i }));
    act(() => latest().onresult?.({ resultIndex: 0, results: heard({ transcript: 'roll back the deploy', isFinal: true }) }));
    act(() => latest().onend?.());

    expect(setText).toHaveBeenLastCalledWith('roll back the deploy');
    expect(send).not.toHaveBeenCalled();
  });

  test('unmounting releases the microphone', async () => {
    /**
     * Prevents: the bug this whole feature is judged on - a live microphone left running after the
     * component is gone. `abort` rather than `stop`, because `stop` asks the service for one last
     * result, which would arrive with nowhere to put it.
     */
    const user = userEvent.setup();
    const { unmount } = render(<Dictation disabled={false} isRunning={false} />);

    await user.click(screen.getByRole('button', { name: /dictate/i }));
    const recognition = latest();
    expect(recognition.start).toHaveBeenCalled();

    unmount();
    expect(recognition.abort).toHaveBeenCalled();
  });

  test('sending stops it', async () => {
    /**
     * Prevents: a microphone recording the room while the agent works. Once the draft has gone the
     * person has stopped thinking about the button, so the button has to stop for them.
     */
    const user = userEvent.setup();
    const { rerender } = render(<Dictation disabled={false} isRunning={false} />);

    await user.click(screen.getByRole('button', { name: /dictate/i }));
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');

    rerender(<Dictation disabled isRunning />);
    expect(latest().stop).toHaveBeenCalled();
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a live microphone is impossible to miss, and says where the audio goes', async () => {
    /**
     * Prevents: a microphone nobody knows is on, and a microphone whose audio quietly leaves the
     * machine. Chrome does not recognise speech locally - it streams it to a Google service - so
     * the disclosure is on the control before it is pressed and in the announcement after.
     */
    const user = userEvent.setup();
    render(<Dictation disabled={false} isRunning={false} />);

    const button = screen.getByRole('button', { name: /dictate/i });
    expect(button).toHaveAttribute('title', expect.stringContaining('sends the audio to its speech service'));
    expect(button).toHaveAccessibleDescription(/nothing is transcribed on this machine/i);
    expect(screen.getByText(/audio leaves this machine/i)).toBeInTheDocument();

    await user.click(button);
    expect(screen.getByText('Listening')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/your microphone is live/i);
  });
});
