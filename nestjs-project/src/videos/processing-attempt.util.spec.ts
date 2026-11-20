import { isFinalAttempt } from './processing-attempt.util';

describe('isFinalAttempt', () => {
  it('is false before the last attempt', () => {
    expect(isFinalAttempt(1, 3)).toBe(false);
    expect(isFinalAttempt(2, 3)).toBe(false);
  });

  it('is true when attemptsMade has reached the configured attempts', () => {
    expect(isFinalAttempt(3, 3)).toBe(true);
    expect(isFinalAttempt(1, 1)).toBe(true);
  });
});
