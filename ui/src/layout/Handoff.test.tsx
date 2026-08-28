import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HandoffCard, readHandoff } from './Handoff';

const envelope = {
  from: 'code-reviewer',
  to: 'analytics',
  request: 'summarise Q3 refunds',
  because: 'I already confirmed the totals are correct',
  chain: ['code-reviewer', 'analytics'],
};

describe('the handoff card', () => {
  it('names who wrote the note, beside the note', () => {
    /**
     * The distinction the card exists for. Flattened into a transcript the request and the note
     * look identical - same typeface, same authority - so a reader cannot tell which sentences a
     * person wrote and which a model did.
     */
    render(<HandoffCard envelope={envelope} />);
    expect(screen.getByText(/Note from code-reviewer - unverified/)).toBeInTheDocument();
    expect(screen.getByText(/checked by nobody/i)).toBeInTheDocument();
  });

  it('says approvals do not travel, where somebody approving would read it', () => {
    render(<HandoffCard envelope={envelope} />);
    expect(screen.getByText(/Approvals do not travel between agents/)).toBeInTheDocument();
  });

  it('shows the whole chain, not just the last hop', () => {
    render(<HandoffCard envelope={{ ...envelope, chain: ['desk-assistant', 'code-reviewer', 'analytics'] }} />);
    for (const agent of ['desk-assistant', 'code-reviewer', 'analytics']) {
      expect(screen.getByText(agent)).toBeInTheDocument();
    }
  });

  it('is labelled for a screen reader with both ends of the handoff', () => {
    render(<HandoffCard envelope={envelope} />);
    expect(screen.getByLabelText('Request handed from code-reviewer to analytics')).toBeInTheDocument();
  });

  it('reads an envelope the CLI wrote, and nothing else', () => {
    /**
     * The parser is the CLI's own, imported rather than reimplemented. Prose that merely discusses
     * a handoff must not be decorated as one.
     */
    expect(readHandoff('I thought about handing this to analytics, but the note would be untrusted.')).toBeNull();
    expect(readHandoff('')).toBeNull();
  });
});
