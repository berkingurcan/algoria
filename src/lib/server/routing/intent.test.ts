import { describe, expect, it } from 'vitest';
import { conversationalReply } from './intent';

describe('conversation intent', () => {
  it.each(['hello', 'Hey!', 'greetings', 'hi Algoria'])('keeps %s in the conversation layer', (prompt) => {
    expect(conversationalReply(prompt)).toContain('What would you like to accomplish?');
  });

  it('does not swallow a real task that starts with a greeting', () => {
    expect(conversationalReply('Hello, research Stellar payment agents')).toBeNull();
  });
});
