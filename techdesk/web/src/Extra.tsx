import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, apiBlob, errMsg, Field, TOKEN, type Me, type Usr, type Ticket, type Ev } from './App'

type Plan = { code: string; name: string; max_agents: number; price_month: number }
const kes = (n: number) => 'KSh ' + n.toLocaleString('en-KE')
const day = (d: string) => new Date(d).toLocaleDateString()
const Err = ({ e }: { e: string }) => (e ? <p className="err" role="alert">{e}</p> : null)

export function UsersPage({ me }: { me: Me }) {
  type Invite = { id: string; email: string; role: string; expires_at: string }
  const admin = me.role === 'admin'
  const [list, setList] = useState<Usr[]>([]); const [inv, setInv] = useState<Invite[]>([])
  const [err, setErr] = useState(''); const [ok, setOk] = useState(''); const [f, setF] = useState({ email: '', role: 'requester' })
  const [pwFor, setPwFor] = useState<Usr | null>(null); const [pw, setPw] = useState('')
  const load = useCallback(() => {
    api<Usr[]>('/users').then(setList).catch(e => setErr(errMsg(e)))
    if (admin) api<Invite[]>('/invites').then(setInv).catch(() => undefined)
  }, [admin])
  useEffect(load, [load])
  const act = async (fn: () => Promise<unknown>, okMsg = '') => { setErr(''); setOk(''); try { await fn(); if (okMsg) setOk(okMsg); load() } catch (x) { setErr(errMsg(x)) } }
  const invite = (e: FormEvent) => { e.preventDefault(); void act(async () => { await api('/invites', { body: f }); setF({ ...f, email: '' }) }, `Invitation created for ${f.email}. They receive an email with a link valid for 7 days.`) }
  const savePw = (e: FormEvent) => { e.preventDefault(); if (!pwFor) return; const u = pwFor; void act(async () => { await api(`/users/${u.id}/password`, { body: { password: pw } }); setPwFor(null); setPw('') },
    `Temporary password set for ${u.name}. Give it to them privately. They must choose their own password when they sign in, and their old sessions were ended.`) }
  return (<>
    {admin && <div className="card"><h2>Invite a colleague</h2>
      <p className="mute">Employees join with their work email. Technicians and admins are ICT agents and count towards your plan limit; requesters are unlimited.</p>
      <form onSubmit={invite}><div className="row"><Field label="Work email" type="email" value={f.email} set={v => setF({ ...f, email: v })} />
        <label>Role<select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="requester">Requester (employee)</option><option value="technician">Technician (ICT team)</option><option value="admin">Admin</option></select></label></div>
        <button className="btn">Send invitation</button></form></div>}
    {ok && <p role="status">{ok}</p>}{err && <p className="err" role="alert">{err}</p>}
    {pwFor && <div className="card"><h2>Set a temporary password for {pwFor.name}</h2><form onSubmit={savePw}>
      <Field label="Temporary password (10+ characters)" type="text" value={pw} set={setPw} />
      <button className="btn">Set password</button> <button type="button" className="btn alt" onClick={() => { setPwFor(null); setPw('') }}>Cancel</button></form></div>}
    {inv.length > 0 && <div className="card"><h2>Pending invitations</h2>{inv.map(i => <p key={i.id}>{i.email} ({i.role}) · expires {day(i.expires_at)} <button className="btn alt" style={{ margin: 0 }} onClick={() => act(() => api(`/invites/${i.id}`, { method: 'DELETE' }))}>Revoke</button></p>)}</div>}
    <div className="wrap"><table className="cards"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      {list.map(u => { const other = admin && u.id !== me.id; return <tr key={u.id}><td data-label="Name">{u.name}</td><td data-label="Email">{u.email}</td>
        <td data-label="Role">{other ? <select aria-label={`Role for ${u.name}`} value={u.role} onChange={e => act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), `${u.name} is now ${e.target.value}.`)}>
          <option value="requester">requester</option><option value="technician">technician</option><option value="admin">admin</option></select> : u.role}</td>
        <td data-label="Status">{u.active ? 'Active' : 'Disabled'}</td>
        <td data-label="Actions">{other && <div className="acts">
          <button className="btn alt" onClick={() => act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }))}>{u.active ? 'Disable' : 'Enable'}</button>
          <button className="btn alt" onClick={() => act(() => api(`/users/${u.id}/reset-link`, { method: 'POST', body: {} }), `Password reset link emailed to ${u.email}.`)}>Email reset link</button>
          <button className="btn alt" onClick={() => { setPwFor(u); setPw('') }}>Temporary password</button></div>}</td></tr> })}</tbody></table></div>
  </>)
}

export function AssetsPage({ me }: { me: Me }) {
  type Asset = { id: string; tag: string; name: string; category: string; serial: string | null; status: string; location: string | null; warranty_until: string | null; assignee: string | null }
  const staff = me.role !== 'requester'
  const [rows, setRows] = useState<Asset[]>([]); const [users, setUsers] = useState<Usr[]>([]); const [err, setErr] = useState('')
  const [f, setF] = useState({ tag: '', name: '', category: 'Laptop', serial: '', location: '', assignedTo: '', warrantyUntil: '' })
  const load = useCallback(() => { api<Asset[]>('/assets').then(setRows).catch(e => setErr(errMsg(e))) }, [])
  useEffect(load, [load])
  useEffect(() => { if (staff) api<Usr[]>('/users').then(setUsers).catch(() => undefined) }, [staff])
  async function add(e: FormEvent) {
    e.preventDefault(); setErr('')
    try { await api('/assets', { body: { tag: f.tag, name: f.name, category: f.category, serial: f.serial || undefined, location: f.location || undefined, assignedTo: f.assignedTo || null, warrantyUntil: f.warrantyUntil || null } })
      setF({ ...f, tag: '', name: '', serial: '' }); load() } catch (x) { setErr(errMsg(x)) }
  }
  const setStatus = async (id: string, status: string) => { try { await api(`/assets/${id}`, { method: 'PATCH', body: { status } }); load() } catch (x) { setErr(errMsg(x)) } }
  return (<>
    {staff && <div className="card"><h2>Register an asset</h2><form onSubmit={add}>
      <div className="row"><Field label="Asset tag" value={f.tag} set={v => setF({ ...f, tag: v })} /><Field label="Name / model" value={f.name} set={v => setF({ ...f, name: v })} /></div>
      <div className="row"><label>Category<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{['Laptop', 'Desktop', 'Phone', 'Printer', 'Network', 'Server', 'Other'].map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Serial number<input value={f.serial} onChange={e => setF({ ...f, serial: e.target.value })} /></label>
        <label>Location<input value={f.location} onChange={e => setF({ ...f, location: e.target.value })} /></label></div>
      <div className="row"><label>Assigned to<select value={f.assignedTo} onChange={e => setF({ ...f, assignedTo: e.target.value })}><option value="">Nobody</option>{users.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Warranty until<input type="date" value={f.warrantyUntil} onChange={e => setF({ ...f, warrantyUntil: e.target.value })} /></label></div>
      <button className="btn">Add asset</button></form></div>}
    <Err e={err} />
    <h2>{staff ? 'Asset register' : 'My equipment'}</h2>
    <div className="wrap"><table><thead><tr><th>Tag</th><th>Name</th><th>Category</th><th>Assigned to</th><th>Location</th><th>Warranty</th><th>Status</th></tr></thead><tbody>
      {rows.length === 0 && <tr><td colSpan={7} className="mute">No assets yet.</td></tr>}
      {rows.map(a => <tr key={a.id}><td>{a.tag}</td><td>{a.name}</td><td>{a.category}</td><td>{a.assignee ?? '—'}</td><td>{a.location ?? '—'}</td><td>{a.warranty_until ? day(a.warranty_until) : '—'}</td>
        <td>{staff ? <select value={a.status} onChange={e => setStatus(a.id, e.target.value)}>{['in_use', 'in_stock', 'repair', 'retired'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select> : a.status.replace('_', ' ')}</td></tr>)}</tbody></table></div>
  </>)
}

export function KbPage({ me }: { me: Me }) {
  type Art = { id: string; title: string; body: string; category: string; published: boolean }
  const staff = me.role !== 'requester'
  const [rows, setRows] = useState<Art[]>([]); const [q, setQ] = useState(''); const [err, setErr] = useState('')
  const [f, setF] = useState({ title: '', body: '', category: 'General', published: true })
  const load = useCallback(() => { api<Art[]>('/kb' + (q ? `?q=${encodeURIComponent(q)}` : '')).then(setRows).catch(e => setErr(errMsg(e))) }, [q])
  useEffect(load, [load])
  async function add(e: FormEvent) { e.preventDefault(); setErr(''); try { await api('/kb', { body: f }); setF({ ...f, title: '', body: '' }); load() } catch (x) { setErr(errMsg(x)) } }
  const publish = async (a: Art) => { try { await api(`/kb/${a.id}`, { method: 'PATCH', body: { published: !a.published } }); load() } catch (x) { setErr(errMsg(x)) } }
  return (<>
    <label>Search articles<input value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. wifi, printer, password" /></label><Err e={err} />
    {staff && <div className="card"><h2>New article</h2><form onSubmit={add}><div className="row"><Field label="Title" value={f.title} set={v => setF({ ...f, title: v })} />
      <label>Category<input value={f.category} onChange={e => setF({ ...f, category: e.target.value })} required /></label></div>
      <label>Article<textarea value={f.body} onChange={e => setF({ ...f, body: e.target.value })} required /></label>
      <label><input type="checkbox" checked={f.published} onChange={e => setF({ ...f, published: e.target.checked })} /> Publish to all employees</label><button className="btn">Save article</button></form></div>}
    {rows.length === 0 && <p className="mute">No articles found.</p>}
    {rows.map(a => <details className="card" key={a.id}><summary><b>{a.title}</b> <span className="tag">{a.category}</span> {!a.published && <span className="tag">draft</span>}</summary>
      <p style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p>{staff && <button className="btn alt" onClick={() => publish(a)}>{a.published ? 'Unpublish' : 'Publish'}</button>}</details>)}
  </>)
}

export function BillingPage() {
  type Pay = { id: string; plan_code: string; months: number; amount: number; method: string; status: string; mpesa_receipt: string | null; created_at: string }
  type B = { plan_code: string; plan_name: string; max_agents: number; agents: number; period_end: string; state: string; plans: Plan[]; payments: Pay[] }
  const [b, setB] = useState<B | null>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ planCode: 'business', months: 1, phone: '' })
  const load = useCallback(() => { api<B>('/billing').then(setB).catch(e => setErr(errMsg(e))) }, [])
  useEffect(load, [load])
  async function pay(e: FormEvent) {
    e.preventDefault(); setErr(''); setMsg(''); setBusy(true)
    try {
      const out = await api<{ paymentId: string }>('/billing/checkout', { body: f })
      setMsg('Check your phone and enter your M-Pesa PIN to approve the payment…')
      for (let i = 0; i < 30; i++) {
        await new Promise(res => setTimeout(res, 4000))
        const p = await api<{ status: string }>(`/billing/payments/${out.paymentId}`)
        if (p.status === 'paid') { setMsg('Payment received. Your subscription is active.'); setTimeout(() => location.reload(), 1500); break }
        if (p.status === 'failed') { setMsg(''); setErr('The payment was cancelled or failed. You can try again.'); break }
      }
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false); load() }
  }
  if (!b) return <>{err ? <Err e={err} /> : <p>Loading…</p>}</>
  const plan = b.plans.find(p => p.code === f.planCode)
  return (<>
    <div className="card"><h2>Your subscription</h2>
      <p><b>{b.plan_name}</b> plan · status <span className="tag">{b.state}</span> · {b.state === 'trialing' ? 'trial ends' : 'paid until'} {day(b.period_end)}</p>
      <p>ICT agents: {b.agents} of {b.max_agents}. Requesters (employees) are unlimited.</p></div>
    <div className="card"><h2>Pay with M-Pesa</h2><form onSubmit={pay}>
      {b.plans.map(p => <label key={p.code}><input type="radio" name="plan" checked={f.planCode === p.code} onChange={() => setF({ ...f, planCode: p.code })} /> {p.name}: up to {p.max_agents} ICT agents, {kes(p.price_month)} per month</label>)}
      <div className="row"><label>Period<select value={f.months} onChange={e => setF({ ...f, months: Number(e.target.value) })}><option value={1}>1 month</option><option value={12}>12 months</option></select></label>
        <Field label="M-Pesa phone number" value={f.phone} set={v => setF({ ...f, phone: v })} /></div>
      <p>Total: <b>{plan ? kes(plan.price_month * f.months) : ''}</b></p>
      <button className="btn" disabled={busy}>{busy ? 'Waiting for payment…' : 'Send M-Pesa prompt'}</button></form>
      {msg && <p>{msg}</p>}<Err e={err} /></div>
    <h2>Recent payments</h2><div className="wrap"><table><thead><tr><th>Date</th><th>Plan</th><th>Months</th><th>Amount</th><th>Method</th><th>Status</th><th>Receipt</th></tr></thead><tbody>
      {b.payments.length === 0 && <tr><td colSpan={7} className="mute">No payments yet.</td></tr>}
      {b.payments.map(p => <tr key={p.id}><td>{day(p.created_at)}</td><td>{p.plan_code}</td><td>{p.months}</td><td>{kes(p.amount)}</td><td>{p.method}</td><td>{p.status}</td><td>{p.mpesa_receipt ?? '—'}</td></tr>)}</tbody></table></div>
  </>)
}

export function PlatformPage() {
  type Org = { id: string; name: string; email_domain: string | null; plan_code: string; period_end: string; state: string; agents: number; users: number }
  type Adm = { id: string; name: string; email: string; active: boolean }
  const [orgs, setOrgs] = useState<Org[]>([]); const [plans, setPlans] = useState<Plan[]>([]); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [f, setF] = useState({ orgId: '', planCode: 'starter', months: 1, amount: '', reference: '' })
  const [open, setOpen] = useState<Org | null>(null); const [admins, setAdmins] = useState<Adm[]>([]); const [pwFor, setPwFor] = useState<Adm | null>(null); const [pw, setPw] = useState('')
  const load = useCallback(() => { api<Org[]>('/platform/orgs').then(setOrgs).catch(e => setErr(errMsg(e))); api<Plan[]>('/plans').then(setPlans).catch(() => undefined) }, [])
  useEffect(load, [load])
  const act = async (fn: () => Promise<unknown>, okMsg: string) => { setErr(''); setOk(''); try { await fn(); setOk(okMsg); load() } catch (x) { setErr(errMsg(x)) } }
  const show = async (o: Org) => { setOpen(o); setPwFor(null); setErr(''); setOk(''); try { setAdmins(await api<Adm[]>(`/platform/orgs/${o.id}/admins`)) } catch (x) { setErr(errMsg(x)) } }
  const record = (e: FormEvent) => { e.preventDefault(); void act(() => api(`/platform/orgs/${f.orgId}/payments`, { body: { planCode: f.planCode, months: f.months, amount: Number(f.amount), reference: f.reference } }), 'Payment recorded.') }
  const savePw = (e: FormEvent) => { e.preventDefault(); if (!pwFor) return; const a = pwFor; void act(async () => { await api(`/platform/users/${a.id}/password`, { body: { password: pw } }); setPwFor(null); setPw('') }, `Temporary password set for ${a.name}. Give it to them privately; they must change it at sign-in.`) }
  return (<>
    <h1>Customer organisations</h1>{ok && <p role="status">{ok}</p>}{err && <p className="err" role="alert">{err}</p>}
    <div className="wrap"><table className="cards"><thead><tr><th>Organisation</th><th>Domain</th><th>Plan</th><th>Status</th><th>Until</th><th>Agents</th><th>Users</th><th></th></tr></thead><tbody>
      {orgs.map(o => <tr key={o.id}><td data-label="Organisation">{o.name}</td><td data-label="Domain">{o.email_domain ?? '—'}</td><td data-label="Plan">{o.plan_code}</td><td data-label="Status">{o.state}</td><td data-label="Until">{day(o.period_end)}</td><td data-label="Agents">{o.agents}</td><td data-label="Users">{o.users}</td>
        <td data-label=""><button className="btn alt" style={{ margin: 0 }} onClick={() => show(o)}>Admins</button></td></tr>)}</tbody></table></div>
    {open && <div className="card" style={{ marginTop: '1rem' }}><h2>Administrators of {open.name}</h2>
      {admins.map(a => <div key={a.id} className="acts" style={{ margin: '.5rem 0' }}><span>{a.name} ({a.email}){a.active ? '' : ' · disabled'}</span>
        <button className="btn alt" onClick={() => act(() => api(`/platform/users/${a.id}/reset-link`, { method: 'POST', body: {} }), `Reset link emailed to ${a.email}.`)}>Email reset link</button>
        <button className="btn alt" onClick={() => { setPwFor(a); setPw('') }}>Temporary password</button></div>)}
      {pwFor && <form onSubmit={savePw}><Field label={`Temporary password for ${pwFor.name} (10+ characters)`} type="text" value={pw} set={setPw} /><button className="btn">Set password</button></form>}</div>}
    <div className="card" style={{ marginTop: '1rem' }}><h2>Record a bank / cash / paybill payment</h2><form onSubmit={record}>
      <div className="row"><label>Organisation<select value={f.orgId} onChange={e => setF({ ...f, orgId: e.target.value })} required><option value="">Choose…</option>{orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label>Plan<select value={f.planCode} onChange={e => setF({ ...f, planCode: e.target.value })}>{plans.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}</select></label>
        <label>Months<input type="number" min={1} max={36} value={f.months} onChange={e => setF({ ...f, months: Number(e.target.value) })} /></label></div>
      <div className="row"><Field label="Amount received (KSh)" type="number" value={f.amount} set={v => setF({ ...f, amount: v })} /><Field label="Reference (bank ref / receipt)" value={f.reference} set={v => setF({ ...f, reference: v })} /></div>
      <button className="btn">Record payment</button></form></div>
  </>)
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: (t: string) => void }) {
  const [f, setF] = useState({ name: '', password: '' }); const [err, setErr] = useState('')
  async function go(e: FormEvent) { e.preventDefault(); setErr(''); try { const r = await api<{ token: string }>('/auth/accept-invite', { body: { token, ...f } }); onDone(r.token) } catch (x) { setErr(errMsg(x)) } }
  return <div className="auth"><div className="card"><h1>Join your organisation</h1><p className="mute">Choose your name and a password to finish setting up your TechDesk account.</p>
    <form onSubmit={go}><Field label="Your name" value={f.name} set={v => setF({ ...f, name: v })} /><Field label="Password (10+ characters)" type="password" value={f.password} set={v => setF({ ...f, password: v })} />
      <Err e={err} /><button className="btn">Create my account</button></form></div></div>
}
export function ResetPassword({ token }: { token: string }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [done, setDone] = useState(false)
  async function go(e: FormEvent) { e.preventDefault(); setErr(''); try { await api('/auth/reset', { body: { token, password: pw } }); setDone(true) } catch (x) { setErr(errMsg(x)) } }
  return <div className="auth"><div className="card"><h1>Choose a new password</h1>{done ? <p>Password changed. <a href="#/">Sign in</a></p> :
    <form onSubmit={go}><Field label="New password (10+ characters)" type="password" value={pw} set={setPw} /><Err e={err} /><button className="btn">Change password</button></form>}</div></div>
}
export function Forgot() {
  const [email, setEmail] = useState(''); const [err, setErr] = useState(''); const [sent, setSent] = useState(false)
  async function go(e: FormEvent) { e.preventDefault(); setErr(''); try { await api('/auth/forgot', { body: { email } }); setSent(true) } catch (x) { setErr(errMsg(x)) } }
  return <div className="auth"><div className="card"><h1>Forgot your password?</h1>{sent ? <p>If that email has an account, a reset link is on its way. <a href="#/">Back to sign in</a></p> :
    <form onSubmit={go}><Field label="Work email" type="email" value={email} set={setEmail} /><Err e={err} /><button className="btn">Send reset link</button> <a href="#/">Cancel</a></form>}</div></div>
}

/** Shrinks big phone photos before upload (server limit is 5 MB per file). */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size < 400_000) return file
  try {
    const bmp = await createImageBitmap(file)
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.8))
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file
  } catch { return file }
}

export function StageTracker({ t, events }: { t: Ticket; events: Ev[] }) {
  const stages = ['Submitted', 'Assigned', 'In progress', 'Resolved', 'Closed']
  const cur = t.status === 'closed' ? 4 : t.status === 'resolved' ? 3 : t.status === 'in_progress' ? 2 : t.assignee_id ? 1 : 0
  const at = (i: number) => {
    const e = i === 0 ? events.find(x => x.type === 'created') : i === 1 ? events.find(x => x.type === 'assigned' && x.detail?.to)
      : events.find(x => x.type === 'status' && x.detail?.to === ['', '', 'in_progress', 'resolved', 'closed'][i])
    return e ? new Date(e.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : ''
  }
  return <div className="steps" role="list" aria-label="Ticket progress">{stages.map((s, i) =>
    <div key={s} role="listitem" className={'step' + (i < cur ? ' done' : i === cur ? ' cur' : '')} aria-current={i === cur ? 'step' : undefined}><i>{i < cur ? '✓' : i + 1}</i>{s}<small>{at(i)}</small></div>)}</div>
}

export function Timeline({ events }: { events: Ev[] }) {
  const text = (e: Ev) => e.type === 'created' ? `Ticket submitted${e.actor ? ' by ' + e.actor : ''}`
    : e.type === 'assigned' ? (e.detail?.to ? `Assigned to ${e.detail.to}` : 'Unassigned')
    : e.type === 'status' ? `Status changed from ${String(e.detail?.from).replace('_', ' ')} to ${String(e.detail?.to).replace('_', ' ')}`
    : e.type === 'sla_breach' ? 'Resolution deadline passed before the ticket was resolved'
    : e.type === 'response_breach' ? 'No response or action before the response deadline' : e.type
  return <div className="card"><h2>Progress history</h2><ul className="tl">{[...events].reverse().map((e, i) =>
    <li key={i} className={e.type.includes('breach') ? 'bad' : ''}><span className="mute">{new Date(e.created_at).toLocaleString()}</span> {text(e)}</li>)}</ul></div>
}

export function AttachmentItem({ a, onDownload }: { a: { id: string; filename: string; size: number }; onDownload: () => void }) {
  const isImg = /\.(png|jpe?g)$/i.test(a.filename); const [src, setSrc] = useState('')
  useEffect(() => {
    if (!isImg) return
    let url = ''
    apiBlob(`/attachments/${a.id}`).then(b => { url = URL.createObjectURL(b); setSrc(url) }).catch(() => undefined)
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [a.id, isImg])
  return <div className="thumb">{src && <img src={src} alt={a.filename} onClick={onDownload} />}<button className="btn alt" onClick={onDownload}>{a.filename}</button> <span className="mute">{Math.ceil(a.size / 1024)} KB</span></div>
}

export function ChangePassword({ forced, onDone, onCancel }: { forced?: boolean; onDone: (t: string) => void; onCancel?: () => void }) {
  const [f, setF] = useState({ current: '', password: '', again: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  async function go(e: FormEvent) {
    e.preventDefault(); setErr('')
    if (f.password !== f.again) return setErr('The new passwords do not match')
    setBusy(true)
    try { const r = await api<{ token: string }>('/auth/change-password', { body: { current: f.current, password: f.password } }); setF({ current: '', password: '', again: '' }); onDone(r.token) }
    catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  const form = <form onSubmit={go}><Field label={forced ? 'Temporary password' : 'Current password'} type="password" value={f.current} set={v => setF({ ...f, current: v })} />
    <Field label="New password (10+ characters)" type="password" value={f.password} set={v => setF({ ...f, password: v })} /><Field label="Repeat new password" type="password" value={f.again} set={v => setF({ ...f, again: v })} />
    <Err e={err} /><button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>{forced && onCancel && <> <button type="button" className="btn alt" onClick={onCancel}>Sign out</button></>}</form>
  return forced ? <div className="auth"><div className="card"><h1>Choose a new password</h1><p className="mute">An administrator set a temporary password for you. Choose your own to continue.</p>{form}</div></div>
    : <div className="card"><h2>Change password</h2>{form}</div>
}

export function AccountPage({ me, canInstall, install }: { me: Me; canInstall: boolean; install: () => void }) {
  const [msg, setMsg] = useState('')
  return (<>
    <div className="card"><h2>{me.name}</h2><p className="mute">{me.email} · {me.role}</p><p>You stay signed in on this device until you tap Sign out.</p></div>
    <ChangePassword onDone={t => { localStorage.setItem(TOKEN, t); setMsg('Password changed. You were signed out on your other devices.') }} />{msg && <p role="status">{msg}</p>}
    <div className="card"><h2>Install TechDesk on your device</h2>{canInstall && <button className="btn" onClick={install}>Install app</button>}
      <p><b>Android (Chrome):</b> menu ⋮, then "Install app" or "Add to Home screen".</p>
      <p><b>iPhone / iPad (Safari):</b> Share button, then "Add to Home Screen".</p>
      <p><b>Computer (Chrome or Edge):</b> the install icon in the address bar.</p></div>
  </>)
}

const fmtMin = (m: number | null) => m === null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`
const fmtPct = (p: number | null) => p === null ? '—' : p + '%'
type L = { label: string; n: number }
type Series = { date: string; created: number; resolved: number }
type Sla = { priority: string; response_min: number; resolve_min: number }
type Analytics = { days: number; unit: string
  summary: { created: number; resolved: number; open_now: number; unassigned_open: number; avg_first_response_min: number | null; avg_resolution_min: number | null; resolution_sla_pct: number | null; response_sla_pct: number | null; resolution_sample: number }
  series: Series[]; byCategory: L[]; byPriority: L[]; byStatus: L[]; byDepartment: L[]; topAssets: { tag: string; name: string; n: number }[]
  staff: { id: string; name: string; role: string; assigned: number; resolved: number; avg_resolution_min: number | null; open_now: number; missed_resolution: number; missed_response: number }[]
  unassignedMissed: { resolution: number; response: number }
  overdue: { id: string; number: number; title: string; priority: string; resolve_due: string; assignee: string | null }[]; insights: string[] }

function LineChart({ data }: { data: Series[] }) {
  const W = 640, H = 220, P = 34, max = Math.max(1, ...data.flatMap(d => [d.created, d.resolved]))
  const x = (i: number) => P + (data.length < 2 ? 0 : (i * (W - P - 10)) / (data.length - 1)), y = (v: number) => H - P - (v / max) * (H - P - 12)
  const line = (k: 'created' | 'resolved') => data.map((d, i) => `${x(i)},${y(d[k])}`).join(' ')
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Tickets created and resolved over time">
    {[0, 0.5, 1].map(f => <g key={f}><line x1={P} x2={W - 10} y1={y(max * f)} y2={y(max * f)} stroke="#dde3ee" /><text x={4} y={y(max * f) + 4} fontSize="11" fill="#5b6b85">{Math.round(max * f)}</text></g>)}
    <polyline points={line('created')} fill="none" stroke="#6c00ff" strokeWidth="2.5" /><polyline points={line('resolved')} fill="none" stroke="#12a150" strokeWidth="2.5" strokeDasharray="6 4" />
    <text x={P} y={H - 8} fontSize="11" fill="#5b6b85">{data[0]?.date}</text><text x={W - 10} y={H - 8} fontSize="11" fill="#5b6b85" textAnchor="end">{data[data.length - 1]?.date}</text></svg>
}
function Bars({ rows }: { rows: L[] }) {
  const max = Math.max(1, ...rows.map(r => r.n))
  return rows.length ? <>{rows.map(r => <div className="hbar" key={r.label}><span>{r.label.replace('_', ' ')}</span><div className="bar" style={{ width: `${(r.n / max) * 100}%` }} /><b>{r.n}</b></div>)}</> : <p className="mute">No data for this period.</p>
}

export function AnalyticsPage() {
  const [days, setDays] = useState(30); const [a, setA] = useState<Analytics | null>(null); const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [sla, setSla] = useState<Sla[]>([])
  useEffect(() => { setA(null); api<Analytics>(`/analytics?days=${days}`).then(setA).catch(e => setErr(errMsg(e))) }, [days])
  useEffect(() => { api<Sla[]>('/sla').then(r => setSla(['urgent', 'high', 'medium', 'low'].map(p => r.find(x => x.priority === p)).filter(Boolean) as Sla[])).catch(() => undefined) }, [])
  async function exportCsv() {
    try { const url = URL.createObjectURL(await apiBlob(`/analytics/export.csv?days=${days}`)); const l = document.createElement('a'); l.href = url; l.download = `techdesk-tickets-${days}d.csv`; l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) } catch (x) { setErr(errMsg(x)) }
  }
  async function saveSla(e: FormEvent) { e.preventDefault(); setErr(''); setOk(''); try { await api('/sla', { method: 'PUT', body: sla }); setOk('Service targets saved. They apply to tickets created from now on.') } catch (x) { setErr(errMsg(x)) } }
  const setS = (p: string, k: 'response_min' | 'resolve_min', v: number) => setSla(sla.map(r => r.priority === p ? { ...r, [k]: v } : r))
  return (<>
    <div className="row" style={{ alignItems: 'end' }}><h1>Analytics</h1>
      <label>Period<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 12 months</option></select></label>
      <button className="btn alt" onClick={exportCsv}>Download tickets (CSV)</button></div>
    {err && <p className="err" role="alert">{err}</p>}{!a && !err && <p>Loading…</p>}
    {a && <>
      <div className="stats">
        <div className="stat"><b>{a.summary.created}</b>tickets raised</div><div className="stat"><b>{a.summary.resolved}</b>resolved</div><div className="stat"><b>{a.summary.open_now}</b>open now</div>
        <div className="stat"><b>{fmtMin(a.summary.avg_first_response_min)}</b>avg first response</div><div className="stat"><b>{fmtMin(a.summary.avg_resolution_min)}</b>avg resolution</div>
        <div className="stat"><b>{fmtPct(a.summary.response_sla_pct)}</b>responded in time</div><div className="stat"><b>{fmtPct(a.summary.resolution_sla_pct)}</b>resolved in time</div></div>
      {a.insights.length > 0 && <div className="card"><h2>Things worth a look</h2><ul>{a.insights.map((t, i) => <li key={i}>{t}</li>)}</ul><p className="mute">Observations from your own ticket data, to help you plan. They are not conclusions.</p></div>}
      <div className="card"><h2>Tickets over time</h2><LineChart data={a.series} /><p className="legend mute"><span style={{ color: '#6c00ff' }}>━ Raised</span><span style={{ color: '#12a150' }}>╍ Resolved</span> per {a.unit}</p></div>
      <div className="grid2"><div className="card"><h2>By location (department)</h2><Bars rows={a.byDepartment} /></div><div className="card"><h2>By category</h2><Bars rows={a.byCategory} /></div>
        <div className="card"><h2>By priority</h2><Bars rows={a.byPriority} /></div><div className="card"><h2>By current status</h2><Bars rows={a.byStatus} /></div></div>
      {a.topAssets.length > 0 && <div className="card"><h2>Equipment with the most tickets</h2><Bars rows={a.topAssets.map(x => ({ label: `${x.tag} ${x.name}`, n: x.n }))} /></div>}
      <h2>ICT team: deadlines</h2><p className="mute">Counts tickets where the person was the assignee when the deadline passed. Reassigning a ticket does not hide the miss.</p>
      <div className="wrap"><table className="cards"><thead><tr><th>Staff</th><th>Assigned</th><th>Resolved</th><th>Avg resolution</th><th>Open now</th><th>No action by response deadline</th><th>Unresolved at resolution deadline</th></tr></thead><tbody>
        {a.staff.map(s => <tr key={s.id}><td data-label="Staff">{s.name}</td><td data-label="Assigned">{s.assigned}</td><td data-label="Resolved">{s.resolved}</td><td data-label="Avg resolution">{fmtMin(s.avg_resolution_min)}</td><td data-label="Open now">{s.open_now}</td>
          <td data-label="No action by response deadline" className={s.missed_response ? 'bad-n' : ''}>{s.missed_response}</td><td data-label="Unresolved at resolution deadline" className={s.missed_resolution ? 'bad-n' : ''}>{s.missed_resolution}</td></tr>)}
        <tr><td data-label="Staff"><i>Not assigned to anyone</i></td><td data-label="Assigned">—</td><td data-label="Resolved">—</td><td data-label="Avg resolution">—</td><td data-label="Open now">{a.summary.unassigned_open}</td>
          <td data-label="No action by response deadline" className={a.unassignedMissed.response ? 'bad-n' : ''}>{a.unassignedMissed.response}</td><td data-label="Unresolved at resolution deadline" className={a.unassignedMissed.resolution ? 'bad-n' : ''}>{a.unassignedMissed.resolution}</td></tr></tbody></table></div>
      <h2 style={{ marginTop: '1.2rem' }}>Overdue right now</h2>
      <div className="wrap"><table className="cards"><thead><tr><th>Ticket</th><th>Title</th><th>Priority</th><th>Assignee</th><th>Was due</th></tr></thead><tbody>
        {a.overdue.length === 0 && <tr><td colSpan={5} className="mute">No overdue tickets.</td></tr>}
        {a.overdue.map(o => <tr key={o.id}><td data-label="Ticket">TD-{o.number}</td><td data-label="Title">{o.title}</td><td data-label="Priority">{o.priority}</td><td data-label="Assignee">{o.assignee ?? 'Unassigned'}</td><td data-label="Was due">{new Date(o.resolve_due).toLocaleString()}</td></tr>)}</tbody></table></div>
    </>}
    {sla.length > 0 && <div className="card" style={{ marginTop: '1rem' }}><h2>Service targets (SLA)</h2><p className="mute">Minutes allowed for the first response and for resolution, by priority. The ICT team is measured against these.</p>
      <form onSubmit={saveSla}>{sla.map(r => <div className="row" key={r.priority}><b style={{ alignSelf: 'center' }}>{r.priority}</b>
        <label>Respond within (min)<input type="number" min={1} value={r.response_min} onChange={e => setS(r.priority, 'response_min', Number(e.target.value))} /></label>
        <label>Resolve within (min)<input type="number" min={1} value={r.resolve_min} onChange={e => setS(r.priority, 'resolve_min', Number(e.target.value))} /></label></div>)}
        <button className="btn">Save targets</button>{ok && <span role="status"> {ok}</span>}</form></div>}
  </>)
}
