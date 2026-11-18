// libsignal (Baileys' Signal protocol library) logs whole session records with
// console.info and console.warn when a WhatsApp session is opened, renewed or
// closed: private ratchet keys and root keys included. Those lines reach the
// pod logs and the dashboard. Keep the event, drop the record.

const SIGNAL_PREFIXES = [
  'Closing session',
  'Opening session',
  'Removing old closed session',
  'Session already closed',
  'Session already open',
  'Migrating session to',
  'Closing open session in favor of incoming prekey bundle',
  'Closing stale open session',
  'Decrypted message with closed session',
  'Unhandled bucket type',
]

// The short line to log instead, or null when `args` isn't a libsignal message
export function signalLogLine(args) {
  const [first] = args
  if (typeof first !== 'string') return null
  const prefix = SIGNAL_PREFIXES.find(p => first.startsWith(p))
  return prefix ? `signal: ${prefix.toLowerCase()}` : null
}

export function quietSignalLogs(target = console) {
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = target[level].bind(target)
    target[level] = (...args) => {
      const line = signalLogLine(args)
      return line ? original(line) : original(...args)
    }
  }
}
