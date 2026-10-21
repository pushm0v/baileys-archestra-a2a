// Exponential backoff with jitter: ~1s, 2s, 4s … capped at 5 minutes.
// Jitter spreads reconnects out so many sessions on one host don't retry in lockstep.
export function reconnectDelay(attempt, { base = 1000, max = 5 * 60_000, random = Math.random } = {}) {
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 20))
  return Math.round(ceiling / 2 + random() * ceiling / 2)
}
