// What the router sends when a turn ends without an answer (see servers/shared/escalation).
// Mastra reports it as a failed task whose text is `Handler failed: [[escalation:v2]]{json}`.
const MARKER = '[[escalation:v2]]'

export type Escalation = {
  reasonCode: string
  failureClass: 'terminal' | 'transient' | 'caller-action'
  retryable: boolean
  retryAfterMs?: number
  destination: { url: string; label: string; instructions?: string }
  approval?: { approvalId: string; action: string; expiresAt?: string }
}

// The faults an agent's server can be told to inject (see servers/shared/fault.ts).
export const FAULTS = ['none', 'outage', 'rate-limit', 'denied', 'unsupported', 'guardrail', 'crash']

function parse(text: string) {
  const start = text.indexOf(MARKER)
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start + MARKER.length))
  } catch {
    return undefined
  }
}

// The router's escalation in a failed task's text: the sentence to show and the fields behind it.
export function readEscalation(text: string): { text: string; escalation: Escalation } | undefined {
  const envelope = parse(text)
  return envelope?.kind === 'escalation' && typeof envelope.text === 'string' && envelope.escalation ? envelope : undefined
}

// The reason code a specialist gave the router in a failed task's text.
export function readReason(text: string): string | undefined {
  const envelope = parse(text)
  return envelope?.kind === 'hint' ? envelope.hint?.escalationReason : undefined
}
