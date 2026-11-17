import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { UsersPage, AssetsPage, KbPage, BillingPage, PlatformPage, AcceptInvite, ResetPassword, Forgot, AnalyticsPage, AccountPage, ChangePassword, StageTracker, Timeline, AttachmentItem, compressImage } from './Extra'

type Role = 'admin' | 'technician' | 'requester'
export type Me = { id: string; name: string; email: string; role: Role; is_platform?: boolean; must_change_password?: boolean; sub?: { state: string; plan: string; periodEnd: string } }
export type Ticket = { department?: string | null; room?: string | null; resolve_due?: string | null; breached?: boolean; asset_tag?: string | null; asset_name?: string | null; id: string; number: number; title: string; description?: string; category: string; priority: string; status: string; requester: string; assignee: string | null; assignee_id?: string | null; created_at: string }
type Msg = { id: string; body: string; internal: boolean; author: string; created_at: string }
export type Ev = { type: string; detail: any; created_at: string; actor: string | null }
type Att = { id: string; filename: string; size: number }
export type Usr = { id: string; name: string; email: string; role: Role; active: boolean }
type View = { k: 'list' } | { k: 'ticket'; id: string } | { k: 'users' } | { k: 'assets' } | { k: 'kb' } | { k: 'billing' } | { k: 'platform' } | { k: 'analytics' } | { k: 'account' }

export const TOKEN = 'techdesk_token'
const STATUSES = ['open', 'in_progress', 'resolved', 'closed']
const label = (s: string) => s.replace('_', ' ')
const dueCell = (t: Ticket) => !t.resolve_due || ['resolved', 'closed'].includes(t.status) ? '—' : (t.breached || new Date(t.resolve_due) < new Date()) ? <b style={{ color: '#b3261e' }}>Overdue</b> : new Date(t.resolve_due).toLocaleString()

let refreshing: Promise<boolean> | null = null
function refresh(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST' })
    .then(async r => { if (!r.ok) return false; localStorage.setItem(TOKEN, (await r.json()).token); return true })
    .catch(() => false).finally(() => { refreshing = null })
  return refreshing
}
type Opts = { method?: string; body?: unknown; form?: FormData }
async function call(path: string, o: Opts, retried = false): Promise<Response> {
  const h: Record<string, string> = {}
  const t = localStorage.getItem(TOKEN)
  if (t) h.Authorization = 'Bearer ' + t
  if (o.body) h['Content-Type'] = 'application/json'
  const r = await fetch('/api' + path, { method: o.method ?? (o.body || o.form ? 'POST' : 'GET'), headers: h, body: o.form ?? (o.body ? JSON.stringify(o.body) : undefined) })
  if (r.status === 401 && !retried && !/^\/auth\/(login|register|refresh|logout|accept-invite|forgot|reset)/.test(path)) {
    if (await refresh()) return call(path, o, true)   // quietly renew the short-lived token from the long-lived session cookie
    localStorage.removeItem(TOKEN); window.dispatchEvent(new Event('td-auth-lost'))
  }
  return r
}
export async function api<T>(path: string, o: Opts = {}): Promise<T> {
  const r = await call(path, o)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.details?.join('; ') || j.error || 'Request failed')
  return j as T
}
export async function apiBlob(path: string): Promise<Blob> {
  const r = await call(path, {})
  if (!r.ok) throw new Error('Could not load the file')
  return r.blob()
}
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

export function Field(p: { label: string; value: string; set: (v: string) => void; type?: string }) {
  return <><label>{p.label}<input type={p.type ?? 'text'} value={p.value} onChange={e => p.set(e.target.value)} required /></label></>
}

function Auth({ onAuth }: { onAuth: (t: string, u: Me) => void }) {
  const [reg, setReg] = useState(false)
  const [f, setF] = useState({ orgName: '', name: '', email: '', password: '', planCode: 'starter' })
  const [plans, setPlans] = useState<{ code: string; name: string; max_agents: number; price_month: number }[]>([])
  useEffect(() => { api<typeof plans>('/plans').then(setPlans).catch(() => undefined) }, [])
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const up = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await api<{ token: string; user: Me }>(reg ? '/auth/register' : '/auth/login', { body: reg ? f : { email: f.email, password: f.password } })
      onAuth(r.token, r.user)
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  return (
    <div className="auth"><div className="card">
      <h1>TechDesk</h1><p className="mute">{reg ? 'Create your organisation. You become its administrator.' : 'Sign in to your helpdesk.'}</p>
      <form onSubmit={submit}>
        {reg && <><Field label="Organisation name" value={f.orgName} set={up('orgName')} /><Field label="Your name" value={f.name} set={up('name')} />
          <label>Plan (14-day free trial, pay later)<select value={f.planCode} onChange={e => up('planCode')(e.target.value)}>{plans.map(p => <option key={p.code} value={p.code}>{p.name}: up to {p.max_agents} ICT agents, KSh {p.price_month.toLocaleString('en-KE')}/month</option>)}</select></label></>}
        <Field label={reg ? 'Work email' : 'Email'} type="email" value={f.email} set={up('email')} />
        <Field label="Password (10+ characters)" type="password" value={f.password} set={up('password')} />
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>{busy ? 'Please wait…' : reg ? 'Create organisation' : 'Sign in'}</button>{' '}
        <button type="button" className="btn alt" onClick={() => { setReg(!reg); setErr('') }}>{reg ? 'I have an account' : 'Register organisation'}</button>
        {!reg && <p><a href="#/forgot">Forgot your password?</a></p>}
      </form>
    </div></div>
  )
}

function Tickets({ me, open }: { me: Me; open: (id: string) => void }) {
  const staff = me.role !== 'requester'
  const [rows, setRows] = useState<Ticket[] | null>(null)
  const [dash, setDash] = useState<{ byStatus: Record<string, number>; unassigned: number; mine: number } | null>(null)
  const [filter, setFilter] = useState(''); const [err, setErr] = useState('')
  const [f, setF] = useState({ title: '', description: '', category: 'Hardware', priority: 'medium', assetId: '', department: '', room: '' })
  const [photos, setPhotos] = useState<File[]>([]); const [created, setCreated] = useState(''); const [busy, setBusy] = useState(false)
  const [assets, setAssets] = useState<{ id: string; tag: string; name: string }[]>([])
  const load = useCallback(() => {
    api<Ticket[]>('/tickets' + (filter ? `?status=${filter}` : '')).then(setRows).catch(e => setErr(errMsg(e)))
    if (staff) api<typeof dash>('/dashboard').then(setDash).catch(() => undefined)
  }, [filter, staff])
  useEffect(load, [load])
  useEffect(() => { api<typeof assets>('/assets').then(setAssets).catch(() => undefined) }, [])
  async function create(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const t = await api<{ id: string; number: number }>('/tickets', { body: { ...f, assetId: f.assetId || undefined, department: f.department || undefined, room: f.room || undefined } })
      const failed: string[] = []
      for (const p of photos) {
        try { const form = new FormData(); form.append('file', await compressImage(p)); await api(`/tickets/${t.id}/attachments`, { form }) } catch { failed.push(p.name) }
      }
      if (failed.length) { setCreated(t.id); setErr(`Ticket TD-${t.number} was created, but these photos could not be uploaded: ${failed.join(', ')}. Open the ticket to add them again.`) } else open(t.id)
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  return (<>
    {dash && <div className="stats">
      {STATUSES.map(s => <div className="stat" key={s}><b>{dash.byStatus[s] ?? 0}</b>{label(s)}</div>)}
      <div className="stat"><b>{dash.unassigned}</b>unassigned</div><div className="stat"><b>{dash.mine}</b>assigned to me</div></div>}
    <div className="card"><h2>New ticket</h2>
      <form onSubmit={create}>
        <Field label="Title" value={f.title} set={v => setF({ ...f, title: v })} />
        <label>Describe the problem<textarea value={f.description} onChange={e => setF({ ...f, description: e.target.value })} required /></label>
        <div className="row">
          <label>Category<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{['Hardware', 'Software', 'Network', 'Account access', 'Other'].map(c => <option key={c}>{c}</option>)}</select></label>
          <label>Priority<select value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })}>{['low', 'medium', 'high', 'urgent'].map(c => <option key={c}>{c}</option>)}</select></label>
        </div>
        <div className="row"><label>Department<input value={f.department} onChange={e => setF({ ...f, department: e.target.value })} placeholder="e.g. Finance" maxLength={100} /></label>
          <label>Room / desk<input value={f.room} onChange={e => setF({ ...f, room: e.target.value })} placeholder="e.g. Room 12, 2nd floor" maxLength={60} /></label></div>
        <label>Photos of the problem (optional, up to 5)<input type="file" accept="image/*" multiple onChange={e => setPhotos(Array.from(e.target.files ?? []).slice(0, 5))} /></label>
        {photos.length > 0 && <p className="mute">{photos.length} photo(s) selected</p>}
        {assets.length > 0 && <label>Affected equipment (optional)<select value={f.assetId} onChange={e => setF({ ...f, assetId: e.target.value })}><option value="">Not sure / none</option>{assets.map(a => <option key={a.id} value={a.id}>{a.tag}: {a.name}</option>)}</select></label>}
        <button className="btn" disabled={busy}>{busy ? 'Submitting…' : 'Submit ticket'}</button>
      </form></div>
    {err && <p className="err" role="alert">{err}</p>}
    {created && <button className="btn alt" onClick={() => open(created)}>Open the ticket</button>}
    <div className="row" style={{ alignItems: 'center' }}><h2>{staff ? 'All tickets' : 'My tickets'}</h2>
      <label style={{ maxWidth: 200 }}>Status<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">All</option>{STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select></label></div>
    <div className="wrap"><table className="cards"><thead><tr><th>#</th><th>Title</th><th>Priority</th><th>Status</th><th>Location</th><th>Requester</th><th>Assignee</th><th>Resolve by</th></tr></thead>
      <tbody>{rows === null ? <tr><td colSpan={8}>Loading…</td></tr> : rows.length === 0 ? <tr><td colSpan={8} className="mute">No tickets yet. Submit one above.</td></tr> :
        rows.map(t => <tr key={t.id} className="link" tabIndex={0} onClick={() => open(t.id)} onKeyDown={e => e.key === 'Enter' && open(t.id)}>
          <td data-label="Ticket">TD-{t.number}</td><td data-label="Title">{t.title}</td><td data-label="Priority">{t.priority}</td><td data-label="Status"><span className="tag">{label(t.status)}</span></td>
          <td data-label="Location">{[t.department, t.room].filter(Boolean).join(', ') || '—'}</td><td data-label="Requester">{t.requester}</td><td data-label="Assignee">{t.assignee ?? '—'}</td><td data-label="Resolve by">{dueCell(t)}</td></tr>)}</tbody></table></div>
  </>)
}

function TicketView({ id, me, back }: { id: string; me: Me; back: () => void }) {
  const staff = me.role !== 'requester'
  const [d, setD] = useState<{ ticket: Ticket; messages: Msg[]; attachments: Att[]; events: Ev[] } | null>(null)
  const [staffList, setStaffList] = useState<Usr[]>([])
  const [body, setBody] = useState(''); const [internal, setInternal] = useState(false); const [err, setErr] = useState('')
  const load = useCallback(() => { api<NonNullable<typeof d>>(`/tickets/${id}`).then(setD).catch(e => setErr(errMsg(e))) }, [id])
  useEffect(load, [load])
  useEffect(() => { if (staff) api<Usr[]>('/users').then(u => setStaffList(u.filter(x => x.active && x.role !== 'requester'))).catch(() => undefined) }, [staff])
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); load() } catch (x) { setErr(errMsg(x)) } }
  const patch = (b: object) => run(() => api(`/tickets/${id}`, { method: 'PATCH', body: b }))
  const send = (e: FormEvent) => { e.preventDefault(); run(async () => { await api(`/tickets/${id}/messages`, { body: { body, internal } }); setBody(''); setInternal(false) }) }
  const upload = (file?: File) => { if (!file) return; const form = new FormData(); form.append('file', file); run(() => api(`/tickets/${id}/attachments`, { form })) }
  async function download(a: Att) {
    try { const url = URL.createObjectURL(await apiBlob(`/attachments/${a.id}`)); const l = document.createElement('a'); l.href = url; l.download = a.filename; l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) } catch (x) { setErr(errMsg(x)) }
  }
  if (!d) return <>{err ? <p className="err">{err}</p> : <p>Loading…</p>}<button className="btn alt" onClick={back}>Back</button></>
  const t = d.ticket
  return (<>
    <button className="btn alt" onClick={back}>Back to tickets</button>
    <div className="card"><h1>TD-{t.number}: {t.title}</h1>
      <p className="mute">Requested by {t.requester} · {t.category} · {new Date(t.created_at).toLocaleString()}{t.asset_tag ? ` · Equipment ${t.asset_tag} (${t.asset_name})` : ''}{t.department || t.room ? ` · Location: ${[t.department, t.room].filter(Boolean).join(', ')}` : ''}</p>
      <p>Resolve by: {dueCell(t)}</p><p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>
      <StageTracker t={t} events={d.events} />
      {staff ? <div className="row">
        <label>Status<select value={t.status} onChange={e => patch({ status: e.target.value })}>{STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}</select></label>
        <label>Priority<select value={t.priority} onChange={e => patch({ priority: e.target.value })}>{['low', 'medium', 'high', 'urgent'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Assignee<select value={t.assignee_id ?? ''} onChange={e => patch({ assigneeId: e.target.value || null })}><option value="">Unassigned</option>{staffList.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      </div> : <p>Status: <span className="tag">{label(t.status)}</span> · Assigned to: {t.assignee ?? 'not yet assigned'}</p>}
      {err && <p className="err" role="alert">{err}</p>}</div>
    <div className="card"><h2>Conversation</h2>
      {d.messages.length === 0 && <p className="mute">No replies yet.</p>}
      {d.messages.map(m => <div key={m.id} className={'msg' + (m.internal ? ' note' : '')}><b>{m.author}</b>{m.internal && ' (internal note)'} <span className="mute">{new Date(m.created_at).toLocaleString()}</span><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>)}
      <form onSubmit={send}><label>Reply<textarea value={body} onChange={e => setBody(e.target.value)} required /></label>
        {staff && <label><input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} /> Internal note (hidden from the requester)</label>}
        <button className="btn">{internal ? 'Add note' : 'Send reply'}</button></form></div>
    <Timeline events={d.events} />
    <div className="card"><h2>Attachments</h2>
      {d.attachments.length === 0 && <p className="mute">No files attached.</p>}
      <div className="thumbs">{d.attachments.map(a => <AttachmentItem key={a.id} a={a} onDownload={() => download(a)} />)}</div>
      <label>Add a file (PNG, JPEG, PDF or text, up to 5 MB)<input type="file" accept=".png,.jpg,.jpeg,.pdf,.txt" onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} /></label></div>
  </>)
}

function useInstall() {
  const [ev, setEv] = useState<any>(null)
  useEffect(() => { const h = (e: Event) => { e.preventDefault(); setEv(e) }; addEventListener('beforeinstallprompt', h); return () => removeEventListener('beforeinstallprompt', h) }, [])
  return { canInstall: !!ev, run: async () => { await ev.prompt(); setEv(null) } }
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null); const [ready, setReady] = useState(false); const [view, setView] = useState<View>({ k: 'list' })
  const [hash, setHash] = useState(location.hash); const install = useInstall()
  useEffect(() => { const h = () => setHash(location.hash); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h) }, [])
  useEffect(() => { const h = () => setMe(null); addEventListener('td-auth-lost', h); return () => removeEventListener('td-auth-lost', h) }, [])
  const loadMe = useCallback(() => { api<Me>('/me').then(setMe).catch(() => undefined).finally(() => setReady(true)) }, [])
  useEffect(loadMe, [loadMe])
  const signedIn = (t: string) => { localStorage.setItem(TOKEN, t); location.hash = ''; setReady(false); loadMe() }
  const signOut = async () => { await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined); localStorage.removeItem(TOKEN); setMe(null); setView({ k: 'list' }) }
  const token = new URLSearchParams(hash.split('?')[1] ?? '').get('token') ?? ''
  if (hash.startsWith('#/invite')) return <AcceptInvite token={token} onDone={signedIn} />
  if (hash.startsWith('#/reset')) return <ResetPassword token={token} />
  if (hash.startsWith('#/forgot')) return <Forgot />
  if (!ready) return <p className="pad">Loading…</p>
  if (!me) return <Auth onAuth={t => signedIn(t)} />
  if (me.must_change_password) return <ChangePassword forced onDone={t => signedIn(t)} onCancel={signOut} />
  const staff = me.role !== 'requester', admin = me.role === 'admin', sub = me.sub
  const nav = (k: 'list' | 'assets' | 'kb' | 'users' | 'analytics' | 'billing' | 'platform', text: string) =>
    <button className={view.k === k || (k === 'list' && view.k === 'ticket') ? 'on' : ''} onClick={() => setView({ k } as View)}>{text}</button>
  const graceEnd = sub ? new Date(new Date(sub.periodEnd).getTime() + 7 * 864e5).toLocaleDateString() : ''
  return (<>
    <header>
      <div className="top"><img className="logo" src="/onyx-symbol.png" alt="" width="32" height="31" /><b>TechDesk</b><span className="by">by OnyxTech</span><span className="sp" />
        {install.canInstall && <button className="inst" onClick={install.run}>Install app</button>}
        <button onClick={() => setView({ k: 'account' })}>{me.name}</button><button onClick={signOut}>Sign out</button></div>
      <div className="navlinks">{nav('list', 'Tickets')}{nav('assets', 'Assets')}{nav('kb', 'Knowledge base')}{staff && nav('users', 'Users')}{admin && nav('analytics', 'Analytics')}{admin && nav('billing', 'Billing')}{me.is_platform && nav('platform', 'Platform')}</div>
    </header>
    {sub && !me.is_platform && sub.state !== 'active' && <div className={'banner ' + (sub.state === 'trialing' ? 'info' : 'warn')} role="status">
      {sub.state === 'trialing' && `Free trial ends ${new Date(sub.periodEnd).toLocaleDateString()}.${admin ? ' Choose and pay for a plan under Billing.' : ''}`}
      {sub.state === 'grace' && `Your subscription has expired. Renew by ${graceEnd} to keep full access.${admin ? ' Go to Billing.' : ' Ask your administrator.'}`}
      {sub.state === 'suspended' && `Your subscription has expired and TechDesk is read-only.${admin ? ' Renew under Billing.' : ' Ask your administrator to renew.'}`}</div>}
    <main>
      {view.k === 'list' && <Tickets me={me} open={id => setView({ k: 'ticket', id })} />}
      {view.k === 'ticket' && <TicketView id={view.id} me={me} back={() => setView({ k: 'list' })} />}
      {view.k === 'users' && <UsersPage me={me} />}
      {view.k === 'assets' && <AssetsPage me={me} />}
      {view.k === 'kb' && <KbPage me={me} />}
      {view.k === 'analytics' && admin && <AnalyticsPage />}
      {view.k === 'billing' && admin && <BillingPage />}
      {view.k === 'platform' && me.is_platform && <PlatformPage />}
      {view.k === 'account' && <AccountPage me={me} canInstall={install.canInstall} install={install.run} />}
    </main>
  </>)
}
