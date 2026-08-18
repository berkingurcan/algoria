import { describe, expect, it } from 'vitest';
import { feedbackHash, feedbackUri, isFeedbackScore, verify8004FeedbackTransaction, type ExpectedFeedback } from './stellar';

const expected: ExpectedFeedback = {
  walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  agentId: 42,
  score: 80,
  tag1: 'helpful',
  endpoint: 'https://agent.example/task',
  feedbackId: 'c0ffee00-0000-4000-8000-000000000001'
};

describe('the record a reputation entry points at', () => {
  it('derives a stable URI and its hash', () => {
    expect(feedbackUri(expected.feedbackId)).toBe(`urn:algoria:feedback:${expected.feedbackId}`);
    expect(feedbackHash(expected.feedbackId)).toHaveLength(32);
    // The hash has to be reproducible from the id alone; it is what ties the
    // on-chain entry to the job without putting the job on-chain.
    expect(feedbackHash(expected.feedbackId)).toEqual(feedbackHash(expected.feedbackId));
    expect(feedbackHash('c0ffee00-0000-4000-8000-000000000002')).not.toEqual(feedbackHash(expected.feedbackId));
  });
});

describe('only whole steps are offered', () => {
  it('accepts the five the interface shows and nothing between them', () => {
    for (const score of [20, 40, 60, 80, 100]) expect(isFeedbackScore(score)).toBe(true);
    for (const score of [0, 10, 50, 90, 110, 80.5, -20]) expect(isFeedbackScore(score)).toBe(false);
    expect(isFeedbackScore('80')).toBe(false);
  });
});

/**
 * A wallet signs what it is handed, so a signed entry coming back through the
 * same session proves only that a signature happened, not that it covers the
 * entry the user approved. Everything that reaches the registry under Algoria's
 * name is therefore re-read from the transaction itself.
 */
describe('checking a signed entry against the one that was approved', () => {
  it('refuses anything that is not a readable transaction', () => {
    expect(() => verify8004FeedbackTransaction({}, expected)).toThrow(/missing or too large/);
    expect(() => verify8004FeedbackTransaction('', expected)).toThrow(/missing or too large/);
    expect(() => verify8004FeedbackTransaction('x'.repeat(64_001), expected)).toThrow(/missing or too large/);
    expect(() => verify8004FeedbackTransaction('not-a-transaction', expected)).toThrow(/could not be read/);
  });
});
