'use client'

import type ForceGraph from 'force-graph'
import type { LinkObject, NodeObject } from 'force-graph'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { deleteSession, loadChat, saveSessions, saveTurns, type StoredTurn } from '@/lib/chat-store'
import { FAULTS, readEscalation, readReason, type Escalation } from '@/lib/escalation'
import { createClient } from '@/lib/supabase/client'

// `detail` is the raw JSON behind the entry, shown when the entry is opened.
type LogEntry = { at: number; label: string; detail?: unknown }

// One chat session: its own thread of turns and its own A2A `contextId`, which the router
// uses as its memory thread, so sessions do not share context.
type Session = { id: string; contextId: string; title?: string }

type RouterTask = {
  localId: string
  sessionId: string
  prompt: string
  startedAt: number
  // When the task reached a final state: where its reply goes in the thread.
  settledAt?: number
  taskId?: string
  state: string
  answer: string
  // Set when the router ended the turn without an answer.
  escalation?: Escalation
  // Set when this is not a turn the user sent, but a delegation that outlived its turn: the
  // router goes on with it in the background and says how it ended when it settles.
  background?: { agent: string }
  // A background result that has not been on screen yet.
  unread?: boolean
  log: LogEntry[]
}

// A background delegation, as the router reports it (servers/router/src/mastra/session.ts).
type Job = { id: string; agent: string; request: string; startedAt: number; state: string; answer?: string }

type SpecialistTask = {
  id: string
  contextId?: string
  agent: string
  status?: { state?: string; timestamp?: string; message?: { parts?: { text?: string }[] } }
  history?: { parts?: { text?: string }[] }[]
  artifacts?: { parts?: { text?: string }[] }[]
}

type AgentCard = {
  description?: string
  url: string
  version?: string
  protocolVersion?: string
  provider?: { organization?: string }
  capabilities?: { streaming?: boolean; pushNotifications?: boolean }
  defaultInputModes?: string[]
  defaultOutputModes?: string[]
  skills?: { id: string; name: string; description?: string }[]
}
// One hand-off shown in the sidebar: a dot travelling between the router and a
// specialist, plus a short note under the specialist saying why.
type Signal = {
  key: number
  agent: string
  kind: 'request' | 'response'
  text: string
  failed: boolean
  top: number
  left: number
  dy: number
  // Viewport position of the floating reason bubble, beside the specialist's row.
  noteTop: number
  noteLeft: number
  delay: number
}
const SIGNAL_MS = 5000

// `card` is null while the agent's server is unreachable. `enabled` says whether the router
// may delegate to it: null for the router itself, or while the router is unreachable.
// `delayMs` is the wait the agent's server adds before it starts on a message, and `fault` the
// fault it injects instead of answering (both null while unreachable).
type AgentInfo = { id: string; card: AgentCard | null; enabled: boolean | null; delayMs: number | null; fault: string | null }

// Personal Agent Protocol (PAP): the company's discovery document, /.well-known/poppy.json.
type PoppyDocument = {
  protocol_version?: string
  organization?: { name?: string; domain?: string }
  auth?: { disabled?: boolean }
  agent?: { protocols?: { type: string; endpoint: string; access?: string }[] }
  extensions?: Record<string, { version: string }[]>
}
type Discovery = { url: string; document: PoppyDocument | null }
// Model Context Protocol (MCP): the router's endpoint and the tools it publishes there.
type McpDoor = { url: string; tools: string[] | null; issuer?: string | null }

// PAP `operations` extension: exact terms the company wants approved before it acts.
type Operation = {
  operation_id: string
  revision: string
  summary?: string
  terms: Record<string, unknown>
  expires_at: string
}

// One PAP conversation between the borrower's personal agent (this page) and the company.
type PapConversation = {
  localId: string
  sessionId: string
  prompt: string
  startedAt: number
  // When the company first stopped working on it (an answer, or an approval to ask for).
  settledAt?: number
  conversationId?: string
  working: boolean
  error?: string
  answer: string
  log: LogEntry[]
  operation?: Operation
  // awaiting: the borrower has not answered. approved: approval sent. Then the company's
  // own status for the operation (`performed`), or `declined` when the borrower said no.
  operationState?: string
}

const TERMINAL = ['completed', 'failed', 'canceled', 'rejected']

// What a stored turn was last saved as. A turn is written again only when this changes, so a
// reply that is streaming in is not saved chunk by chunk.
const taskSignature = (task: RouterTask) =>
  [task.state, task.taskId, task.settledAt, task.unread, ...(TERMINAL.includes(task.state) ? [task.answer.length, task.log.length] : [])].join('|')
const conversationSignature = (conversation: PapConversation, cursor?: string) =>
  [conversation.working, conversation.conversationId, conversation.operationState, conversation.error, conversation.answer.length, cursor].join('|')
const LOST = 'Interrupted by a page reload: the router no longer has this task.'
// Who is asking decides the protocol: the loan officer's console speaks A2A to the router,
// the borrower's personal agent speaks PAP.
const SUGGESTIONS = [
  'Which products fit a $400,000 loan on a $500,000 home with a 740 credit score?',
  'Start a $400,000 purchase loan and add borrowers Ana Perez and her spouse Luis Perez',
  'Create a loan for Sam Lee and pull credit. Sam consented and I, the loan officer, approve.',
]

const taskState = (task: SpecialistTask) =>
  (task.status?.state ?? 'unknown').replace('TASK_STATE_', '').toLowerCase().replace('_', '-')

// "loan-intake" → "Loan Intake", initials "LI", and a stable colour per agent.
const displayName = (id: string) => id.replace(/(^|-)(\w)/g, (_, dash, letter) => (dash ? ' ' : '') + letter.toUpperCase())
const initials = (id: string) => id.split('-').map(word => word[0]).join('').toUpperCase()
const hue = (id: string) => [...id].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 360

function Avatar({ id, working }: { id: string; working?: boolean }) {
  return (
    <span className={`avatar${working ? ' working' : ''}`} style={{ background: `hsl(${hue(id)} 55% 45%)` }}>
      {initials(id)}
    </span>
  )
}

function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    // A click on the backdrop lands on the dialog element itself.
    <dialog ref={ref} onClose={onClose} onClick={event => event.target === ref.current && onClose()}>
      <div className="modal">{children}</div>
    </dialog>
  )
}

// The agent's response delay, in seconds. Saved on submit; the server answers with the value it kept.
function DelayField({ agent, onSave }: { agent: AgentInfo; onSave: (delayMs: number) => Promise<string | undefined> }) {
  const [seconds, setSeconds] = useState(String((agent.delayMs ?? 0) / 1000))
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(await onSave(Math.round(Number(seconds) * 1000)))
    setSaving(false)
  }
  return (
    <form className="delay-field" onSubmit={submit}>
      <input
        type="number"
        min={0}
        max={120}
        step={0.5}
        value={seconds}
        aria-label="Response delay in seconds"
        onChange={event => setSeconds(event.target.value)}
      />
      <span>seconds</span>
      <button type="submit" disabled={saving || Number(seconds) * 1000 === agent.delayMs}>
        Save
      </button>
      {error && <span className="delay-error">{error}</span>}
    </form>
  )
}

// An agent's settings, opened from the gear on its row. The router has no on/off switch:
// it is the one that delegates.
function SettingsModal({
  agent,
  onToggle,
  onDelayChange,
  onFaultChange,
  onClose,
}: {
  agent: AgentInfo
  onToggle: (enabled: boolean) => void
  onDelayChange: (delayMs: number) => Promise<string | undefined>
  onFaultChange: (fault: string) => void
  onClose: () => void
}) {
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <Avatar id={agent.id} />
        <div>
          <h2>{displayName(agent.id)} settings</h2>
          <code>{agent.id}</code>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {agent.enabled === null && agent.delayMs === null && agent.fault === null && <p className="offline-note">This agent's server is unreachable.</p>}
      {agent.enabled !== null && (
        <label className="setting">
          <span>
            <b>Enabled</b>
            <small>When off, the router does not delegate to this agent.</small>
          </span>
          <span className="switch">
            <input type="checkbox" role="switch" checked={agent.enabled} onChange={event => onToggle(event.target.checked)} />
            <span />
          </span>
        </label>
      )}
      {agent.delayMs !== null && (
        <div className="setting">
          <span>
            <b>Response delay</b>
            <small>How long the agent waits before it starts on a message.</small>
          </span>
          {/* Keyed by the saved value, so the field shows it again after a save. */}
          <DelayField key={agent.delayMs} agent={agent} onSave={onDelayChange} />
        </div>
      )}
      {agent.fault !== null && (
        <label className="setting">
          <span>
            <b>Inject a fault</b>
            <small>The agent fails this way on every message, until set back to none.</small>
          </span>
          <select className={agent.fault === 'none' ? undefined : 'active'} value={agent.fault} onChange={event => onFaultChange(event.target.value)}>
            {FAULTS.map(fault => (
              <option key={fault}>{fault}</option>
            ))}
          </select>
        </label>
      )}
    </Modal>
  )
}

type Theme = 'light' | 'dark'

// Asks before closing a chat session, and lists the delegations it still has running in the
// background: closing it stops them.
function CloseSessionModal({ title, jobs, error, onConfirm, onClose }: { title: string; jobs: Job[]; error?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <div>
          <h2>Close “{title}”?</h2>
          <small>
            {jobs.length === 0
              ? 'The chat and its messages are deleted.'
              : `${jobs.length === 1 ? 'This task is' : `These ${jobs.length} tasks are`} still running in the background. Closing the chat stops ${jobs.length === 1 ? 'it' : 'them'}.`}
          </small>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {jobs.length > 0 && (
      <ul className="closing-jobs">
        {jobs.map(job => (
          <li key={job.id}>
            <b>{job.agent}</b>
            <small>running for {Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))}s</small>
            <span>{job.request}</span>
          </li>
        ))}
      </ul>
      )}
      {error && <p className="store-error">Could not stop what this chat has running: {error}</p>}
      <div className="actions closing-actions">
        <button type="button" className="quiet" onClick={onClose}>
          Keep open
        </button>
        <button type="button" onClick={onConfirm}>
          {jobs.length ? 'Stop and close' : 'Close chat'}
        </button>
      </div>
    </Modal>
  )
}

// App-wide settings, opened from the gear at the foot of the sidebar.
function AppSettingsModal({ theme, onThemeChange, onClose }: { theme: Theme; onThemeChange: (theme: Theme) => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <div>
          <h2>Settings</h2>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <label className="setting">
        <span>
          <b>Dark mode</b>
          <small>When off, the page uses the light theme.</small>
        </span>
        <span className="switch">
          <input type="checkbox" role="switch" checked={theme === 'dark'} onChange={event => onThemeChange(event.target.checked ? 'dark' : 'light')} />
          <span />
        </span>
      </label>
    </Modal>
  )
}

const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const LogoutIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)

function AgentModal({ agent, working, onClose }: { agent: AgentInfo; working: boolean; onClose: () => void }) {
  const { id, card } = agent
  return (
    <Modal onClose={onClose}>
        <div className="modal-head">
          <Avatar id={id} working={working} />
          <div>
            <h2>{displayName(id)}</h2>
            <code>{id}</code>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!card && <p className="offline-note">This agent's server is unreachable.</p>}
        {card && (
          <>
            <dl>
              <dt>Status</dt>
              <dd>{agent.enabled === false ? 'Disabled: the router will not delegate to it' : working ? 'Working on a task' : 'Idle'}</dd>
              <dt>A2A endpoint</dt>
              <dd>
                <code>{card.url}</code>
              </dd>
              <dt>Streaming</dt>
              <dd>{card.capabilities?.streaming ? 'Yes' : 'No'}</dd>
              <dt>Push notifications</dt>
              <dd>{card.capabilities?.pushNotifications ? 'Yes' : 'No'}</dd>
              <dt>Input / output</dt>
              <dd>
                {card.defaultInputModes?.join(', ')} → {card.defaultOutputModes?.join(', ')}
              </dd>
              <dt>Version</dt>
              <dd>
                {card.version} · A2A {card.protocolVersion} · {card.provider?.organization}
              </dd>
            </dl>
            <h3>Instructions</h3>
            <p className="instructions">{card.description}</p>
            <h3>Tools</h3>
            <ul className="skills">
              {(card.skills ?? []).map(skill => (
                <li key={skill.id}>
                  <code>{skill.name}</code>
                  {skill.description}
                </li>
              ))}
            </ul>
          </>
        )}
    </Modal>
  )
}

function PoppyModal({ discovery, onClose }: { discovery: Discovery; onClose: () => void }) {
  const { url, document } = discovery
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <span className="avatar protocol">PAP</span>
        <div>
          <h2>Personal Agent Protocol</h2>
          <code>{url}</code>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {!document && <p className="offline-note">The router server is unreachable.</p>}
      {document && (
        <>
          <p className="instructions">
            How a borrower’s personal agent finds this company and talks to it. The router is the only agent it can
            reach; the specialists stay behind it, on A2A.
          </p>
          <h3>Discovery</h3>
          <dl>
            <dt>Company</dt>
            <dd>
              {document.organization?.name} · <code>{document.organization?.domain}</code>
            </dd>
            <dt>Protocol version</dt>
            <dd>{document.protocol_version}</dd>
            <dt>Conversations</dt>
            <dd>
              <code>{document.agent?.protocols?.[0]?.endpoint}</code>
            </dd>
            <dt>Sign-in</dt>
            <dd>{document.auth?.disabled ? 'Not offered (demo: the session is not verified)' : 'Offered'}</dd>
            <dt>Extensions</dt>
            <dd>
              {Object.entries(document.extensions ?? {})
                .map(([name, versions]) => `${name} v${versions.map(entry => entry.version).join(', v')}`)
                .join(' · ')}
            </dd>
          </dl>
          <h3>poppy.json</h3>
          <pre>{JSON.stringify(document, null, 2)}</pre>
        </>
      )}
    </Modal>
  )
}

function McpModal({ door, onClose }: { door: McpDoor; onClose: () => void }) {
  const { url, tools, issuer } = door
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <span className="avatar protocol">MCP</span>
        <div>
          <h2>Model Context Protocol</h2>
          <code>{url}</code>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {!tools && <p className="offline-note">The router server is unreachable.</p>}
      <p className="instructions">
        How a borrower’s assistant (any MCP client) talks to this company. The router is the only agent it can
        reach; the specialists stay behind it, on A2A.
      </p>
      <h3>Connect</h3>
      <dl>
        <dt>Endpoint</dt>
        <dd>
          <code>{url}</code> · Streamable HTTP
        </dd>
        <dt>Borrower</dt>
        <dd>
          {issuer ? (
            <>
              Signs in with Auth0 (<code>{issuer}</code>)
            </>
          ) : (
            <>
              Header <code>X-Borrower-Id</code> (demo: not verified)
            </>
          )}
        </dd>
        <dt>Tools</dt>
        <dd>{tools?.length ? tools.map(tool => <code key={tool}>{tool} </code>) : '—'}</dd>
      </dl>
      {issuer && (
        <>
          <h3>Claude app</h3>
          <p className="instructions">
            Settings → Connectors → Add custom connector, with the endpoint above. Connect opens the Auth0 sign-in.
          </p>
        </>
      )}
      <h3>Claude Code</h3>
      <pre>{issuer ? `claude mcp add --transport http loan-router ${url}` : `claude mcp add --transport http loan-router ${url} --header "X-Borrower-Id: borrower-1"`}</pre>
      <h3>Try it</h3>
      <p className="instructions">
        Ask your assistant: “Create a loan for Ana Diaz, then pull her credit. The loan officer approved the credit
        pull.” Before the pull, the client shows a form with the terms (a hard inquiry) and one field, approve.
        Credit is pulled only after you approve. Send the loan id with every message: the router does not remember
        earlier ones.
      </p>
      <h3>Client support</h3>
      <p className="instructions">
        The approval form needs a client that speaks MCP 2026-07-28. Older clients can still call the tool, but a
        credit pull ends as a tool error and nothing is pulled.
      </p>
    </Modal>
  )
}

// Operation summaries may use **strong** emphasis and nothing else.
const emphasis = (text: string) => text.split('**').map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part))

// Tags a background result as unread until it has been on screen for a moment, in the browser tab
// the user is on and in a window that has focus: a result that lands while they are elsewhere stays unread.
function UnreadTag({ onSeen }: { onSeen: () => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useRef(onSeen)
  seen.current = onSeen
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let inView = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      if (inView && document.visibilityState === 'visible' && document.hasFocus()) timer = setTimeout(() => seen.current(), 1200)
    }
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      check()
    })
    observer.observe(el)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('blur', check)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('blur', check)
    }
  }, [])
  return (
    <span ref={ref} className="unread-tag">
      Unread
    </span>
  )
}

function Typing() {
  return (
    <span className="typing" aria-label="Working">
      <i />
      <i />
      <i />
    </span>
  )
}

function Timeline({ log, pending }: { log: LogEntry[]; pending?: string }) {
  return (
    <ol>
      {log.map((entry, index) => (
        <li key={index}>
          {entry.detail === undefined ? (
            <>
              <time>+{(entry.at / 1000).toFixed(1)}s</time> {entry.label}
            </>
          ) : (
            <details>
              <summary>
                <time>+{(entry.at / 1000).toFixed(1)}s</time> {entry.label}
              </summary>
              <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
            </details>
          )}
        </li>
      ))}
      {pending && <li className="pending">{pending}</li>}
    </ol>
  )
}

// The router answers in Markdown (GitHub flavour, for its tables); links open in a new tab.
function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

const partsText = (parts?: { text?: string }[]) => (parts ?? []).map(p => p.text ?? '').join('')

// The two callers this page plays. They are not on the agent map, only in its list of interactions.
const CALLERS = [
  { id: 'loan-officer', name: 'Loan officer', protocol: 'A2A' },
  { id: 'borrower-agent', name: 'Borrower’s agent', protocol: 'PAP' },
]
const nodeName = (id: string) => CALLERS.find(caller => caller.id === id)?.name ?? displayName(id)

// One message from one node of the agent map to another, and what came back.
type Interaction = {
  key: string
  from: string
  to: string
  state: string
  active: boolean
  failed: boolean
  text: string
  result: string
  reason?: string
  at: number
}

// Where each dragged node was dropped, in graph coordinates. Kept in the browser, since the map
// is unmounted while the chat is shown.
const MAP_PINS_KEY = 'agent-map-pins'
const MAP_FONT = 'ui-monospace, Menlo, monospace'
// Room left around the graph when it is fitted to the canvas: the labels hang below the nodes.
const MAP_FIT_PADDING = 70
// How long a dot takes to run along an edge.
const PACKET_MS = 1400

// Something that just happened on an edge of the agent map: a sign floats over the edge for a
// few seconds and a dot travels along it. `edge` is the edge's node other than the router;
// `at` is when it happened, on the clock the dot is animated with.
type MapSign = { key: number; edge: string; kind: 'request' | 'response' | 'failed'; title: string; text: string; at: number }

type MapNode = NodeObject & { id: string }
type MapGraph = ForceGraph<MapNode>
type MapEdge = { count: number; active: boolean; recent: boolean; failed: boolean }

const readPins = (): Record<string, { x: number; y: number }> => {
  try {
    return JSON.parse(localStorage.getItem(MAP_PINS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const agentStatus = (agent: AgentInfo, working: boolean) => (agent.enabled === false ? 'disabled' : !agent.card ? 'offline' : working ? 'working' : 'idle')

// The two ends of an edge, router first, once the layout has placed them.
function edgeEnds(graph: MapGraph, edge: string) {
  const nodes = graph.graphData().nodes
  const from = nodes[0]
  const to = nodes.find(node => node.id === edge)
  if (from?.x === undefined || from.y === undefined || to?.x === undefined || to.y === undefined) return
  return [
    { x: from.x, y: from.y },
    { x: to.x, y: to.y },
  ]
}

// The middle of an edge, in pixels of the canvas.
function edgeMiddle(graph: MapGraph, edge: string) {
  const ends = edgeEnds(graph, edge)
  return ends && graph.graph2ScreenCoords((ends[0].x + ends[1].x) / 2, (ends[0].y + ends[1].y) / 2)
}

// The agent map: every registered agent as a node of a force-directed graph, the router in the
// middle, and an edge to each specialist. Selecting a node or an edge narrows the list of
// interactions. The callers are not drawn: what they ask the router is in the list only.
function AgentMap({ agents, workingIds, interactions }: { agents: AgentInfo[]; workingIds: Set<string>; interactions: Interaction[] }) {
  const graphRef = useRef<HTMLDivElement>(null)
  const [graph, setGraph] = useState<MapGraph>()
  const [selectedId, setSelectedId] = useState<string>()
  const [listOpen, setListOpen] = useState(false)
  // Whether any node has been dragged, and so stays where it was dropped.
  const [pinned, setPinned] = useState(false)
  // Set when the graph should be fitted to the canvas once the layout settles.
  const fit = useRef(false)
  const hovered = useRef<string | undefined>(undefined)
  const [signs, setSigns] = useState<MapSign[]>([])
  const signCounter = useRef(0)
  // Last seen state of every interaction; null until the first look, so what already
  // existed when the map opened is not announced.
  const seen = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    const previous = seen.current
    seen.current = new Map(interactions.map(interaction => [interaction.key, interaction.state]))
    if (!previous) return
    const show = (sign: Omit<MapSign, 'key' | 'at'>, delay: number) =>
      setTimeout(() => {
        const key = signCounter.current++
        setSigns(current => [...current, { ...sign, key, at: performance.now() }])
        setTimeout(() => setSigns(current => current.filter(other => other.key !== key)), SIGNAL_MS)
      }, delay)
    for (const interaction of interactions) {
      const { from, to, state } = interaction
      // A caller has no edge to show a sign on.
      if (CALLERS.some(caller => caller.id === from)) continue
      const before = previous.get(interaction.key)
      if (before === undefined) show({ edge: to, kind: 'request', title: `${nodeName(from)} → ${nodeName(to)}`, text: interaction.text || 'delegated request' }, 0)
      if (interaction.active || before === state) continue
      // An interaction that ended between two looks gets both signs, one after the other.
      const delay = before === undefined ? PACKET_MS : 0
      if (interaction.failed) show({ edge: to, kind: 'failed', title: `${nodeName(to)} failed`, text: interaction.reason ?? (interaction.result || state) }, delay)
      else if (state === 'input-required') show({ edge: to, kind: 'response', title: `${nodeName(to)} asks for approval`, text: interaction.result || 'approval needed' }, delay)
      else show({ edge: to, kind: 'response', title: `${nodeName(to)} replied`, text: interaction.result || state }, delay)
    }
  }, [interactions])

  const [router, ...specialists] = agents
  // Every specialist has an edge to the router, used or not, so the map also shows who could be asked.
  const edges = new Map<string, MapEdge>(
    specialists.map(agent => {
      const between = interactions.filter(interaction => interaction.from === router.id && interaction.to === agent.id)
      // An edge is lit only while something is in flight on it or one of its signs is still up:
      // a sign lasts five seconds, so after that long without activity the edge is back to normal.
      const lastSign = signs.findLast(sign => sign.edge === agent.id)
      return [agent.id, { count: between.length, active: between.some(interaction => interaction.active), recent: !!lastSign, failed: lastSign?.kind === 'failed' }]
    }),
  )

  const selected = selectedId !== undefined && agents.some(agent => agent.id === selectedId) ? selectedId : undefined
  // Selecting a node or an edge also opens its interactions.
  function toggle(id: string) {
    if (selected !== id) setListOpen(true)
    setSelectedId(selected === id ? undefined : id)
  }
  const listed = interactions
    .filter(interaction => !selected || interaction.from === selected || interaction.to === selected)
    .sort((a, b) => b.at - a.at)

  // What the graph draws from. It paints on its own clock, outside React, so it reads the
  // latest of everything here.
  const live = useRef({ agents, workingIds, edges, signs, selected, toggle })
  useEffect(() => {
    live.current = { agents, workingIds, edges, signs, selected, toggle }
  })

  // The graph is drawn on a canvas by force-graph, which needs the browser: loaded on mount.
  useEffect(() => {
    const holder = graphRef.current!
    let created: MapGraph | undefined
    let cancelled = false
    const observer = new ResizeObserver(([entry]) => {
      if (!created) return
      created.width(entry.contentRect.width).height(entry.contentRect.height)
      if (created.graphData().nodes.some(node => node.x !== undefined)) created.zoomToFit(200, MAP_FIT_PADDING)
    })
    import('force-graph').then(({ default: ForceGraph }) => {
      if (cancelled) return
      const theme = getComputedStyle(holder)
      const color = (name: string) => theme.getPropertyValue(name).trim()
      const radius = (node: MapNode) => (node.id === live.current.agents[0]?.id ? 32 : 22)
      // Text with an outline in the panel colour, so it stays readable over an edge.
      const label = (ctx: CanvasRenderingContext2D, text: string, y: number, font: string, fill: string) => {
        ctx.font = `${font} ${MAP_FONT}`
        ctx.lineWidth = 4
        ctx.lineJoin = 'round'
        ctx.strokeStyle = color('--panel')
        ctx.strokeText(text, 0, y)
        ctx.fillStyle = fill
        ctx.fillText(text, 0, y)
      }

      // A node: a tinted disc outlined in the agent's own colour, inside a dashed orbit.
      const paintNode = (node: MapNode, ctx: CanvasRenderingContext2D) => {
        const { agents, workingIds, selected } = live.current
        const agent = agents.find(other => other.id === node.id)
        if (!agent || node.x === undefined || node.y === undefined) return
        const isRouter = agent === agents[0]
        const isSelected = selected === node.id
        const status = agentStatus(agent, workingIds.has(agent.id))
        const own = `hsl(${hue(agent.id)}, 65%, 50%)`
        const r = radius(node)
        const now = performance.now()
        const alpha = status === 'disabled' ? 0.45 : 1
        ctx.save()
        ctx.translate(node.x, node.y)

        // Working: a ring that keeps spreading out from the node, like a radar ping.
        if (status === 'working') {
          const spread = (now % PACKET_MS) / PACKET_MS
          ctx.beginPath()
          ctx.arc(0, 0, r * (1 + 0.9 * spread), 0, 2 * Math.PI)
          ctx.globalAlpha = 0.9 * (1 - spread)
          ctx.lineWidth = 2
          ctx.strokeStyle = color('--working')
          ctx.stroke()
        }

        // The orbit: dotted, slowly turning dashes around the router, solid when selected.
        ctx.save()
        ctx.globalAlpha = alpha * (isSelected ? 1 : hovered.current === node.id ? 0.9 : isRouter ? 0.6 : 0.35)
        ctx.lineWidth = isSelected ? 2 : 1.5
        ctx.strokeStyle = isSelected ? color('--link') : own
        if (!isSelected) ctx.setLineDash(isRouter ? [12, 7] : [2, 6])
        if (isRouter) ctx.rotate((now / 16000) * 2 * Math.PI)
        ctx.beginPath()
        ctx.arc(0, 0, r + 6, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.restore()

        ctx.beginPath()
        ctx.arc(0, 0, r, 0, 2 * Math.PI)
        ctx.globalAlpha = alpha
        ctx.fillStyle = color('--panel')
        ctx.fill()
        ctx.globalAlpha = alpha * 0.14
        ctx.fillStyle = own
        ctx.fill()
        ctx.globalAlpha = alpha
        ctx.lineWidth = 2
        if (status === 'offline') {
          ctx.strokeStyle = color('--failed')
          ctx.setLineDash([4, 3])
        } else {
          ctx.strokeStyle = own
          ctx.shadowColor = own
          ctx.shadowBlur = 12
        }
        ctx.stroke()
        ctx.shadowBlur = 0
        ctx.setLineDash([])

        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = `700 12px ${MAP_FONT}`
        ctx.fillStyle = color('--text')
        ctx.fillText(initials(agent.id), 0, 1)
        label(ctx, nodeName(agent.id).toUpperCase(), r + 18, '600 11px', color('--text'))
        const tone = status === 'idle' ? '--done' : status === 'working' ? '--working' : status === 'offline' ? '--failed' : '--muted'
        label(ctx, `● ${status === 'working' ? 'WORKING…' : status.toUpperCase()}`, r + 33, '10px', color(tone))
        ctx.restore()
      }

      // An edge, always from the router to a specialist.
      const paintLink = (link: LinkObject<MapNode>, ctx: CanvasRenderingContext2D) => {
        const { source: from, target: to } = link
        if (typeof from !== 'object' || typeof to !== 'object' || from.x === undefined || from.y === undefined || to.x === undefined || to.y === undefined) return
        const { edges, selected, agents } = live.current
        const edge = edges.get(to.id)
        ctx.save()
        if (selected && selected !== agents[0]?.id && selected !== to.id) ctx.globalAlpha = 0.2
        ctx.lineWidth = edge?.active || edge?.failed || edge?.recent ? 2.5 : 1
        if (edge?.active) {
          // In flight: glowing dashes that run from the asker to the asked.
          ctx.strokeStyle = ctx.shadowColor = color('--working')
          ctx.shadowBlur = 8
          ctx.setLineDash([7, 6])
          ctx.lineDashOffset = -((performance.now() / 600) % 1) * 13
        } else if (edge?.failed) {
          ctx.strokeStyle = ctx.shadowColor = color('--failed')
          ctx.shadowBlur = 6
        } else if (edge?.recent) {
          ctx.strokeStyle = color('--link')
          ctx.globalAlpha *= 0.55
        } else {
          ctx.strokeStyle = color('--muted')
          ctx.globalAlpha *= 0.6
          ctx.setLineDash([2, 6])
        }
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(to.x, to.y)
        ctx.stroke()
        ctx.restore()
        if (!edge?.count) return
        // How many times the edge has been used, over its middle.
        ctx.save()
        ctx.translate((from.x + to.x) / 2, (from.y + to.y) / 2)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        label(ctx, String(edge.count), 0, '700 10px', color('--text'))
        ctx.restore()
      }

      // After the nodes: the dots that run along the edges, and the signs, which are HTML and
      // have to follow their edge while the layout moves or the user zooms.
      const paintSigns = (ctx: CanvasRenderingContext2D) => {
        const now = performance.now()
        for (const sign of live.current.signs) {
          const progress = (now - sign.at) / PACKET_MS
          const ends = edgeEnds(graph, sign.edge)
          if (progress >= 1 || !ends) continue
          // A request runs from the asker to the asked; the answer runs back.
          const [a, b] = sign.kind === 'request' ? ends : [ends[1], ends[0]]
          const run = Math.min(Math.max((progress - 0.1) / 0.75, 0), 1)
          const eased = run * run * (3 - 2 * run)
          ctx.save()
          ctx.globalAlpha = progress < 0.1 ? progress / 0.1 : progress > 0.85 ? (1 - progress) / 0.15 : 1
          ctx.fillStyle = ctx.shadowColor = color(sign.kind === 'request' ? '--link' : sign.kind === 'failed' ? '--failed' : '--done')
          ctx.shadowBlur = 12
          ctx.beginPath()
          ctx.arc(a.x + (b.x - a.x) * eased, a.y + (b.y - a.y) * eased, 5, 0, 2 * Math.PI)
          ctx.fill()
          ctx.restore()
        }
        for (const element of holder.parentElement!.querySelectorAll<HTMLElement>('.map-sign')) {
          const middle = edgeMiddle(graph, element.dataset.edge!)
          if (!middle) continue
          element.style.left = `${middle.x}px`
          element.style.top = `${middle.y}px`
        }
      }

      const savePins = () => {
        const pins = graph.graphData().nodes.flatMap(node => (node.fx === undefined || node.fy === undefined ? [] : [[node.id, { x: node.fx, y: node.fy }]]))
        localStorage.setItem(MAP_PINS_KEY, JSON.stringify(Object.fromEntries(pins)))
        setPinned(pins.length > 0)
      }

      const graph: MapGraph = new ForceGraph<MapNode>(holder)
        .width(holder.clientWidth)
        .height(holder.clientHeight)
        // Nothing here pauses: the orbits, the pings and the dots keep moving.
        .autoPauseRedraw(false)
        .minZoom(0.3)
        .maxZoom(4)
        .warmupTicks(40)
        .cooldownTime(4000)
        .nodeCanvasObject(paintNode)
        .nodePointerAreaPaint((node, paint, ctx) => {
          if (node.x === undefined || node.y === undefined) return
          ctx.fillStyle = paint
          ctx.beginPath()
          ctx.arc(node.x, node.y, radius(node) + 6, 0, 2 * Math.PI)
          ctx.fill()
        })
        .linkCanvasObject(paintLink)
        // A wide invisible line, so the edge is easy to click.
        .linkPointerAreaPaint((link, paint, ctx) => {
          const { source: from, target: to } = link
          if (typeof from !== 'object' || typeof to !== 'object' || from.x === undefined || from.y === undefined || to.x === undefined || to.y === undefined) return
          ctx.strokeStyle = paint
          ctx.lineWidth = 16
          ctx.beginPath()
          ctx.moveTo(from.x, from.y)
          ctx.lineTo(to.x, to.y)
          ctx.stroke()
        })
        .onRenderFramePost(paintSigns)
        .onNodeHover(node => (hovered.current = node?.id))
        .onNodeClick(node => live.current.toggle(node.id))
        .onLinkClick(link => typeof link.target === 'object' && live.current.toggle(link.target.id))
        // A dragged node stays where it was dropped.
        .onNodeDragEnd(node => {
          node.fx = node.x
          node.fy = node.y
          savePins()
        })
        .onEngineStop(() => {
          if (fit.current) graph.zoomToFit(400, MAP_FIT_PADDING)
          fit.current = false
        })
      // Far enough apart that the labels of two neighbours do not run into each other.
      graph.d3Force('charge')?.strength(-1200)
      graph.d3Force('link')?.distance(220)
      created = graph
      observer.observe(holder)
      // The graph is itself a function, which React would call if handed over bare.
      setGraph(() => graph)
    })
    return () => {
      cancelled = true
      observer.disconnect()
      created?._destructor()
      holder.replaceChildren()
      setGraph(undefined)
    }
  }, [])

  // The nodes are handed over again only when an agent joins or leaves: the ones already there
  // are kept as they are, so they stay where the layout put them.
  const ids = agents.map(agent => agent.id).join(' ')
  useEffect(() => {
    if (!graph) return
    const known = new Map(graph.graphData().nodes.map(node => [node.id, node]))
    const pins = readPins()
    const nodes = (ids ? ids.split(' ') : []).map((id): MapNode => known.get(id) ?? { id, ...(pins[id] && { fx: pins[id].x, fy: pins[id].y }) })
    fit.current = true
    graph.graphData({ nodes, links: nodes.slice(1).map(node => ({ source: nodes[0].id, target: node.id })) })
    setPinned(nodes.some(node => node.fx !== undefined))
  }, [graph, ids])

  function resetLayout() {
    if (!graph) return
    localStorage.removeItem(MAP_PINS_KEY)
    for (const node of graph.graphData().nodes) node.fx = node.fy = undefined
    setPinned(false)
    fit.current = true
    graph.d3ReheatSimulation()
  }

  // One sign per edge: a newer one replaces the one before it.
  const shownSigns = [...new Map(signs.map(sign => [sign.edge, sign])).values()]
  const online = agents.filter(agent => agent.card && agent.enabled !== false).length
  const inFlight = interactions.filter(interaction => interaction.active).length

  return (
    <section className="agent-map" aria-label="Agent map">
      <div className="map-canvas">
        <div className="map-graph" ref={graphRef} role="img" aria-label="Graph of the registered agents" />
        {!router && <p className="empty">No agents are registered yet.</p>}
        {graph &&
          shownSigns.map(sign => {
            const middle = edgeMiddle(graph, sign.edge)
            if (!middle) return null
            return (
              <div key={sign.key} className={`map-sign ${sign.kind}`} data-edge={sign.edge} style={{ left: middle.x, top: middle.y }}>
                <b>{sign.title}</b>
                <span>{sign.text}</span>
              </div>
            )
          })}
        {router && (
          <p className="map-hud">
            <span>
              agents <b>{agents.length}</b>
            </span>
            <span>
              online <b>{online}</b>
            </span>
            <span>
              in flight <b>{inFlight}</b>
            </span>
            <span>
              interactions <b>{interactions.length}</b>
            </span>
          </p>
        )}
        <div className="map-tools">
          {pinned && (
            <button type="button" className="quiet" onClick={resetLayout}>
              Reset layout
            </button>
          )}
          <button type="button" className="drawer-toggle" aria-expanded={listOpen} onClick={() => setListOpen(open => !open)}>
            Interactions <small>{listed.length}</small>
          </button>
        </div>
        <p className="map-legend">
          <span className="used">just used</span>
          <span className="active">in flight</span>
          <span className="failed">just failed</span>
          <span>quiet</span>
        </p>
      </div>
      {/* Always mounted so it can slide; it covers the right edge of the map while open. */}
      <div className={`drawer map-list${listOpen ? ' open' : ''}`} role="region" aria-label="Interactions" aria-hidden={!listOpen}>
        <div className="drawer-head">
          <h2>{selected ? `${nodeName(selected)} interactions` : 'All interactions'}</h2>
          {selected && (
            <button type="button" className="quiet" onClick={() => setSelectedId(undefined)}>
              Show all
            </button>
          )}
          <button type="button" className="close" onClick={() => setListOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <p className="hint">
          {agents.length} registered {agents.length === 1 ? 'agent' : 'agents'} · {listed.length} {listed.length === 1 ? 'interaction' : 'interactions'}.
          Select a node or an edge to narrow the list; drag a node to move it, scroll to zoom.
        </p>
        {listed.length === 0 && <p className="empty">Nothing yet.</p>}
        {listed.map(interaction => (
          <article key={interaction.key}>
            <div className="row">
              <span className={`badge ${interaction.state}`}>{interaction.state}</span>
              {interaction.reason && <span className="badge failed">{interaction.reason}</span>}
              <span className="agent">
                {nodeName(interaction.from)} → {nodeName(interaction.to)}
              </span>
              {interaction.at > 0 && <time>{new Date(interaction.at).toLocaleTimeString()}</time>}
            </div>
            <span className="prompt">{interaction.text || '(delegated request)'}</span>
            {interaction.result && (
              <details className="answer">
                <summary>Reply</summary>
                <Markdown text={interaction.result} />
              </details>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

// The same limit the file's agent applies (servers/mismo-check/src/mastra/parse.ts).
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024

const newSession = (): Session => ({ id: crypto.randomUUID(), contextId: crypto.randomUUID() })
// A session is named after its first message.
const sessionTitle = (prompt: string) => (prompt.length > 32 ? `${prompt.slice(0, 32).trimEnd()}…` : prompt)

// The title of a chat while the user is typing a new one. Enter or leaving the field saves it, Escape keeps the old one.
function TitleInput({ title, onSave, onCancel }: { title: string; onSave: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(title)
  // Escape removes the field, which blurs it: that blur must not save.
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onSave(value)
    else onCancel()
  }
  return (
    <input
      className="title-input"
      aria-label="Chat name"
      value={value}
      maxLength={80}
      autoFocus
      onFocus={event => event.target.select()}
      onChange={event => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={event => {
        if (event.key === 'Enter') finish(true)
        else if (event.key === 'Escape') finish(false)
      }}
    />
  )
}

export default function Page() {
  const [input, setInput] = useState('')
  // A MISMO file waiting to go with the next message, and why the last one could not be attached or sent.
  const [attachment, setAttachment] = useState<{ name: string; xml: string }>()
  const [attachError, setAttachError] = useState<string>()
  const [uploading, setUploading] = useState(false)
  const [sessions, setSessions] = useState<Session[]>(() => [newSession()])
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0].id)
  const [tasks, setTasks] = useState<RouterTask[]>([])
  const [specialistTasks, setSpecialistTasks] = useState<SpecialistTask[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [openAgentId, setOpenAgentId] = useState<string>()
  const [settingsAgentId, setSettingsAgentId] = useState<string>()
  const [signals, setSignals] = useState<Signal[]>([])
  const [discovery, setDiscovery] = useState<Discovery>()
  const [poppyOpen, setPoppyOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [mcp, setMcp] = useState<McpDoor>()
  const [mcpOpen, setMcpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<'chat' | 'map'>('chat')
  const [theme, setTheme] = useState<Theme>('light')
  const [conversations, setConversations] = useState<PapConversation[]>([])
  // The borrower's id at this company, chosen by their personal agent. One per page load.
  // Who is signed in (Supabase). The borrower's personal agent speaks for this user over PAP.
  const [user, setUser] = useState<{ id: string; email?: string }>()
  const userId = `usr_${user?.id ?? 'anonymous'}`
  // Set once the user's stored chat is on the page: from then on, changes are saved.
  const [loaded, setLoaded] = useState(false)
  const [storeError, setStoreError] = useState<string>()
  // The session the user asked to close, with what it has in the background, until they answer.
  const [closing, setClosing] = useState<{ session: Session; jobs: Job[]; error?: string }>()
  // The chat being renamed, and where: in the list of chats or in the header of the open one.
  const [renaming, setRenaming] = useState<{ id: string; at: 'list' | 'head' }>()
  // The background delegations the user asked to cancel, until the router confirms.
  const [cancelingIds, setCancelingIds] = useState<ReadonlySet<string>>(new Set())
  // What each stored session and turn was last saved as (see taskSignature).
  const saved = useRef(new Map<string, string>())
  const saving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restored = useRef(false)
  const [now, setNow] = useState(() => Date.now())
  const counter = useRef(0)
  // Where each PAP conversation has been read up to (event id), by local id.
  const cursors = useRef(new Map<string, string>())
  const asideRef = useRef<HTMLElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  // Last seen state of every specialist task; null until the first poll, so
  // tasks that already existed on page load are not animated.
  const seen = useRef<Map<string, string> | null>(null)

  // Compares a poll with the previous one: a new task is a request from the
  // router to that specialist, a task reaching a final state is the response.
  function detectSignals(polled: SpecialistTask[]) {
    const previous = seen.current
    seen.current = new Map(polled.map(task => [`${task.agent}/${task.id}`, taskState(task)]))
    if (!previous) return

    const items = [...(asideRef.current?.querySelectorAll<HTMLElement>('.agent-item[data-agent]') ?? [])]
    const centre = (item: HTMLElement) => item.offsetTop + item.offsetHeight / 2
    const created: Signal[] = []
    const add = (task: SpecialistTask, kind: Signal['kind'], delay: number) => {
      const router = items[0]
      const specialist = items.find(item => item.dataset.agent === task.agent)
      if (!router || !specialist || router === specialist) return
      const [from, to] = kind === 'request' ? [router, specialist] : [specialist, router]
      const state = taskState(task)
      const row = specialist.getBoundingClientRect()
      const result = (task.artifacts ?? []).map(artifact => partsText(artifact.parts)).join('')
      // A task that failed says why with a reason code.
      const reason = readReason(partsText(task.status?.message?.parts))
      created.push({
        key: counter.current++,
        agent: task.agent,
        kind,
        text: kind === 'request' ? partsText(task.history?.[0]?.parts) || 'delegated request' : result || (reason ? `${state}: ${reason}` : state),
        failed: kind === 'response' && state !== 'completed',
        top: centre(from),
        // A lane down the right edge of the rows, clear of avatars and names.
        left: from.offsetLeft + from.offsetWidth - 12,
        dy: centre(to) - centre(from),
        noteTop: row.top + row.height / 2,
        noteLeft: row.right + 10,
        delay,
      })
    }

    for (const task of polled) {
      const before = previous.get(`${task.agent}/${task.id}`)
      const done = TERMINAL.includes(taskState(task))
      if (before === undefined) add(task, 'request', 0)
      // A task that finished between two polls gets both, one after the other.
      if (done && (before === undefined || !TERMINAL.includes(before))) add(task, 'response', before === undefined ? 1200 : 0)
    }
    if (!created.length) return
    setSignals(current => [...current, ...created])
    for (const signal of created) {
      setTimeout(() => setSignals(current => current.filter(other => other.key !== signal.key)), SIGNAL_MS + signal.delay)
    }
  }

  // The theme is light unless this browser chose dark before; the stylesheet reads it off <html>.
  useEffect(() => {
    if (localStorage.getItem('theme') === 'dark') setTheme('dark')
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  function changeTheme(next: Theme) {
    setTheme(next)
    localStorage.setItem('theme', next)
  }

  // Discovery: the router and whichever specialists are registered with it now. Asked again
  // every few seconds, since a specialist can register or drop out at any time.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      fetch('/api/agents')
        .then(res => res.json())
        .then(data => setAgents(data.agents))
        .catch(() => {})
        .finally(() => {
          timer = setTimeout(load, 3000)
        })
    load()
    return () => clearTimeout(timer)
  }, [])

  // PAP discovery: the router's poppy.json, retried while the router is still starting.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      fetch('/api/poppy/discovery')
        .then(res => res.json())
        .then((data: Discovery) => {
          setDiscovery(data)
          if (!data.document) timer = setTimeout(load, 2000)
        })
        .catch(() => {
          timer = setTimeout(load, 2000)
        })
    load()
    return () => clearTimeout(timer)
  }, [])

  // The MCP front door, retried while the router is still starting.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      fetch('/api/mcp')
        .then(res => res.json())
        .then((data: McpDoor) => {
          setMcp(data)
          if (!data.tools) timer = setTimeout(load, 2000)
        })
        .catch(() => {
          timer = setTimeout(load, 2000)
        })
    load()
    return () => clearTimeout(timer)
  }, [])

  // A clock for the expiry countdown and for how long a turn has been in progress, running only
  // while an approval is awaited or a turn is in progress.
  const ticking =
    conversations.some(conversation => conversation.operationState === 'awaiting' || conversation.working) ||
    tasks.some(task => !TERMINAL.includes(task.state))
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])

  // Async style 2: poll every specialist's task list.
  useEffect(() => {
    const poll = () =>
      fetch('/api/specialist-tasks')
        .then(res => res.json())
        .then(data => {
          setSpecialistTasks(data.tasks ?? [])
          if (data.tasks) detectSignals(data.tasks)
        })
        .catch(() => {})
    poll()
    const timer = setInterval(poll, 1000)
    return () => clearInterval(timer)
  }, [])

  // Async style 4: long-poll the router for the active session's background delegations. Each
  // one is shown as a task of its own: in progress in the pinned bar, then as a reply in the thread.
  const activeContextId = sessions.find(session => session.id === activeSessionId)?.contextId
  useEffect(() => {
    // Not before the stored chat is in (or could not be read): it decides which session is active.
    if (!activeContextId || (!loaded && !storeError)) return
    const controller = new AbortController()
    const follow = async () => {
      let version = -1
      while (!controller.signal.aborted) {
        try {
          const out = await fetch(`/api/session-jobs?${new URLSearchParams({ contextId: activeContextId, version: String(version) })}`, { signal: controller.signal }).then(res => res.json())
          if (out.error) throw new Error(out.error)
          version = out.version
          const jobs: Job[] = out.jobs
          setTasks(current => {
            // A job this page still shows as running that the router no longer has: it restarted.
            const next = current.map(task =>
              task.background && task.sessionId === activeSessionId && !TERMINAL.includes(task.state) && !jobs.some(job => `job-${job.id}` === task.localId)
                ? settleTask({ ...task, state: 'failed', answer: LOST })
                : task,
            )
            for (const job of jobs) {
              const localId = `job-${job.id}`
              const index = next.findIndex(task => task.localId === localId)
              const previous = index < 0 ? undefined : next[index]
              if (previous?.state === job.state) continue
              const at = Date.now() - job.startedAt
              const task = settleTask({
                localId,
                sessionId: activeSessionId,
                prompt: job.request,
                startedAt: job.startedAt,
                background: { agent: job.agent },
                ...previous,
                state: job.state,
                answer: job.answer ?? '',
                log: [
                  ...(previous?.log ?? [{ at: 0, label: `delegated to ${job.agent}` }, { at, label: 'turn ended · running in the background' }]),
                  ...(job.state === 'working' ? [] : [{ at, label: job.state === 'canceled' ? 'canceled by the user' : `result delivered → ${job.state}` }]),
                ],
              })
              if (index < 0) next.push(task)
              else next[index] = task
            }
            return next
          })
        } catch {
          if (controller.signal.aborted) return
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }
    }
    follow()
    return () => controller.abort()
  }, [activeContextId, activeSessionId, loaded, storeError === undefined])

  // Keep the newest message in view as turns are added and replies stream in.
  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight })
  }, [tasks, conversations, activeSessionId, view])

  // A turn is stamped the first time it stops being in progress.
  // A background result has to be seen: it starts out unread.
  const settleTask = (task: RouterTask): RouterTask =>
    TERMINAL.includes(task.state) && !task.settledAt ? { ...task, settledAt: Date.now(), ...(task.background && { unread: true }) } : task
  const markRead = (localId: string) => setTasks(current => current.map(task => (task.localId === localId ? { ...task, unread: false } : task)))

  // The browser tab shows how many background results are waiting, so they are noticed from another tab.
  const unreadTotal = tasks.filter(task => task.unread).length
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '')
    document.title = unreadTotal ? `(${unreadTotal}) ${base}` : base
  }, [unreadTotal])
  const settleConversation = (conversation: PapConversation): PapConversation =>
    !conversation.working && !conversation.settledAt ? { ...conversation, settledAt: Date.now() } : conversation

  const patch = (localId: string, update: (task: RouterTask) => RouterTask) =>
    setTasks(current => current.map(task => (task.localId === localId ? settleTask(update(task)) : task)))

  // Async style 1: send a message and follow the task over an SSE stream.
  // Nothing here blocks the UI, so several tasks can be in flight at once.
  // Switches a specialist on or off on the router. Shown at once, put back if the router refuses.
  async function toggleAgent(id: string, enabled: boolean) {
    const set = (value: boolean | null) =>
      setAgents(current => current.map(agent => (agent.id === id ? { ...agent, enabled: value } : agent)))
    set(enabled)
    const res = await fetch(`/api/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => null)
    if (!res?.ok) set(!enabled)
  }

  // Sets how long an agent's server waits before it starts on a message. Returns an error to show, if any.
  async function setAgentDelay(id: string, delayMs: number) {
    const res = await fetch(`/api/agents/${id}/delay`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs }),
    }).catch(() => null)
    const data = await res?.json().catch(() => null)
    if (!res?.ok) return data?.error ?? 'Could not reach the server'
    setAgents(current => current.map(agent => (agent.id === id ? { ...agent, delayMs: data.delayMs } : agent)))
  }

  // Sets the fault an agent injects. Shown at once, put back if its server refuses.
  async function setAgentFault(id: string, fault: string) {
    const set = (value: string | null) => setAgents(current => current.map(agent => (agent.id === id ? { ...agent, fault: value } : agent)))
    const before = agents.find(agent => agent.id === id)?.fault ?? null
    set(fault)
    const res = await fetch(`/api/agents/${id}/fault`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fault }),
    }).catch(() => null)
    if (!res?.ok) set(before)
  }

  async function submit(session: Session, prompt: string) {
    const localId = `local-${crypto.randomUUID()}`
    const startedAt = Date.now()
    setTasks(current => [
      ...current,
      {
        localId,
        sessionId: session.id,
        prompt,
        startedAt,
        state: 'sending',
        answer: '',
        log: [{ at: 0, label: 'message/stream sent' }],
      },
    ])

    const log = (task: RouterTask, label: string): RouterTask => ({
      ...task,
      log: [...task.log, { at: Date.now() - startedAt, label }],
    })

    const handle = (event: any) => {
      // The first event is the Task itself (older servers omit `kind` on it).
      if (event.kind === 'task' || (!event.kind && event.status)) {
        patch(localId, task => log({ ...task, taskId: event.id, state: event.status.state }, `task created → ${event.status.state}`))
      } else if (event.kind === 'status-update') {
        const note = partsText(event.status.message?.parts)
        const failed = event.status.state === 'failed'
        // A failed turn is normally an escalation: show its sentence, not the wire text.
        const stop = failed ? readEscalation(note) : undefined
        patch(localId, task =>
          log(
            { ...task, state: event.status.state, answer: failed ? (stop?.text ?? note) : task.answer, escalation: stop?.escalation },
            stop ? `status → failed (${stop.escalation.reasonCode})` : `status → ${event.status.state}`,
          ),
        )
      } else if (event.kind === 'artifact-update') {
        const chunk = partsText(event.artifact.parts)
        patch(localId, task => {
          const next = { ...task, answer: event.append ? task.answer + chunk : chunk }
          return event.append ? next : log(next, 'first artifact chunk')
        })
      } else if (event.kind === 'error') {
        patch(localId, task => log({ ...task, state: 'failed', answer: event.message }, 'stream error'))
      }
    }

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prompt, contextId: session.contextId }),
      })
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        const frames = buffer.split('\n\n')
        buffer = frames.pop()!
        for (const frame of frames) {
          if (frame.startsWith('data: ')) handle(JSON.parse(frame.slice(6)))
        }
      }
      patch(localId, task => log(task, 'stream closed'))
    } catch (error) {
      patch(localId, task => log({ ...task, state: 'failed', answer: String(error) }, 'request failed'))
    }
  }

  const patchConversation = (localId: string, update: (conversation: PapConversation) => PapConversation) =>
    setConversations(current => current.map(conversation => (conversation.localId === localId ? settleConversation(update(conversation)) : conversation)))

  // Sends one PAP message (text, or the approval of an operation) and returns the conversation id.
  async function sendPap(conversation: Pick<PapConversation, 'localId' | 'startedAt' | 'conversationId'>, message: object, label: string) {
    const { localId, startedAt } = conversation
    const res = await fetch('/api/poppy/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, conversationId: conversation.conversationId, ...message }),
    })
    const wire = await res.json()
    const failed = wire.status >= 400 || wire.status === 0
    const conversationId: string | undefined = wire.response?.conversation_id ?? conversation.conversationId
    patchConversation(localId, current => ({
      ...current,
      conversationId,
      working: !failed,
      error: failed ? (wire.response?.error ?? 'request failed') : undefined,
      log: [...current.log, { at: Date.now() - startedAt, label: `${label} → ${wire.status || 'no answer'}`, detail: wire }],
    }))
    return failed ? undefined : conversationId
  }

  // Async style 3: long-poll the conversation's events until the company stops working.
  async function follow(localId: string, startedAt: number, conversationId: string, as = userId) {
    let working = true
    while (working) {
      const cursor = cursors.current.get(localId)
      const query = new URLSearchParams({ userId: as, conversationId, ...(cursor && { cursor }) })
      const out = await fetch(`/api/poppy/events?${query}`).then(res => res.json())
      if (out.error) {
        patchConversation(localId, current => ({ ...current, working: false, error: out.error }))
        return
      }
      if (out.cursor) cursors.current.set(localId, out.cursor)
      working = out.working
      const at = Date.now() - startedAt
      patchConversation(localId, current => {
        let next = { ...current, working: out.working }
        for (const event of out.events) {
          // Our own messages come back as events too; they are already in the log.
          if (event.type !== 'message' || event.message.role !== 'company') continue
          const { text, data, extensions } = event.message
          const operation: Operation | undefined = extensions?.operations?.operation
          const label = operation
            ? 'operation received: approval needed'
            : extensions?.operations?.declined
              ? 'approval declined by the company'
              : `company message${data?.operation ? ` · operation ${data.operation.status}` : ''}`
          next = { ...next, log: [...next.log, { at, label, detail: event }] }
          if (operation) next = { ...next, operation, operationState: 'awaiting' }
          else next = { ...next, answer: text ?? next.answer, operationState: data?.operation?.status ?? next.operationState }
        }
        return next
      })
    }
  }

  // The borrower's tap on Approve: an approval of exactly this revision of the operation.
  async function approve(conversation: PapConversation) {
    const { operation_id, revision } = conversation.operation!
    const approval = { operation_id, revision, approver: 'user', approved_at: Math.floor(Date.now() / 1000), input_type: 'tap' }
    patchConversation(conversation.localId, current => ({ ...current, operationState: 'approved' }))
    try {
      const conversationId = await sendPap(conversation, { approval }, 'POST …/messages (approval)')
      if (conversationId) await follow(conversation.localId, conversation.startedAt, conversationId)
    } catch (error) {
      patchConversation(conversation.localId, current => ({ ...current, working: false, error: String(error) }))
    }
  }

  // A turn whose stream a page reload cut: the task went on at the router, so it is followed
  // from here by polling it (`tasks/get`) until it settles.
  async function resume(localId: string, startedAt: number, taskId: string | undefined) {
    const note = (task: RouterTask, label: string): RouterTask => ({ ...task, log: [...task.log, { at: Date.now() - startedAt, label }] })
    const lost = () => patch(localId, task => note({ ...task, state: 'failed', answer: task.answer || LOST }, 'task lost'))
    if (!taskId) return lost()
    patch(localId, task => note(task, 'page reloaded · following with tasks/get'))
    for (;;) {
      const out = await fetch(`/api/tasks/${taskId}`)
        .then(res => res.json())
        .catch(error => ({ error: String(error) }))
      if (!out.task) return lost()
      const state: string = out.task.status?.state ?? 'unknown'
      const answer = ((out.task.artifacts ?? []) as { parts?: { text?: string }[] }[]).map(artifact => partsText(artifact.parts)).join('')
      if (state === 'failed') {
        const text = partsText(out.task.status.message?.parts)
        const stop = readEscalation(text)
        return patch(localId, task => note({ ...task, state, answer: stop?.text ?? text, escalation: stop?.escalation }, 'status → failed'))
      }
      // Settled, or waiting for something only a new message can give.
      if (TERMINAL.includes(state) || state.endsWith('-required')) return patch(localId, task => note({ ...task, state, answer: answer || task.answer }, `status → ${state}`))
      patch(localId, task => (task.state === state && !answer ? task : { ...task, state, answer: answer || task.answer }))
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  // On load: who is signed in, then their stored chat, then whatever was still in progress.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    void (async () => {
      const { data } = await createClient().auth.getUser()
      if (!data.user) return window.location.assign('/login')
      setUser({ id: data.user.id, email: data.user.email })
      let chat: Awaited<ReturnType<typeof loadChat>>
      try {
        chat = await loadChat()
      } catch (error) {
        return setStoreError(error instanceof Error ? error.message : String(error))
      }
      if (chat.sessions.length) {
        const known = new Set(chat.sessions.map(session => session.id))
        const turns = chat.turns.filter(turn => known.has(turn.sessionId))
        const storedTasks = turns.filter(turn => turn.kind !== 'pap').map(turn => turn.data as RouterTask)
        const storedConversations = turns.filter(turn => turn.kind === 'pap').map(turn => turn.data as PapConversation & { cursor?: string })
        for (const session of chat.sessions) saved.current.set(`session/${session.id}`, session.title ?? '')
        for (const task of storedTasks) saved.current.set(task.localId, taskSignature(task))
        for (const { cursor, ...conversation } of storedConversations) {
          if (cursor) cursors.current.set(conversation.localId, cursor)
          saved.current.set(conversation.localId, conversationSignature(conversation, cursor))
        }
        setSessions(chat.sessions)
        setActiveSessionId(chat.sessions.find(session => session.id === localStorage.getItem('active-session'))?.id ?? chat.sessions.at(-1)!.id)
        setTasks(storedTasks)
        // Newest first, as the page keeps them.
        setConversations(storedConversations.map(({ cursor: _cursor, ...conversation }) => conversation).reverse())

        // Background delegations are picked up again by their own long-poll.
        for (const task of storedTasks) {
          if (!task.background && !TERMINAL.includes(task.state) && !task.state.endsWith('-required')) void resume(task.localId, task.startedAt, task.taskId)
        }
        for (const conversation of storedConversations) {
          if (!conversation.working) continue
          if (conversation.conversationId) void follow(conversation.localId, conversation.startedAt, conversation.conversationId, `usr_${data.user.id}`)
          else patchConversation(conversation.localId, current => ({ ...current, working: false, error: 'Interrupted by a page reload.' }))
        }
      }
      setLoaded(true)
    })()
  }, [])

  useEffect(() => {
    if (loaded) localStorage.setItem('active-session', activeSessionId)
  }, [loaded, activeSessionId])

  // Saves what changed, a moment after it changed: the sessions that have something in them,
  // then their turns. The latest state is read when the timer fires, not when it was set.
  const latest = useRef({ sessions, tasks, conversations })
  latest.current = { sessions, tasks, conversations }
  useEffect(() => {
    if (!loaded || saving.current) return
    saving.current = setTimeout(async () => {
      const { sessions, tasks, conversations } = latest.current
      const used = sessions.filter(session => session.title)
      const usedIds = new Set(used.map(session => session.id))
      const turns: (StoredTurn & { signature: string })[] = [
        ...tasks.map(task => ({ id: task.localId, sessionId: task.sessionId, kind: task.background ? ('background' as const) : ('a2a' as const), startedAt: task.startedAt, data: task, signature: taskSignature(task) })),
        ...conversations.map(conversation => {
          const cursor = cursors.current.get(conversation.localId)
          return { id: conversation.localId, sessionId: conversation.sessionId, kind: 'pap' as const, startedAt: conversation.startedAt, data: { ...conversation, cursor }, signature: conversationSignature(conversation, cursor) }
        }),
      ]
      const changedSessions = used.filter(session => saved.current.get(`session/${session.id}`) !== session.title)
      const changedTurns = turns.filter(turn => usedIds.has(turn.sessionId) && saved.current.get(turn.id) !== turn.signature)
      try {
        await saveSessions(changedSessions)
        await saveTurns(changedTurns.map(({ signature: _signature, ...turn }) => turn))
        for (const session of changedSessions) saved.current.set(`session/${session.id}`, session.title!)
        for (const turn of changedTurns) saved.current.set(turn.id, turn.signature)
        setStoreError(undefined)
      } catch (error) {
        setStoreError(error instanceof Error ? error.message : String(error))
      }
      saving.current = undefined
      // Whatever changed while this was being written.
      const now = latest.current
      if (now.tasks !== tasks || now.conversations !== conversations || now.sessions !== sessions) setSessions(current => [...current])
    }, 400)
  }, [loaded, sessions, tasks, conversations])

  async function signOut() {
    await createClient().auth.signOut()
    window.location.assign('/login')
  }

  const activeSession = sessions.find(session => session.id === activeSessionId) ?? sessions[0]

  function send(prompt: string) {
    // Not before the stored chat is on the page: it would be replaced by it.
    if (!user || (!loaded && !storeError)) return
    const session = activeSession
    if (!session.title) setSessions(current => current.map(other => (other.id === session.id ? { ...other, title: sessionTitle(prompt) } : other)))
    return submit(session, prompt)
  }

  // From the sidebar, which also shows next to the agent map: the chat comes back into view.
  function openSession(id: string) {
    setActiveSessionId(id)
    setView('chat')
  }

  // An empty name keeps the old one. The new title is saved with the rest of the session.
  function renameSession(id: string, title: string) {
    const name = title.trim()
    if (name) setSessions(current => current.map(session => (session.id === id ? { ...session, title: name } : session)))
    setRenaming(undefined)
  }

  function openNewChat() {
    startSession()
    setView('chat')
  }

  function startSession() {
    // An untouched session is reused rather than piling up empty chats.
    const empty = sessions.find(session => !session.title)
    if (empty) return setActiveSessionId(empty.id)
    const session = newSession()
    setSessions(current => [...current, session])
    setActiveSessionId(session.id)
  }

  // Tells the router that a session was closed, so it stops what the session still has running.
  const stopSession = (session: Session) =>
    fetch(`/api/session-jobs?${new URLSearchParams({ contextId: session.contextId })}`, { method: 'DELETE' }).then(async res => {
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`)
    })

  // The Cancel button of a background delegation in the pinned bar. The router ends the job as
  // `canceled`, and the long-poll of the session brings that to the page.
  async function cancelJob(task: RouterTask) {
    const session = sessions.find(session => session.id === task.sessionId)
    if (!session) return
    setCancelingIds(current => new Set(current).add(task.localId))
    const res = await fetch(`/api/session-jobs?${new URLSearchParams({ contextId: session.contextId, jobId: task.localId.replace(/^job-/, '') })}`, { method: 'DELETE' }).catch(() => null)
    // Not canceled (the router did not answer, or the job had just finished): the button comes back.
    if (!res?.ok) setCancelingIds(current => new Set([...current].filter(id => id !== task.localId)))
  }

  // The X of a chat in the sidebar. A session is closed only after the user confirms, seeing
  // the delegations it has in the background, as closing stops them. The router is asked for
  // them now: only the active session is followed, so what the page knows of another one may be old.
  async function requestClose(session: Session) {
    const known = tasks
      .filter(task => task.sessionId === session.id && task.background && !TERMINAL.includes(task.state))
      .map(task => ({ id: task.localId.replace(/^job-/, ''), agent: task.background!.agent, request: task.prompt, startedAt: task.startedAt, state: task.state }))
    const jobs: Job[] = await fetch(`/api/session-jobs?${new URLSearchParams({ contextId: session.contextId, version: '-1', wait: '0' })}`)
      .then(res => res.json())
      .then(out => (Array.isArray(out.jobs) ? out.jobs : known))
      .catch(() => known)
    setClosing({ session, jobs: jobs.filter(job => job.state === 'working') })
  }

  async function confirmClose() {
    if (!closing) return
    try {
      await stopSession(closing.session)
    } catch (error) {
      // With nothing known to be running, a router that does not answer does not keep the chat open.
      if (closing.jobs.length) return setClosing({ ...closing, error: error instanceof Error ? error.message : String(error) })
    }
    closeSession(closing.session.id)
    setClosing(undefined)
  }

  // Closing a session drops its turns from the page. Its work on the router is stopped first (see requestClose).
  function closeSession(id: string) {
    const remaining = sessions.filter(session => session.id !== id)
    const next = remaining.length ? remaining : [newSession()]
    setSessions(next)
    if (saved.current.delete(`session/${id}`)) deleteSession(id).catch(error => setStoreError(String(error)))
    setTasks(current => current.filter(task => task.sessionId !== id))
    setConversations(current => current.filter(conversation => conversation.sessionId !== id))
    // The chat before it takes over (the one below it in the sidebar), or the new first one when the first closes.
    if (id === activeSessionId) setActiveSessionId(next[Math.max(0, sessions.findIndex(session => session.id === id) - 1)].id)
  }

  async function attach(file: File | undefined) {
    setAttachError(undefined)
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) return setAttachError(`${file.name} is larger than 4 MB.`)
    setAttachment({ name: file.name, xml: await file.text() })
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const file = attachment
    const prompt = input.trim() || (file ? 'Check this MISMO file.' : '')
    if (!prompt || uploading) return
    if (!file) {
      setInput('')
      return send(prompt)
    }
    // The file goes to the agent that checks it; the message carries only the id it answers with.
    setUploading(true)
    setAttachError(undefined)
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(file),
    }).catch(() => null)
    const out = await res?.json().catch(() => null)
    setUploading(false)
    // Nothing is sent, so the message and the file are still there to try again.
    if (!res?.ok || !out?.fileId) return setAttachError(out?.error ?? 'The file could not be uploaded.')
    setInput('')
    setAttachment(undefined)
    send(`${prompt}\n\n[Attached MISMO file "${file.name}", fileId: ${out.fileId}]`)
  }

  // An agent is working while any of its tasks has not reached a final state.
  // The first agent is the router, whose tasks are the ones streamed to this page.
  const workingIds = new Set(specialistTasks.filter(task => !TERMINAL.includes(taskState(task))).map(task => task.agent))
  const busySessionIds = new Set([
    ...tasks.filter(task => !TERMINAL.includes(task.state)).map(task => task.sessionId),
    ...conversations.filter(conversation => conversation.working).map(conversation => conversation.sessionId),
  ])
  if (agents[0] && busySessionIds.size) workingIds.add(agents[0].id)
  const unreadCounts = new Map<string, number>()
  for (const task of tasks) if (task.unread) unreadCounts.set(task.sessionId, (unreadCounts.get(task.sessionId) ?? 0) + 1)
  const router = agents[0]
  // The active session's thread: loan-officer tasks and borrower conversations, oldest first.
  const turns = [
    ...tasks.filter(task => task.sessionId === activeSession.id).map(task => ({ startedAt: task.startedAt, task, conversation: undefined })),
    ...conversations
      .filter(conversation => conversation.sessionId === activeSession.id)
      .map(conversation => ({ startedAt: conversation.startedAt, task: undefined, conversation })),
  ].sort((a, b) => a.startedAt - b.startedAt)
  // Only a delegation running in the background is minimized in the bar pinned above the
  // thread. A turn the router is still working on shows in the thread, under its prompt.
  const runningTurns = turns.filter(({ task }) => task?.background && !TERMINAL.includes(task.state))
  // The thread itself: every prompt with its reply below it, and every background result where
  // it arrived, which is below whatever was said while it was in progress.
  const thread = [
    ...turns.flatMap(turn => {
      if (!turn.task?.background) return [{ at: turn.startedAt, part: 'prompt' as const, turn }, { at: turn.startedAt, part: 'reply' as const, turn }]
      const at = turn.task.settledAt
      return at === undefined ? [] : [{ at, part: 'reply' as const, turn }]
    }),
  ].sort((a, b) => a.at - b.at)
  // The router passes its own context on to the specialists: the session's `contextId` for a
  // loan-officer turn, the PAP conversation id for a borrower turn. That ties a task to a session.
  const sessionContextIds = new Set([
    activeSession.contextId,
    ...conversations.filter(conversation => conversation.sessionId === activeSession.id).map(conversation => conversation.conversationId),
  ])
  const sessionTasks = specialistTasks.filter(task => sessionContextIds.has(task.contextId))
  const activeTaskCount = sessionTasks.filter(task => !TERMINAL.includes(taskState(task))).length
  const openAgent = agents.find(agent => agent.id === openAgentId)
  // Everything said between two nodes of the agent map, across all chat sessions.
  const routerId = router?.id ?? 'router'
  const interactions: Interaction[] = [
    ...tasks.filter(task => !task.background).map(task => ({
      key: task.localId,
      from: CALLERS[0].id,
      to: routerId,
      state: task.state,
      active: !TERMINAL.includes(task.state),
      failed: TERMINAL.includes(task.state) && task.state !== 'completed',
      text: task.prompt,
      result: task.answer,
      reason: task.escalation?.reasonCode,
      at: task.startedAt,
    })),
    ...conversations.map(conversation => ({
      key: conversation.localId,
      from: CALLERS[1].id,
      to: routerId,
      state: conversation.error ? 'failed' : conversation.working ? 'working' : conversation.operationState === 'awaiting' ? 'input-required' : 'completed',
      active: conversation.working,
      failed: !!conversation.error,
      text: conversation.prompt,
      result: conversation.error ?? conversation.answer,
      at: conversation.startedAt,
    })),
    ...specialistTasks.map(task => {
      const state = taskState(task)
      return {
        key: `${task.agent}/${task.id}`,
        from: routerId,
        to: task.agent,
        state,
        active: !TERMINAL.includes(state),
        failed: TERMINAL.includes(state) && state !== 'completed',
        text: partsText(task.history?.[0]?.parts),
        result: (task.artifacts ?? []).map(artifact => partsText(artifact.parts)).join(''),
        reason: readReason(partsText(task.status?.message?.parts)),
        at: Date.parse(task.status?.timestamp ?? '') || 0,
      }
    }),
  ]
  const settingsAgent = agents.find(agent => agent.id === settingsAgentId)

  return (
    <div className="layout">
      <aside ref={asideRef}>
        <h2>Front door</h2>
        <button type="button" className="agent-item" onClick={() => setPoppyOpen(true)}>
          <span className="avatar protocol">PAP</span>
          <span className="agent-name">Personal Agent Protocol</span>
          <span className="agent-status">{discovery?.document ? 'poppy.json published' : 'offline'}</span>
        </button>
        {/* No chat mode: an MCP client (the borrower's assistant) connects to this URL itself. */}
        <button type="button" className="agent-item" onClick={() => setMcpOpen(true)}>
          <span className="avatar protocol">MCP</span>
          <span className="agent-name">Model Context Protocol</span>
          <span className="agent-status">
            {mcp?.tools ? `${mcp.tools.length} ${mcp.tools.length === 1 ? 'tool' : 'tools'} published` : 'offline'}
          </span>
        </button>
        <h2>Agents</h2>
        {agents.map(agent => {
          const working = workingIds.has(agent.id)
          const disabled = agent.enabled === false
          return (
            <div key={agent.id} className={`agent-row${disabled ? ' disabled' : ''}`}>
              <button type="button" className="agent-item" data-agent={agent.id} onClick={() => setOpenAgentId(agent.id)}>
                <Avatar id={agent.id} working={working} />
                <span className="agent-name">{displayName(agent.id)}</span>
                <span className={`agent-status${working ? ' working' : ''}`}>
                  {disabled ? 'disabled' : !agent.card ? 'offline' : working ? 'working…' : 'idle'}
                  {!disabled && !!agent.delayMs && ` · ${agent.delayMs / 1000}s delay`}
                  {!disabled && !!agent.fault && agent.fault !== 'none' && ` · fault: ${agent.fault}`}
                </span>
              </button>
              {(agent.enabled !== null || agent.delayMs !== null || agent.fault !== null) && (
                <button
                  type="button"
                  className="settings-button"
                  aria-label={`${displayName(agent.id)} settings`}
                  title="Settings"
                  onClick={() => setSettingsAgentId(agent.id)}
                >
                  <GearIcon />
                </button>
              )}
            </div>
          )
        })}
        <button type="button" className="chat-new" onClick={openNewChat}>
          <span aria-hidden="true">+</span> New chat
        </button>
        <h2>Chats</h2>
        {/* Newest first. */}
        <nav className="chat-list" aria-label="Chat sessions">
          {[...sessions].reverse().map(session => (
            <span key={session.id} className="chat-item" aria-current={view === 'chat' && session.id === activeSession.id ? 'page' : undefined}>
              {renaming?.id === session.id && renaming.at === 'list' ? (
                <TitleInput title={session.title ?? ''} onSave={title => renameSession(session.id, title)} onCancel={() => setRenaming(undefined)} />
              ) : (
                <button
                  type="button"
                  className="chat-open"
                  title="Double-click to rename"
                  onClick={() => openSession(session.id)}
                  onDoubleClick={() => setRenaming({ id: session.id, at: 'list' })}
                >
                  {busySessionIds.has(session.id) && <i className="session-busy" aria-label="Working" />}
                  <span className="session-title">{session.title ?? 'New chat'}</span>
                  {unreadCounts.has(session.id) && (
                    <b className="session-unread" aria-label={`${unreadCounts.get(session.id)} unread`}>
                      {unreadCounts.get(session.id)}
                    </b>
                  )}
                </button>
              )}
              <button type="button" className="session-rename" aria-label="Rename chat" title="Rename chat" onClick={() => setRenaming({ id: session.id, at: 'list' })}>
                ✎
              </button>
              <button type="button" className="session-close" aria-label="Delete chat" title="Delete chat" onClick={() => requestClose(session)}>
                ×
              </button>
            </span>
          ))}
        </nav>
        {signals.map(signal => {
          const tone = `${signal.kind}${signal.failed ? ' failed' : ''}`
          const animationDelay = `${signal.delay}ms`
          return (
            <span key={signal.key}>
              <span
                className={`track ${tone}`}
                style={{ top: Math.min(signal.top, signal.top + signal.dy), left: signal.left, height: Math.abs(signal.dy), animationDelay }}
              />
              <span
                className={`packet ${tone}`}
                style={{ top: signal.top, left: signal.left, '--dy': `${signal.dy}px`, animationDelay } as CSSProperties}
              />
              <span
                className={`signal-note ${tone}`}
                style={{ top: signal.noteTop, '--x': `${signal.noteLeft}px`, animationDelay } as CSSProperties}
              >
                <span>
                  <b>
                    {signal.kind === 'request'
                      ? `${displayName(agents[0].id)} asks ${displayName(signal.agent)}`
                      : `${displayName(signal.agent)} replies`}
                  </b>{' '}
                  {signal.text}
                </span>
              </span>
            </span>
          )
        })}
        <div className="aside-foot">
          <div className="views" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'chat'} onClick={() => setView('chat')}>
              Chat
            </button>
            <button type="button" role="tab" aria-selected={view === 'map'} onClick={() => setView('map')}>
              Agent map
            </button>
          </div>
          <button type="button" className="app-settings" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
            <GearIcon />
          </button>
          <button type="button" className="app-settings" aria-label="Sign out" title="Sign out" onClick={signOut}>
            <LogoutIcon />
          </button>
          {user && (
            <span className="account">
              <span title={user.email}>{user.email}</span>
            </span>
          )}
        </div>
        {storeError && (
          <p className="store-error" role="alert">
            This chat is not being saved: {storeError}. Check that <code>supabase/migrations/0001_chat.sql</code> was run.
          </p>
        )}
      </aside>
      {closing && (
        <CloseSessionModal title={closing.session.title ?? 'New chat'} jobs={closing.jobs} error={closing.error} onConfirm={confirmClose} onClose={() => setClosing(undefined)} />
      )}
      {settingsOpen && <AppSettingsModal theme={theme} onThemeChange={changeTheme} onClose={() => setSettingsOpen(false)} />}
      {poppyOpen && discovery && <PoppyModal discovery={discovery} onClose={() => setPoppyOpen(false)} />}
      {mcpOpen && mcp && <McpModal door={mcp} onClose={() => setMcpOpen(false)} />}
      {openAgent && (
        <AgentModal agent={openAgent} working={workingIds.has(openAgent.id)} onClose={() => setOpenAgentId(undefined)} />
      )}
      {settingsAgent && (
        <SettingsModal
          agent={settingsAgent}
          onToggle={enabled => toggleAgent(settingsAgent.id, enabled)}
          onDelayChange={delayMs => setAgentDelay(settingsAgent.id, delayMs)}
          onFaultChange={fault => setAgentFault(settingsAgent.id, fault)}
          onClose={() => setSettingsAgentId(undefined)}
        />
      )}
    <main className={view === 'map' ? 'wide' : undefined}>
      {view === 'map' && <AgentMap agents={agents} workingIds={workingIds} interactions={interactions} />}
      {view === 'chat' && (
      <div className="workspace">
        <section className="chat">
          <div className="chat-head">
            {renaming?.id === activeSession.id && renaming.at === 'head' ? (
              <TitleInput title={activeSession.title ?? ''} onSave={title => renameSession(activeSession.id, title)} onCancel={() => setRenaming(undefined)} />
            ) : (
              <button type="button" className="session-title" title="Rename chat" onClick={() => setRenaming({ id: activeSession.id, at: 'head' })}>
                {activeSession.title ?? 'New chat'}
              </button>
            )}
            <button type="button" className="drawer-toggle" aria-expanded={tasksOpen} onClick={() => setTasksOpen(open => !open)}>
              {activeTaskCount > 0 && <i className="session-busy" aria-label="Working" />}
              Specialist tasks <small>{sessionTasks.length}</small>
            </button>
          </div>
          {/* The In progress bar floats over the top of the messages, so they do not move when it comes and goes. */}
          <div className="chat-body">
          {runningTurns.length > 0 && (
            <div className="running" role="region" aria-label="In progress">
              {runningTurns.map(({ startedAt, task, conversation }) => {
                const { localId, answer, log } = task ?? conversation
                const prompt = task?.background ? `${displayName(task.background.agent)}: ${task.prompt}` : (task ?? conversation).prompt
                return (
                  <details key={localId} className="running-task">
                    <summary>
                      <span className="running-row">
                        <Typing />
                        <span className="running-prompt">{prompt}</span>
                        <span className="badge">{task?.background ? 'background' : task ? task.state : 'working'}</span>
                        <time>{Math.max(0, Math.round((now - startedAt) / 1000))}s</time>
                        {task?.background && (
                          <button
                            type="button"
                            className="quiet running-cancel"
                            disabled={cancelingIds.has(localId)}
                            onClick={event => {
                              // Inside the summary: do not open or close the details.
                              event.preventDefault()
                              cancelJob(task)
                            }}
                          >
                            {cancelingIds.has(localId) ? 'Canceling…' : 'Cancel'}
                          </button>
                        )}
                      </span>
                    </summary>
                    {answer && <Markdown text={answer} />}
                    <Timeline log={log} pending={task?.background ? 'the chat stays free meanwhile…' : task ? 'waiting for next event…' : 'company is working…'} />
                  </details>
                )
              })}
            </div>
          )}
          <div className="messages" ref={messagesRef}>
            {turns.length === 0 && (
              <div className="chat-empty">
                <p>Ask the loan master something, or try one of these:</p>
                <div className="suggestions">
                  {SUGGESTIONS.map(suggestion => (
                    <button key={suggestion} type="button" onClick={() => send(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {thread.map(({ part, turn }, index) => {
              const { task, conversation } = turn
              const { localId, prompt } = task ?? conversation
              if (part === 'prompt') {
                return (
                  <div key={`${localId}-prompt`} className="turn">
                    <span className="sender">{task ? 'Loan officer · A2A' : 'Borrower’s agent · PAP'}</span>
                    <div className="bubble user">{prompt}</div>
                  </div>
                )
              }
              // A reply that arrived after other messages says which prompt it answers.
              const previous = thread[index - 1]
              const follows = previous?.part === 'prompt' && previous.turn === turn
              const replyTo = !follows && (
                <span className="reply-to">{task?.background ? `Background result · ${displayName(task.background.agent)}: ${prompt}` : `Reply to: ${prompt}`}</span>
              )

              // Loan officer turn: an A2A task followed over an SSE stream (message/stream).
              if (task) {
                const running = !TERMINAL.includes(task.state)
                return (
                  <div key={`${localId}-reply`} className={`turn${follows ? ' follows' : ''}${task.unread ? ' unread' : ''}`}>
                    {task.unread && <UnreadTag onSeen={() => markRead(localId)} />}
                    {replyTo}
                    <div className="reply">
                      {router && <Avatar id={router.id} working={running} />}
                      <div className={`bubble router${task.state === 'failed' ? ' failed' : ''}`}>
                        {task.answer ? <Markdown text={task.answer} /> : <Typing />}
                        {task.escalation && (
                          <p className="escalation">
                            <span className="badge failed">{task.escalation.reasonCode}</span>
                            <span>{task.escalation.failureClass}</span>
                            {task.escalation.retryAfterMs !== undefined && <span>retry after {Math.ceil(task.escalation.retryAfterMs / 1000)}s</span>}
                            {task.escalation.approval && <code>approval {task.escalation.approval.approvalId}</code>}
                            <a href={task.escalation.destination.url} target="_blank" rel="noreferrer">
                              {task.escalation.destination.label} →
                            </a>
                          </p>
                        )}
                        <details className="events">
                          <summary>
                            <span className={`badge ${task.state}`}>{task.state}</span> {task.log.length} {task.background ? 'steps' : 'A2A events'}
                          </summary>
                          {task.taskId && <code>task {task.taskId}</code>}
                          <Timeline log={task.log} pending={running ? 'waiting for next event…' : undefined} />
                        </details>
                      </div>
                    </div>
                  </div>
                )
              }

              // Borrower's agent turn: a PAP conversation, events by long-poll.
              const { operation } = conversation
              const secondsLeft = operation ? Math.round((Date.parse(operation.expires_at) - now) / 1000) : 0
              const operationState = conversation.operationState === 'awaiting' && secondsLeft <= 0 ? 'expired' : conversation.operationState
              const state = conversation.error ? 'failed' : conversation.working ? 'working' : operationState === 'awaiting' ? 'approval needed' : 'idle'
              const text = conversation.error ?? conversation.answer
              return (
                <div key={`${localId}-reply`} className={`turn${follows ? ' follows' : ''}`}>
                  {replyTo}
                  <div className="reply">
                    {router && <Avatar id={router.id} working={conversation.working} />}
                    <div className={`bubble router${conversation.error ? ' failed' : ''}`}>
                      {text ? <Markdown text={text} /> : !operation && <Typing />}
                      {operation && (
                        <div className={`approval ${operationState}`}>
                          <div className="row">
                            <strong>Approval requested</strong>
                            <span className="operation-state">
                              {operationState === 'awaiting'
                                ? `expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
                                : operationState === 'approved'
                                  ? 'approved · sent to the company'
                                  : operationState}
                            </span>
                          </div>
                          {operation.summary && <p>{emphasis(operation.summary)}</p>}
                          <dl>
                            {Object.entries(operation.terms).map(([key, value]) => (
                              <div key={key}>
                                <dt>{key}</dt>
                                <dd>{String(value)}</dd>
                              </div>
                            ))}
                          </dl>
                          <code>
                            {operation.operation_id} · {operation.revision}
                          </code>
                          {operationState === 'awaiting' && (
                            <div className="actions">
                              <button type="button" onClick={() => approve(conversation)}>
                                Approve
                              </button>
                              <button
                                type="button"
                                className="quiet"
                                onClick={() => patchConversation(conversation.localId, current => ({ ...current, operationState: 'declined' }))}
                              >
                                Decline
                              </button>
                            </div>
                          )}
                          {operationState === 'declined' && <p className="note">Nothing was sent: without an approval the company does not act.</p>}
                        </div>
                      )}
                      <details className="events">
                        <summary>
                          <span className={`badge ${state === 'idle' ? 'completed' : state}`}>{state}</span> {conversation.log.length} PAP steps
                        </summary>
                        {conversation.conversationId && <code>conversation {conversation.conversationId}</code>}
                        <Timeline log={conversation.log} pending={conversation.working ? 'company is working…' : undefined} />
                      </details>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          </div>
          <div className="composer">
            {attachment && (
              <p className="attachment">
                <span>{attachment.name}</span>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachment(undefined)}>
                  ×
                </button>
              </p>
            )}
            {attachError && (
              <p className="attach-error" role="alert">
                {attachError}
              </p>
            )}
            <form onSubmit={onSubmit}>
              <label className="attach" title="Attach a MISMO 3.4 XML file to check">
                Attach
                <input
                  type="file"
                  accept=".xml,text/xml,application/xml"
                  onChange={e => {
                    attach(e.target.files?.[0])
                    // So the same file can be chosen again after it is removed.
                    e.target.value = ''
                  }}
                />
              </label>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Message the loan master, or attach a MISMO file…"
                autoFocus
              />
              <button type="submit" disabled={uploading || (!input.trim() && !attachment)}>
                {uploading ? 'Uploading…' : 'Send'}
              </button>
            </form>
          </div>
        </section>
      </div>
      )}
    </main>
      {/* Always mounted so it can slide; it does not block the chat while open. */}
      <section className={`drawer${tasksOpen ? ' open' : ''}`} aria-label="Specialist tasks" aria-hidden={!tasksOpen}>
        <div className="drawer-head">
          <h2>Specialist tasks</h2>
          <button type="button" className="close" onClick={() => setTasksOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <p className="hint">
          Router → specialists, for the chat session “{activeSession.title ?? 'New chat'}”. Each server is polled every second with A2A
          ListTasks.
        </p>
        {sessionTasks.length === 0 && <p className="empty">No delegated tasks in this session yet.</p>}
        {sessionTasks.map(task => {
          const state = taskState(task)
          const result = (task.artifacts ?? []).map(artifact => partsText(artifact.parts)).join('')
          const reason = readReason(partsText(task.status?.message?.parts))
          return (
            <article key={`${task.agent}/${task.id}`}>
              <div className="row">
                <span className={`badge ${state}`}>{state}</span>
                {reason && <span className="badge failed">{reason}</span>}
                <span className="agent">{task.agent}</span>
                <span className="prompt">{partsText(task.history?.[0]?.parts) || '(delegated request)'}</span>
              </div>
              <code>task {task.id}</code>
              {result && (
                <div className="answer">
                  <Markdown text={result} />
                </div>
              )}
            </article>
          )
        })}
      </section>
    </div>
  )
}
