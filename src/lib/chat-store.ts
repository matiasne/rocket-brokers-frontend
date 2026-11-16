import { createClient } from '@/lib/supabase/client'

// The signed-in user's chat in Supabase (supabase/migrations/0001_chat.sql). Row level
// security limits every call here to that user's rows.
export type StoredSession = { id: string; contextId: string; title?: string }
export type StoredTurn = { id: string; sessionId: string; kind: 'a2a' | 'pap' | 'background'; startedAt: number; data: unknown }

let client: ReturnType<typeof createClient> | undefined
const supabase = () => (client ??= createClient())

function check<T extends { error: { message: string } | null }>(result: T) {
  if (result.error) throw new Error(result.error.message)
  return result
}

export async function loadChat(): Promise<{ sessions: StoredSession[]; turns: StoredTurn[] }> {
  const [sessions, turns] = await Promise.all([
    supabase().from('chat_sessions').select('id, context_id, title').order('created_at'),
    supabase().from('chat_turns').select('id, session_id, kind, started_at, data').order('started_at'),
  ])
  return {
    sessions: (check(sessions).data ?? []).map(row => ({ id: row.id, contextId: row.context_id, ...(row.title && { title: row.title }) })),
    turns: (check(turns).data ?? []).map(row => ({ id: row.id, sessionId: row.session_id, kind: row.kind, startedAt: Date.parse(row.started_at), data: row.data })),
  }
}

export async function saveSessions(sessions: StoredSession[]) {
  if (!sessions.length) return
  check(await supabase().from('chat_sessions').upsert(sessions.map(session => ({ id: session.id, context_id: session.contextId, title: session.title ?? null }))))
}

export async function saveTurns(turns: StoredTurn[]) {
  if (!turns.length) return
  check(
    await supabase()
      .from('chat_turns')
      .upsert(turns.map(turn => ({ id: turn.id, session_id: turn.sessionId, kind: turn.kind, started_at: new Date(turn.startedAt).toISOString(), updated_at: new Date().toISOString(), data: turn.data }))),
  )
}

// Its turns go with it (on delete cascade).
export async function deleteSession(id: string) {
  check(await supabase().from('chat_sessions').delete().eq('id', id))
}
