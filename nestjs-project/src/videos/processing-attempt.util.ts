export function isFinalAttempt(
  attemptsMade: number,
  maxAttempts: number,
): boolean {
  return attemptsMade >= maxAttempts;
}
