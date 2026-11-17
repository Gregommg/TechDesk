import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import EmbeddedPostgres from 'embedded-postgres'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { SMTPServer } from 'smtp-server'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

let pg: EmbeddedPostgres
let api: ReturnType<typeof request>
let db: typeof import('../src/db.js')
let feat: typeof import('../src/features.js')
const S: Record<string, any> = {}
const PW = 'longenough1'
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const mails: { to: string[]; subject: string; text: string }[] = []
const mailer = async (to: string[], subject: string, text: string) => { mails.push({ to, subject, text }) }
const stk: any[] = []
const mpesa = { async stkPush(a: any) { stk.push(a); return { checkoutRequestId: 'ws_CO_' + stk.length } } }
const flush = () => new Promise(r => setTimeout(r, 200)) // notification emails are sent in the background
const CB = 'cbsecret-123456'
const cb = (id: string, code: number, amount: number) => api.post(`/api/mpesa/callback/${CB}`).send({ Body: { stkCallback: { CheckoutRequestID: id, ResultCode: code,
  CallbackMetadata: code === 0 ? { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: 'QWE123XYZ' }] } : undefined } } })

async function join(admin: string, email: string, role: string, name = 'User') {
  const r = await api.post('/api/invites').set(auth(admin)).send({ email, role })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const token = mails.filter(m => m.to.includes(email)).at(-1)!.text.match(/token=([\w-]+)/)![1]
  const a = await api.post('/api/auth/accept-invite').send({ token, name, password: PW })
  assert.equal(a.status, 201, JSON.stringify(a.body))
  return { token: a.body.token as string, id: a.body.user.id as string }
}
async function register(orgName: string, email: string) {
  const r = await api.post('/api/auth/register').send({ orgName, name: 'Admin', email, password: PW })
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.token as string
}

before(async () => {
  pg = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'td-pg-')), user: 'td', password: 'td', port: 54330, persistent: false })
  await pg.initialise(); await pg.start(); await pg.createDatabase('techdesk')
  Object.assign(process.env, { DATABASE_URL: 'postgres://td:td@localhost:54330/techdesk', JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test',
    UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'td-up-')), MPESA_CALLBACK_SECRET: CB, APP_URL: 'http://app.test' })
  db = await import('../src/db.js'); feat = await import('../src/features.js'); await db.migrate()
  api = request((await import('../src/app.js')).createApp({ mailer, mpesa }))
})
after(async () => { await db.pool.end(); await pg.stop() })

test('registration: work email required, plan and password validated, orgs created', async () => {
  const bad = (b: object) => api.post('/api/auth/register').send({ orgName: 'X', name: 'X', email: 'x@x.co', password: PW, ...b })
  assert.equal((await bad({ email: 'someone@gmail.com' })).status, 400)
  assert.equal((await bad({ planCode: 'nope' })).status, 400)
  assert.equal((await bad({ password: 'short' })).status, 400)
  assert.equal((await bad({ email: 'nope' })).status, 400)
  S.A = await register('Org A', 'a@a.co'); S.B = await register('Org B', 'b@b.co')
  assert.equal((await bad({ email: 'a@a.co' })).status, 409)
  const me = await api.get('/api/me').set(auth(S.A))
  assert.equal(me.body.sub.state, 'trialing'); assert.equal(me.body.sub.plan, 'starter')
  assert.equal((await api.get('/api/plans')).body.length, 3)
})

test('login works, wrong password fails, protected routes need a valid token', async () => {
  assert.equal((await api.post('/api/auth/login').send({ email: 'a@a.co', password: PW })).status, 200)
  assert.equal((await api.post('/api/auth/login').send({ email: 'a@a.co', password: 'wrong-password' })).status, 401)
  assert.equal((await api.get('/api/tickets')).status, 401)
  assert.equal((await api.get('/api/tickets').set('Authorization', 'Bearer garbage')).status, 401)
})

test('invitations: work-email domain enforced, admin only, single use', async () => {
  assert.equal((await api.post('/api/invites').set(auth(S.A)).send({ email: 'x@other.com', role: 'technician' })).status, 400)
  assert.equal((await api.post('/api/invites').set(auth(S.A)).send({ email: 'x@evil-a.co', role: 'technician' })).status, 400)
  assert.equal((await api.post('/api/invites').set(auth(S.A)).send({ email: 'a@a.co', role: 'technician' })).status, 409)
  S.tech = await join(S.A, 't@a.co', 'technician', 'Tech'); S.req = await join(S.A, 'r@a.co', 'requester', 'Req')
  S.T = S.tech.token; S.R = S.req.token
  assert.equal((await api.post('/api/invites').set(auth(S.R)).send({ email: 'z@a.co', role: 'requester' })).status, 403)
  assert.equal((await api.post('/api/invites').set(auth(S.T)).send({ email: 'z@a.co', role: 'requester' })).status, 403)
  const token = mails.filter(m => m.to.includes('r@a.co')).at(-1)!.text.match(/token=([\w-]+)/)![1]
  assert.equal((await api.post('/api/auth/accept-invite').send({ token, name: 'Again', password: PW })).status, 400)
  assert.equal((await api.post('/api/auth/accept-invite').send({ token: 'x'.repeat(30), name: 'N', password: PW })).status, 400)
  assert.equal((await api.get('/api/users').set(auth(S.R))).status, 403)
  assert.equal((await api.get('/api/invites').set(auth(S.A))).body.length, 0)
})

test('ticket lifecycle with SLA deadlines, notifications and resolution time', async () => {
  assert.equal((await api.post('/api/tickets').set(auth(S.R)).send({ title: '', description: 'x', category: 'Hardware', priority: 'high' })).status, 400)
  const c = await api.post('/api/tickets').set(auth(S.R)).send({ title: 'Laptop will not boot', description: 'Black screen', category: 'Hardware', priority: 'high' })
  assert.equal(c.status, 201); assert.equal(c.body.number, 1); assert.ok(c.body.response_due && c.body.resolve_due)
  S.ticket = c.body.id
  await flush()
  assert.ok(mails.some(m => m.subject.includes('New ticket TD-1') && m.to.includes('t@a.co') && m.to.includes('a@a.co')))
  S.t2 = (await api.post('/api/tickets').set(auth(S.R)).send({ title: 'Second', description: 'd', category: 'Software', priority: 'low' })).body.id
  assert.equal((await api.patch(`/api/tickets/${S.ticket}`).set(auth(S.R)).send({ status: 'closed' })).status, 403)
  assert.equal((await api.patch(`/api/tickets/${S.ticket}`).set(auth(S.T)).send({ status: 'bogus' })).status, 400)
  assert.equal((await api.patch(`/api/tickets/${S.ticket}`).set(auth(S.T)).send({ assigneeId: S.tech.id, status: 'in_progress' })).status, 200)
  await flush()
  assert.ok(mails.some(m => m.subject.includes('assigned to you') && m.to.includes('t@a.co')))
  assert.ok(mails.some(m => m.subject.includes('TD-1 is now in progress') && m.to.includes('r@a.co')))
  const d = await api.get(`/api/tickets/${S.ticket}`).set(auth(S.R))
  assert.equal(d.body.ticket.status, 'in_progress'); assert.equal(d.body.ticket.assignee, 'Tech'); assert.equal(d.body.ticket.resolved_at, null)
  const dash = await api.get('/api/dashboard').set(auth(S.T))
  assert.equal(dash.body.byStatus.in_progress, 1); assert.equal(dash.body.mine, 1)
})

test('internal notes stay hidden and unemailed; public replies notify the requester', async () => {
  await flush()
  const before = mails.filter(m => m.to.includes('r@a.co')).length
  await api.post(`/api/tickets/${S.ticket}/messages`).set(auth(S.T)).send({ body: 'SECRET NOTE', internal: true })
  await flush()
  assert.equal(mails.filter(m => m.to.includes('r@a.co')).length, before)
  await api.post(`/api/tickets/${S.ticket}/messages`).set(auth(S.T)).send({ body: 'We are looking into it' })
  await flush()
  assert.equal(mails.filter(m => m.to.includes('r@a.co')).length, before + 1)
  await api.post(`/api/tickets/${S.ticket}/messages`).set(auth(S.R)).send({ body: 'Thanks', internal: true })
  await flush()
  assert.ok(mails.some(m => m.subject.includes('New reply on TD-1') && m.to.includes('t@a.co')))
  const asReq = (await api.get(`/api/tickets/${S.ticket}`).set(auth(S.R))).body
  assert.deepEqual(asReq.messages.map((m: any) => m.body), ['We are looking into it', 'Thanks'])
  assert.ok(asReq.ticket.first_response_at)
  assert.equal((await api.get(`/api/tickets/${S.ticket}`).set(auth(S.T))).body.messages.length, 3)
})

test('tenant isolation and requester isolation', async () => {
  assert.equal((await api.get(`/api/tickets/${S.ticket}`).set(auth(S.B))).status, 404)
  assert.equal((await api.patch(`/api/tickets/${S.ticket}`).set(auth(S.B)).send({ status: 'closed' })).status, 404)
  assert.equal((await api.post(`/api/tickets/${S.ticket}/messages`).set(auth(S.B)).send({ body: 'hi' })).status, 404)
  assert.deepEqual((await api.get('/api/tickets').set(auth(S.B))).body, [])
  const bAdmin = (await api.get('/api/users').set(auth(S.B))).body[0].id
  assert.equal((await api.patch(`/api/tickets/${S.ticket}`).set(auth(S.A)).send({ assigneeId: bAdmin })).status, 400)
  const R2 = await join(S.A, 'r2@a.co', 'requester', 'Req2'); S.R2 = R2
  assert.deepEqual((await api.get('/api/tickets').set(auth(R2.token))).body, [])
  assert.equal((await api.get(`/api/tickets/${S.ticket}`).set(auth(R2.token))).status, 404)
  assert.equal((await api.get('/api/tickets').set(auth(S.R))).body.length, 2)
})

test('attachments: allowed type works, bad type rejected, access controlled', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const ok = await api.post(`/api/tickets/${S.ticket}/attachments`).set(auth(S.R)).attach('file', png, { filename: 'screen.png', contentType: 'image/png' })
  assert.equal(ok.status, 201)
  assert.equal((await api.post(`/api/tickets/${S.ticket}/attachments`).set(auth(S.R)).attach('file', Buffer.from('MZ'), { filename: 'virus.exe', contentType: 'application/x-msdownload' })).status, 400)
  const dl = await api.get(`/api/attachments/${ok.body.id}`).set(auth(S.R))
  assert.equal(dl.status, 200); assert.match(dl.headers['content-disposition'], /attachment/)
  assert.equal((await api.get(`/api/attachments/${ok.body.id}`).set(auth(S.B))).status, 404)
  assert.equal((await api.get(`/api/attachments/${ok.body.id}`).set(auth(S.R2.token))).status, 404)
})

test('assets: staff manage, requesters see only theirs, tickets link to own-organisation assets', async () => {
  const mk = (tok: string, b: object) => api.post('/api/assets').set(auth(tok)).send({ tag: 'LT-001', name: 'Dell Latitude', category: 'Laptop', ...b })
  assert.equal((await mk(S.R, {})).status, 403)
  const a = await mk(S.T, { assignedTo: S.req.id, warrantyUntil: '2027-06-30' }); assert.equal(a.status, 201)
  assert.equal((await mk(S.T, {})).status, 409)
  const other = (await mk(S.T, { tag: 'LT-002' })).body.id
  assert.equal((await mk(S.T, { tag: 'LT-003', assignedTo: (await api.get('/api/users').set(auth(S.B))).body[0].id })).status, 400)
  assert.deepEqual((await api.get('/api/assets').set(auth(S.R))).body.map((x: any) => x.tag), ['LT-001'])
  assert.equal((await api.get('/api/assets').set(auth(S.T))).body.length, 2)
  assert.equal((await api.patch(`/api/assets/${other}`).set(auth(S.T)).send({ status: 'repair' })).status, 200)
  assert.equal((await api.patch(`/api/assets/${other}`).set(auth(S.B)).send({ status: 'retired' })).status, 404)
  const t = await api.post('/api/tickets').set(auth(S.R)).send({ title: 'Screen flicker', description: 'd', category: 'Hardware', priority: 'medium', assetId: a.body.id })
  assert.equal(t.status, 201)
  assert.equal((await api.get(`/api/tickets/${t.body.id}`).set(auth(S.R))).body.ticket.asset_tag, 'LT-001')
  assert.equal((await api.post('/api/tickets').set(auth(S.R)).send({ title: 'x', description: 'd', category: 'Hardware', priority: 'low', assetId: other })).status, 400)
  assert.equal((await api.post('/api/tickets').set(auth(S.B)).send({ title: 'x', description: 'd', category: 'Hardware', priority: 'low', assetId: a.body.id })).status, 400)
})

test('knowledge base: drafts private to staff, search works, organisations separated', async () => {
  const art = await api.post('/api/kb').set(auth(S.T)).send({ title: 'Reset your Wi-Fi password', body: 'Open Settings, then Network.', category: 'Network' })
  assert.equal(art.status, 201)
  assert.equal((await api.post('/api/kb').set(auth(S.R)).send({ title: 'x', body: 'y' })).status, 403)
  assert.equal((await api.get('/api/kb').set(auth(S.R))).body.length, 0)
  assert.equal((await api.patch(`/api/kb/${art.body.id}`).set(auth(S.T)).send({ published: true })).status, 200)
  assert.equal((await api.get('/api/kb?q=wi-fi').set(auth(S.R))).body.length, 1)
  assert.equal((await api.get('/api/kb?q=printer').set(auth(S.R))).body.length, 0)
  assert.equal((await api.get('/api/kb').set(auth(S.B))).body.length, 0)
  assert.equal((await api.patch(`/api/kb/${art.body.id}`).set(auth(S.B)).send({ published: false })).status, 404)
})

test('SLA: breach sweep flags overdue tickets once and emails staff', async () => {
  await db.pool.query('UPDATE tickets SET resolve_due=now()-interval \'1 hour\' WHERE id=$1', [S.t2])
  const n = await feat.slaSweep(feat.makeNotifier(mailer))
  assert.ok(n >= 1)
  assert.equal((await api.get(`/api/tickets/${S.t2}`).set(auth(S.T))).body.ticket.breached, true)
  assert.ok(mails.some(m => m.subject.includes('SLA breached: TD-2')))
  assert.equal(await feat.slaSweep(feat.makeNotifier(mailer)), 0)
  assert.equal((await api.patch(`/api/tickets/${S.ticket}`).set(auth(S.T)).send({ status: 'resolved' })).status, 200)
  assert.ok((await api.get(`/api/tickets/${S.ticket}`).set(auth(S.T))).body.ticket.resolved_at)
  assert.equal((await api.put('/api/sla').set(auth(S.A)).send([{ priority: 'urgent', response_min: 15, resolve_min: 120 }])).status, 200)
  assert.equal((await api.put('/api/sla').set(auth(S.T)).send([{ priority: 'urgent', response_min: 15, resolve_min: 120 }])).status, 403)
})

test('password reset: link works once, old sessions end, unknown emails reveal nothing', async () => {
  const n = mails.length
  assert.equal((await api.post('/api/auth/forgot').send({ email: 'nobody@a.co' })).status, 200); assert.equal(mails.length, n)
  const oldToken = (await api.post('/api/auth/login').send({ email: 'r2@a.co', password: PW })).body.token
  assert.equal((await api.get('/api/me').set(auth(oldToken))).status, 200)
  assert.equal((await api.post('/api/auth/forgot').send({ email: 'r2@a.co' })).status, 200)
  const token = mails.at(-1)!.text.match(/token=([\w-]+)/)![1]
  assert.equal((await api.post('/api/auth/reset').send({ token, password: 'short' })).status, 400)
  assert.equal((await api.post('/api/auth/reset').send({ token, password: 'brand-new-pass-9' })).status, 200)
  assert.equal((await api.post('/api/auth/reset').send({ token, password: 'another-pass-99' })).status, 400)
  assert.equal((await api.get('/api/me').set(auth(oldToken))).status, 401)
  assert.equal((await api.post('/api/auth/login').send({ email: 'r2@a.co', password: PW })).status, 401)
  assert.equal((await api.post('/api/auth/login').send({ email: 'r2@a.co', password: 'brand-new-pass-9' })).status, 200)
})

test('disabled users are locked out; audit log is admin only', async () => {
  const r2 = (await api.get('/api/users').set(auth(S.A))).body.find((u: any) => u.email === 'r2@a.co')
  assert.equal((await api.patch(`/api/users/${r2.id}`).set(auth(S.A)).send({ active: false })).status, 200)
  assert.equal((await api.post('/api/auth/login').send({ email: 'r2@a.co', password: 'brand-new-pass-9' })).status, 401)
  assert.equal((await api.get('/api/audit').set(auth(S.R))).status, 403)
  const log = (await api.get('/api/audit').set(auth(S.A))).body
  for (const a of ['ticket.update', 'user.update', 'invite.create', 'user.join', 'asset.create', 'kb.create', 'sla.breach', 'sla.update'])
    assert.ok(log.some((l: any) => l.action === a), 'missing audit ' + a)
})

test('plan limits: agent seats enforced on invite, accept and re-enable', async () => {
  S.C = await register('Org C', 'c@c.co')
  const t1 = await join(S.C, 't1@c.co', 'technician'); await join(S.C, 't2@c.co', 'technician')
  assert.equal((await api.post('/api/invites').set(auth(S.C)).send({ email: 't3@c.co', role: 'technician' })).status, 402)
  assert.equal((await api.post('/api/invites').set(auth(S.C)).send({ email: 'req@c.co', role: 'requester' })).status, 201)
  assert.equal((await api.patch(`/api/users/${t1.id}`).set(auth(S.C)).send({ active: false })).status, 200)
  assert.equal((await api.post('/api/invites').set(auth(S.C)).send({ email: 't3@c.co', role: 'technician' })).status, 201)
  const tok = mails.filter(m => m.to.includes('t3@c.co')).at(-1)!.text.match(/token=([\w-]+)/)![1]
  assert.equal((await api.post('/api/auth/accept-invite').send({ token: tok, name: 'T3', password: PW })).status, 201)
  assert.equal((await api.patch(`/api/users/${t1.id}`).set(auth(S.C)).send({ active: true })).status, 402)
})

test('subscription states: trial, grace keeps working, expiry makes it read-only but billing stays open', async () => {
  const setEnd = (iv: string) => db.pool.query(`UPDATE organisations SET period_end=now()-interval '${iv}' WHERE name='Org C'`)
  const newTicket = () => api.post('/api/tickets').set(auth(S.C)).send({ title: 'T', description: 'd', category: 'Other', priority: 'low' })
  await setEnd('3 days')
  assert.equal((await api.get('/api/me').set(auth(S.C))).body.sub.state, 'grace'); assert.equal((await newTicket()).status, 201)
  await setEnd('30 days')
  assert.equal((await api.get('/api/me').set(auth(S.C))).body.sub.state, 'suspended')
  const blocked = await newTicket(); assert.equal(blocked.status, 402)
  assert.equal((await api.get('/api/tickets').set(auth(S.C))).status, 200)
  assert.equal((await api.get('/api/billing').set(auth(S.C))).status, 200)
})

test('M-Pesa: STK push, callback security, amount check, idempotency, activation', async () => {
  const co = (b: object) => api.post('/api/billing/checkout').set(auth(S.C)).send(b)
  assert.equal((await co({ planCode: 'business', months: 3, phone: '0712345678' })).status, 400)
  assert.equal((await co({ planCode: 'business', months: 1, phone: '12345' })).status, 400)
  assert.equal((await co({ planCode: 'nope', months: 1, phone: '0712345678' })).status, 400)
  assert.equal((await api.post('/api/billing/checkout').set(auth(S.R)).send({ planCode: 'business', months: 1, phone: '0712345678' })).status, 403)
  const c1 = await co({ planCode: 'business', months: 1, phone: '0712 345 678' }); assert.equal(c1.status, 201)
  assert.equal(stk.at(-1).phone, '254712345678'); assert.equal(stk.at(-1).amount, 7500); assert.equal(c1.body.amount, 7500)
  assert.equal((await api.post('/api/mpesa/callback/wrong-secret').send({})).status, 404)
  const id1 = 'ws_CO_' + stk.length
  assert.equal((await cb(id1, 0, 100)).status, 200)
  assert.equal((await api.get(`/api/billing/payments/${c1.body.paymentId}`).set(auth(S.C))).body.status, 'failed')
  assert.equal((await api.get('/api/me').set(auth(S.C))).body.sub.state, 'suspended')
  const c2 = await co({ planCode: 'business', months: 1, phone: '254712345678' }); const id2 = 'ws_CO_' + stk.length
  await cb(id2, 1032, 0)
  assert.equal((await api.get(`/api/billing/payments/${c2.body.paymentId}`).set(auth(S.C))).body.status, 'failed')
  const c3 = await co({ planCode: 'business', months: 1, phone: '+254712345678' }); const id3 = 'ws_CO_' + stk.length
  await cb(id3, 0, 7500)
  const p = (await api.get(`/api/billing/payments/${c3.body.paymentId}`).set(auth(S.C))).body
  assert.equal(p.status, 'paid'); assert.equal(p.mpesa_receipt, 'QWE123XYZ')
  const b1 = (await api.get('/api/billing').set(auth(S.C))).body
  assert.equal(b1.state, 'active'); assert.equal(b1.plan_code, 'business'); assert.ok(new Date(b1.period_end) > new Date())
  await cb(id3, 0, 7500)
  assert.equal((await api.get('/api/billing').set(auth(S.C))).body.period_end, b1.period_end)
  assert.equal((await api.get('/api/tickets').set(auth(S.C))).status, 200)
  assert.equal((await api.post('/api/tickets').set(auth(S.C)).send({ title: 'T', description: 'd', category: 'Other', priority: 'low' })).status, 201)
})

test('platform admin: sees all organisations, records manual payments, edits plans; others blocked', async () => {
  const org = (await db.pool.query("INSERT INTO organisations(name,paid,period_end) VALUES('Orbitra Platform',true,now()+interval '100 years') RETURNING id")).rows[0]
  await db.pool.query("INSERT INTO users(org_id,name,email,password_hash,role,is_platform) VALUES($1,'Plat','p@orbitra.co',$2,'admin',true)", [org.id, await bcrypt.hash(PW, 4)])
  const P = (await api.post('/api/auth/login').send({ email: 'p@orbitra.co', password: PW })).body.token
  assert.equal((await api.get('/api/platform/orgs').set(auth(S.A))).status, 403)
  const orgs = (await api.get('/api/platform/orgs').set(auth(P))).body
  assert.ok(orgs.some((o: any) => o.name === 'Org A' && o.state === 'trialing'))
  const bId = orgs.find((o: any) => o.name === 'Org B').id
  assert.equal((await api.post(`/api/platform/orgs/${bId}/payments`).set(auth(S.B)).send({ planCode: 'starter', months: 1, amount: 2500, reference: 'x' })).status, 403)
  assert.equal((await api.post(`/api/platform/orgs/${bId}/payments`).set(auth(P)).send({ planCode: 'starter', months: 12, amount: 25000, reference: 'Bank ref 889' })).status, 201)
  assert.equal((await api.get('/api/billing').set(auth(S.B))).body.state, 'active')
  assert.equal((await api.patch('/api/platform/plans/starter').set(auth(P)).send({ price_month: 3000 })).status, 200)
  assert.equal((await api.get('/api/plans')).body.find((p: any) => p.code === 'starter').price_month, 3000)
  assert.equal((await api.patch('/api/platform/plans/starter').set(auth(S.A)).send({ price_month: 1 })).status, 403)
})

test('phone numbers are normalised; real SMTP transport delivers a message', async () => {
  assert.equal(feat.normalisePhone('0712345678'), '254712345678'); assert.equal(feat.normalisePhone('0112345678'), '254112345678')
  assert.throws(() => feat.normalisePhone('0612345678'))
  let raw = ''
  const srv = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS', 'AUTH'], onData(stream, _s, done) { stream.on('data', c => (raw += c)); stream.on('end', done) } })
  await new Promise<void>(r => srv.listen(2526, '127.0.0.1', r))
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2526', SMTP_FROM: 'TechDesk <no-reply@techdesk.test>' })
  const { smtpMailer } = await import('../src/mail.js')
  await smtpMailer()(['someone@a.co'], 'Hello from TechDesk', 'Body text here')
  await new Promise<void>(r => srv.close(() => r()))
  assert.match(raw, /Subject: Hello from TechDesk/); assert.match(raw, /Body text here/)
})

// ---------------------------------------------------------------- v3 features
const cookieOf = (r: any) => (r.headers['set-cookie'] as string[])[0].split(';')[0]
const login = (email: string, password = PW) => api.post('/api/auth/login').send({ email, password })

test('stay signed in: cookie session refreshes tokens until logout', async () => {
  const l = await login('a@a.co')
  assert.match((l.headers['set-cookie'] as string[])[0], /HttpOnly/i); assert.match((l.headers['set-cookie'] as string[])[0], /SameSite=Strict/i)
  const cookie = cookieOf(l)
  const r1 = await api.post('/api/auth/refresh').set('Cookie', cookie)
  assert.equal(r1.status, 200); assert.equal((await api.get('/api/me').set(auth(r1.body.token))).status, 200)
  assert.equal((await api.post('/api/auth/refresh')).status, 401)
  assert.equal((await api.post('/api/auth/refresh').set('Cookie', 'td_session=garbage')).status, 401)
  assert.equal((await api.post('/api/auth/logout').set('Cookie', cookie)).status, 200)
  assert.equal((await api.post('/api/auth/refresh').set('Cookie', cookie)).status, 401)
})

test('change own password: needs current password, ends old sessions', async () => {
  const U = await join(S.A, 'cp@a.co', 'requester', 'Cp')
  const cookie = cookieOf(await login('cp@a.co'))
  const ch = (b: object) => api.post('/api/auth/change-password').set(auth(U.token)).send(b)
  assert.equal((await ch({ current: 'nope-nope-nope', password: 'brand-new-pass-1' })).status, 400)
  assert.equal((await ch({ current: PW, password: PW })).status, 400)
  assert.equal((await ch({ current: PW, password: 'short' })).status, 400)
  const ok = await ch({ current: PW, password: 'brand-new-pass-1' }); assert.equal(ok.status, 200)
  assert.equal((await api.get('/api/me').set(auth(U.token))).status, 401)
  assert.equal((await api.post('/api/auth/refresh').set('Cookie', cookie)).status, 401)
  assert.equal((await api.get('/api/me').set(auth(ok.body.token))).status, 200)
  assert.equal((await login('cp@a.co', 'brand-new-pass-1')).status, 200)
})

test('organisation admin manages user passwords and roles', async () => {
  const U = await join(S.A, 'mp@a.co', 'requester', 'Mp')
  const adminId = (await api.get('/api/me').set(auth(S.A))).body.id
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.R)).send({ password: 'Temporary-pass-1' })).status, 403)
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.T)).send({ password: 'Temporary-pass-1' })).status, 403)
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.B)).send({ password: 'Temporary-pass-1' })).status, 404)
  assert.equal((await api.post(`/api/users/${adminId}/password`).set(auth(S.A)).send({ password: 'Temporary-pass-1' })).status, 400)
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.A)).send({ password: 'short' })).status, 400)
  assert.equal((await api.post(`/api/users/${U.id}/password`).set(auth(S.A)).send({ password: 'Temporary-pass-1' })).status, 200)
  assert.equal((await api.get('/api/me').set(auth(U.token))).status, 401)
  assert.equal((await login('mp@a.co')).status, 401)
  const t = (await login('mp@a.co', 'Temporary-pass-1')).body.token
  assert.equal((await api.get('/api/tickets').set(auth(t))).status, 403)
  assert.equal((await api.get('/api/me').set(auth(t))).body.must_change_password, true)
  const done = await api.post('/api/auth/change-password').set(auth(t)).send({ current: 'Temporary-pass-1', password: 'my-own-new-pass-7' })
  assert.equal(done.status, 200); assert.equal((await api.get('/api/tickets').set(auth(done.body.token))).status, 200)
  assert.equal((await api.get('/api/me').set(auth(done.body.token))).body.must_change_password, false)
  await flush()
  assert.ok(mails.some(m => m.to.includes('mp@a.co') && m.subject.includes('password was reset')))
  assert.ok(!mails.some(m => m.text.includes('Temporary-pass-1')))
  // reset link
  assert.equal((await api.post(`/api/users/${U.id}/reset-link`).set(auth(S.A))).status, 200); await flush()
  const link = mails.filter(m => m.to.includes('mp@a.co')).at(-1)!.text.match(/token=([\w-]+)/)![1]
  assert.equal((await api.post('/api/auth/reset').send({ token: link, password: 'after-reset-pass-3' })).status, 200)
  assert.equal((await login('mp@a.co', 'after-reset-pass-3')).status, 200)
  // role assignment
  assert.equal((await api.patch(`/api/users/${U.id}`).set(auth(S.A)).send({ role: 'technician' })).body.role, 'technician')
  assert.equal((await api.get('/api/dashboard').set(auth((await login('mp@a.co', 'after-reset-pass-3')).body.token))).status, 200)
  assert.equal((await api.patch(`/api/users/${U.id}`).set(auth(S.A)).send({ role: 'requester' })).body.role, 'requester')
  assert.equal((await api.patch(`/api/users/${adminId}`).set(auth(S.A)).send({ role: 'requester' })).status, 400)
})

test('platform admin manages organisation admin passwords only', async () => {
  const P = (await login('p@orbitra.co')).body.token
  S.D = await register('Org D', 'd@d.co')
  const orgs = (await api.get('/api/platform/orgs').set(auth(P))).body
  const dOrg = orgs.find((o: any) => o.name === 'Org D').id, aOrg = orgs.find((o: any) => o.name === 'Org A').id
  const dAdmin = (await api.get(`/api/platform/orgs/${dOrg}/admins`).set(auth(P))).body
  assert.deepEqual(dAdmin.map((a: any) => a.email), ['d@d.co'])
  const reqId = (await api.get('/api/users').set(auth(S.A))).body.find((u: any) => u.email === 'r@a.co').id
  assert.equal((await api.post(`/api/platform/users/${reqId}/password`).set(auth(P)).send({ password: 'Temporary-pass-2' })).status, 404)
  assert.equal((await api.get(`/api/platform/orgs/${aOrg}/admins`).set(auth(S.A))).status, 403)
  assert.equal((await api.post(`/api/platform/users/${dAdmin[0].id}/password`).set(auth(S.A)).send({ password: 'Temporary-pass-2' })).status, 403)
  assert.equal((await api.post(`/api/platform/users/${dAdmin[0].id}/password`).set(auth(P)).send({ password: 'Temporary-pass-2' })).status, 200)
  assert.equal((await api.get('/api/me').set(auth(S.D))).status, 401)
  const t = (await login('d@d.co', 'Temporary-pass-2')).body.token
  assert.equal((await api.get('/api/tickets').set(auth(t))).status, 403)
  assert.equal((await api.post('/api/auth/change-password').set(auth(t)).send({ current: 'Temporary-pass-2', password: 'owner-new-pass-5' })).status, 200)
  assert.equal((await api.post(`/api/platform/users/${dAdmin[0].id}/reset-link`).set(auth(P))).status, 200); await flush()
  assert.ok(mails.some(m => m.to.includes('d@d.co') && m.text.includes('reset?token=')))
})

test('location on tickets and a stage timeline the requester can follow', async () => {
  const c = await api.post('/api/tickets').set(auth(S.R)).send({ title: 'Printer jam', description: 'Paper stuck', category: 'Hardware', priority: 'medium', department: 'Finance', room: 'B-12' })
  assert.equal(c.status, 201); S.loc = c.body.id
  const d1 = (await api.get(`/api/tickets/${S.loc}`).set(auth(S.R))).body
  assert.equal(d1.ticket.department, 'Finance'); assert.equal(d1.ticket.room, 'B-12')
  assert.deepEqual(d1.events.map((e: any) => e.type), ['created'])
  await api.patch(`/api/tickets/${S.loc}`).set(auth(S.T)).send({ assigneeId: S.tech.id })
  await api.patch(`/api/tickets/${S.loc}`).set(auth(S.T)).send({ status: 'in_progress' })
  await api.patch(`/api/tickets/${S.loc}`).set(auth(S.T)).send({ status: 'resolved' })
  const d2 = (await api.get(`/api/tickets/${S.loc}`).set(auth(S.R))).body
  assert.deepEqual(d2.events.map((e: any) => e.type), ['created', 'assigned', 'status', 'status'])
  assert.equal(d2.events[1].detail.to, 'Tech'); assert.deepEqual(d2.events[3].detail, { from: 'in_progress', to: 'resolved' })
  assert.ok(d2.ticket.first_response_at && d2.ticket.resolved_at)
})

test('deadline misses: no action by response deadline, unresolved at resolution deadline, tracked per ICT staff', async () => {
  const mk = async (title: string) => (await api.post('/api/tickets').set(auth(S.R)).send({ title, description: 'd', category: 'Network', priority: 'high', department: 'Sales' })).body
  const idle = await mk('Nobody answers'); const stuck = await mk('Assigned but stuck')
  await api.patch(`/api/tickets/${stuck.id}`).set(auth(S.T)).send({ assigneeId: S.tech.id })
  await db.pool.query("UPDATE tickets SET response_due=now()-interval '1 hour' WHERE id=$1", [idle.id])
  await db.pool.query("UPDATE tickets SET resolve_due=now()-interval '1 hour' WHERE id=$1", [stuck.id])
  const n = await feat.slaSweep(feat.makeNotifier(mailer)); await flush()
  assert.equal(n, 2)
  assert.ok(mails.some(m => m.subject.includes('No response yet') && m.subject.includes(`TD-${idle.number}`)))
  assert.ok(mails.some(m => m.subject.includes('SLA breached') && m.subject.includes(`TD-${stuck.number}`)))
  const ev = (id: string, tok: string) => api.get(`/api/tickets/${id}`).set(auth(tok)).then(r => r.body.events.map((e: any) => e.type))
  assert.ok((await ev(idle.id, S.T)).includes('response_breach')); assert.ok(!(await ev(idle.id, S.R)).includes('response_breach'))
  assert.ok((await ev(stuck.id, S.T)).includes('sla_breach')); assert.ok(!(await ev(stuck.id, S.R)).includes('sla_breach'))
  await api.patch(`/api/tickets/${stuck.id}`).set(auth(S.T)).send({ assigneeId: null })   // reassigning must not hide who missed it
  const a = (await api.get('/api/analytics?days=30').set(auth(S.A))).body
  const tech = a.staff.find((s: any) => s.name === 'Tech')
  assert.ok(tech.missed_resolution >= 1, 'tech should be credited with the missed resolution deadline')
  assert.ok(a.unassignedMissed.response >= 1)
  assert.ok(a.overdue.some((o: any) => o.number === stuck.number))
  S.idle = idle
})

test('analytics for organisation admins: figures, charts data, insights, export, access control', async () => {
  assert.equal((await api.get('/api/analytics').set(auth(S.T))).status, 403)
  assert.equal((await api.get('/api/analytics').set(auth(S.R))).status, 403)
  const a = (await api.get('/api/analytics?days=30').set(auth(S.A))).body
  assert.ok(a.summary.created >= 6); assert.ok(a.summary.resolved >= 1); assert.ok(a.summary.open_now >= 1)
  assert.ok(a.byCategory.some((c: any) => c.label === 'Hardware')); assert.ok(a.byDepartment.some((d: any) => d.label === 'Finance' && d.n >= 1))
  assert.ok(a.byPriority.length >= 2 && a.byStatus.length >= 2)
  assert.equal(a.series.length, 30); assert.equal(a.series.reduce((s: number, x: any) => s + x.created, 0), a.summary.created)
  assert.ok(a.summary.resolution_sla_pct !== null && a.summary.response_sla_pct !== null)
  assert.ok(a.insights.length >= 2); assert.ok(a.topAssets.some((x: any) => x.tag === 'LT-001'))
  const w = (await api.get('/api/analytics?days=90').set(auth(S.A))).body; assert.equal(w.unit, 'week'); assert.ok(w.series.length >= 1)
  assert.equal((await api.get('/api/analytics?days=abc').set(auth(S.A))).body.days, 30)
  assert.equal((await api.get('/api/analytics?days=30').set(auth(S.B))).body.summary.created, 0)
  await api.post('/api/tickets').set(auth(S.R)).send({ title: '=1+1', description: 'd', category: 'Other', priority: 'low' })
  const csv = await api.get('/api/analytics/export.csv?days=30').set(auth(S.A))
  assert.equal(csv.status, 200); assert.match(csv.headers['content-type'], /text\/csv/)
  assert.ok(csv.text.startsWith('number,title,status')); assert.ok(csv.text.includes('Laptop will not boot')); assert.ok(csv.text.includes('"\'=1+1"'))
  assert.equal((await api.get('/api/analytics/export.csv').set(auth(S.R))).status, 403)
})
