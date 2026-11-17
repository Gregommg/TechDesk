import type { Express, NextFunction, Request, Response } from 'express'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { pool, tx, type Q } from './db.js'
import type { Mailer } from './mail.js'
import type { Mpesa } from './mpesa.js'
import { HttpError, me, isStaff, need, audit, sign, type U } from './app.js'

export type Deps = { mailer: Mailer; mpesa: Mpesa }
export const GRACE_DAYS = 7
const appUrl = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const password = z.string().min(10, 'Password must be at least 10 characters').max(200)
const hashTok = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

const COOKIE = 'td_session', SESSION_DAYS = 180
const cookieOf = (req: Request) => (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1)
const cookieOpts = (req: Request) => ({ httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/api/auth', maxAge: SESSION_DAYS * 864e5 })
/** Long-lived login: random token in an httpOnly cookie, only its hash is stored. Ends at logout, password change/reset, or after 180 days of no use. */
export async function startSession(req: Request, res: Response, userId: string) {
  const raw = crypto.randomBytes(32).toString('base64url')
  await pool.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+make_interval(days=>$3::int))', [userId, hashTok(raw), SESSION_DAYS])
  res.cookie(COOKIE, raw, cookieOpts(req))
}

export function subState(o: { period_end: Date | string; paid: boolean }, now = new Date()) {
  const end = new Date(o.period_end).getTime(), t = now.getTime()
  if (t <= end) return o.paid ? 'active' : 'trialing'
  return t <= end + GRACE_DAYS * 864e5 ? 'grace' : 'suspended'
}
export function normalisePhone(p: string) {
  const m = p.replace(/[\s-]/g, '').replace(/^\+/, '').match(/^(?:254|0)([17]\d{8})$/)
  if (!m) throw new HttpError(400, 'Enter a valid Kenyan phone number, e.g. 0712345678')
  return '254' + m[1]
}
export async function assertSeat(orgId: string, q: Q = pool) {
  const r = (await q.query(`SELECT p.max_agents, (SELECT count(*)::int FROM users WHERE org_id=$1 AND active AND role<>'requester') AS used
    FROM organisations o JOIN plans p ON p.code=o.plan_code WHERE o.id=$1`, [orgId])).rows[0]
  if (r.used >= r.max_agents) throw new HttpError(402, `Your plan allows ${r.max_agents} ICT agents. Upgrade your plan to add more.`)
}

export function makeNotifier(mail: Mailer) {
  const send = (to: string[], subject: string, text: string) => {
    const list = [...new Set(to)].filter(Boolean)
    if (list.length) mail(list, subject, text).catch(e => console.error('email failed:', (e as Error).message))
  }
  return {
    send,
    async staff(orgId: string, subject: string, text: string) {
      const r = await pool.query("SELECT email FROM users WHERE org_id=$1 AND active AND role<>'requester'", [orgId])
      send(r.rows.map(x => x.email), subject, text)
    },
    async user(id: string, subject: string, text: string) {
      const r = await pool.query('SELECT email FROM users WHERE id=$1 AND active', [id])
      send(r.rows.map(x => x.email), subject, text)
    },
  }
}
export type Notifier = ReturnType<typeof makeNotifier>

async function makeToken(c: Q, purpose: 'invite' | 'reset', email: string, orgId: string, role: string | null, userId: string | null, hours: number) {
  const raw = crypto.randomBytes(32).toString('base64url')
  await c.query(`INSERT INTO auth_tokens(purpose,email,org_id,role,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(hours=>$7::int))`,
    [purpose, email, orgId, role, userId, hashTok(raw), hours])
  return raw
}
const applyPlan = (c: Q, orgId: string, plan: string, months: number) =>
  c.query('UPDATE organisations SET plan_code=$2, paid=true, period_end=GREATEST(now(),period_end)+make_interval(months=>$3::int) WHERE id=$1', [orgId, plan, months])

export async function handleStkCallback(cb: any) {
  await tx(async c => {
    const p = (await c.query("SELECT * FROM payments WHERE checkout_request_id=$1 AND status='pending' FOR UPDATE", [String(cb.CheckoutRequestID)])).rows[0]
    if (!p) return
    const items = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((i: any) => [i.Name, i.Value]))
    if (cb.ResultCode !== 0 || Number(items.Amount) < p.amount) { await c.query("UPDATE payments SET status='failed' WHERE id=$1", [p.id]); return }
    await c.query("UPDATE payments SET status='paid', paid_at=now(), mpesa_receipt=$2 WHERE id=$1", [p.id, String(items.MpesaReceiptNumber ?? '')])
    await applyPlan(c, p.org_id, p.plan_code, p.months)
  })
}

export async function slaSweep(notify: Notifier) {
  let n = 0
  const late = await pool.query(`UPDATE tickets SET breached=true, breached_at=now(), breached_assignee_id=assignee_id
    WHERE breached=false AND status IN ('open','in_progress') AND resolve_due < now() RETURNING id,org_id,number,title,assignee_id`)
  for (const t of late.rows) {
    n++
    await pool.query("INSERT INTO audit_logs(org_id,action,entity,entity_id) VALUES($1,'sla.breach','ticket',$2)", [t.org_id, t.id])
    await pool.query("INSERT INTO ticket_events(ticket_id,org_id,type) VALUES($1,$2,'sla_breach')", [t.id, t.org_id])
    const msg = `Ticket TD-${t.number} (${t.title}) has passed its resolution deadline.\n${appUrl()}`
    if (t.assignee_id) await notify.user(t.assignee_id, `SLA breached: TD-${t.number}`, msg); else await notify.staff(t.org_id, `SLA breached: TD-${t.number}`, msg)
  }
  const idle = await pool.query(`UPDATE tickets SET response_breached=true, response_breach_assignee_id=assignee_id
    WHERE response_breached=false AND first_response_at IS NULL AND status='open' AND response_due < now() RETURNING id,org_id,number,title,assignee_id`)
  for (const t of idle.rows) {
    n++
    await pool.query("INSERT INTO ticket_events(ticket_id,org_id,type) VALUES($1,$2,'response_breach')", [t.id, t.org_id])
    const msg = `Ticket TD-${t.number} (${t.title}) has had no response or action before its response deadline.\n${appUrl()}`
    if (t.assignee_id) await notify.user(t.assignee_id, `No response yet: TD-${t.number}`, msg); else await notify.staff(t.org_id, `No response yet: TD-${t.number}`, msg)
  }
  await pool.query('DELETE FROM sessions WHERE expires_at < now()')
  return n
}

export function registerPublic(app: Express, _d: Deps, notify: Notifier) {
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 10000 : 20 })
  app.get('/api/plans', async (_q, res) => { res.json((await pool.query('SELECT code,name,max_agents,price_month FROM plans WHERE active ORDER BY price_month')).rows) })

  app.post('/api/auth/forgot', limiter, async (req, res) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(req.body)
    const u = (await pool.query('SELECT id,org_id FROM users WHERE email=$1 AND active', [email])).rows[0]
    if (u) {
      const t = await makeToken(pool, 'reset', email, u.org_id, null, u.id, 1)
      notify.send([email], 'Reset your TechDesk password', `Use this link within 1 hour to choose a new password:\n${appUrl()}/#/reset?token=${t}\n\nIf you did not ask for this, ignore this email.`)
    }
    res.json({ ok: true })
  })
  app.post('/api/auth/reset', limiter, async (req, res) => {
    const b = z.object({ token: z.string().min(20).max(200), password }).parse(req.body)
    const hash = await bcrypt.hash(b.password, 12)
    await tx(async c => {
      const t = (await c.query("SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='reset' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hashTok(b.token)])).rows[0]
      if (!t) throw new HttpError(400, 'This link is invalid or has expired')
      await c.query('UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=false WHERE id=$2', [hash, t.user_id])
      await c.query('DELETE FROM sessions WHERE user_id=$1', [t.user_id])
      await c.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [t.id])
    })
    res.json({ ok: true })
  })
  app.post('/api/auth/accept-invite', limiter, async (req, res) => {
    const b = z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(120), password }).parse(req.body)
    const hash = await bcrypt.hash(b.password, 12)
    const user = await tx(async c => {
      const t = (await c.query("SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose='invite' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [hashTok(b.token)])).rows[0]
      if (!t) throw new HttpError(400, 'This invitation is invalid or has expired')
      if (t.role !== 'requester') await assertSeat(t.org_id, c)
      const u = (await c.query(`INSERT INTO users(org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)
        RETURNING id,org_id,name,email,role,password_changed_at`, [t.org_id, b.name, t.email, hash, t.role])).rows[0] as U
      await c.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [t.id])
      await audit(c, u, 'user.join', 'user', u.id, { role: t.role })
      return u
    })
    await startSession(req, res, user.id)
    res.status(201).json({ token: sign(user.id, user.password_changed_at as Date), user })
  })
  app.post('/api/auth/refresh', async (req, res) => {
    const raw = cookieOf(req)
    if (!raw) throw new HttpError(401, 'Not signed in')
    const r = (await pool.query(`UPDATE sessions s SET last_used_at=now(), expires_at=now()+make_interval(days=>$2::int) FROM users u
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.id=s.user_id AND u.active RETURNING u.id,u.password_changed_at`, [hashTok(raw), SESSION_DAYS])).rows[0]
    if (!r) { res.clearCookie(COOKIE, { path: '/api/auth' }); throw new HttpError(401, 'Not signed in') }
    res.cookie(COOKIE, raw, cookieOpts(req))
    res.json({ token: sign(r.id, r.password_changed_at) })
  })
  app.post('/api/auth/logout', async (req, res) => {
    const raw = cookieOf(req)
    if (raw) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hashTok(raw)])
    res.clearCookie(COOKIE, { path: '/api/auth' })
    res.json({ ok: true })
  })
  // Daraja callbacks are unsigned: the secret in the URL plus a matching pending CheckoutRequestID and amount protect this endpoint.
  app.post('/api/mpesa/callback/:secret', async (req, res) => {
    const want = Buffer.from(process.env.MPESA_CALLBACK_SECRET ?? ''), got = Buffer.from(req.params.secret)
    if (!want.length || want.length !== got.length || !crypto.timingSafeEqual(want, got)) return void res.status(404).json({ error: 'Not found' })
    const cb = req.body?.Body?.stkCallback
    if (cb?.CheckoutRequestID) await handleStkCallback(cb)
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  })
}

export function registerFeatures(app: Express, d: Deps, notify: Notifier) {
  const platform = (_q: Request, res: Response, next: NextFunction) => me(res).is_platform ? next() : next(new HttpError(403, 'Platform administrators only'))
  const roleEnum = z.enum(['admin', 'technician', 'requester'])

  // ---- invitations (work-email onboarding) ----
  app.post('/api/invites', need('admin'), async (req, res) => {
    const u = me(res)
    const b = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: roleEnum }).parse(req.body)
    const org = (await pool.query('SELECT name,email_domain FROM organisations WHERE id=$1', [u.org_id])).rows[0]
    if (org.email_domain && !b.email.endsWith('@' + org.email_domain)) throw new HttpError(400, `Use a work email ending in @${org.email_domain}`)
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [b.email])).rowCount) throw new HttpError(409, 'That email address is already registered')
    if (b.role !== 'requester') await assertSeat(u.org_id)
    const raw = await tx(async c => {
      await c.query("DELETE FROM auth_tokens WHERE purpose='invite' AND email=$1 AND used_at IS NULL", [b.email])
      const t = await makeToken(c, 'invite', b.email, u.org_id, b.role, null, 168)
      await audit(c, u, 'invite.create', 'invite', b.email, { role: b.role })
      return t
    })
    notify.send([b.email], `${u.name} invited you to ${org.name} on TechDesk`, `You have been invited to ${org.name} as ${b.role}.\nAccept and choose your password (valid 7 days):\n${appUrl()}/#/invite?token=${raw}`)
    res.status(201).json({ ok: true })
  })
  app.get('/api/invites', need('admin'), async (_q, res) => {
    res.json((await pool.query("SELECT id,email,role,expires_at FROM auth_tokens WHERE org_id=$1 AND purpose='invite' AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC", [me(res).org_id])).rows)
  })
  app.delete('/api/invites/:id', need('admin'), async (req, res) => {
    const id = z.string().uuid().parse(req.params.id)
    await pool.query("DELETE FROM auth_tokens WHERE id=$1 AND org_id=$2 AND purpose='invite'", [id, me(res).org_id])
    res.json({ ok: true })
  })

  // ---- SLA policies ----
  app.get('/api/sla', need('admin', 'technician'), async (_q, res) => {
    res.json((await pool.query('SELECT priority,response_min,resolve_min FROM sla_policies WHERE org_id=$1 ORDER BY resolve_min', [me(res).org_id])).rows)
  })
  app.put('/api/sla', need('admin'), async (req, res) => {
    const u = me(res)
    const rows = z.array(z.object({ priority: z.enum(['low', 'medium', 'high', 'urgent']), response_min: z.number().int().min(1).max(525600), resolve_min: z.number().int().min(1).max(525600) })).min(1).max(4).parse(req.body)
    await tx(async c => {
      for (const r of rows) await c.query(`INSERT INTO sla_policies(org_id,priority,response_min,resolve_min) VALUES($1,$2,$3,$4)
        ON CONFLICT (org_id,priority) DO UPDATE SET response_min=$3, resolve_min=$4`, [u.org_id, r.priority, r.response_min, r.resolve_min])
      await audit(c, u, 'sla.update', 'sla', u.org_id, { rows })
    })
    res.json({ ok: true })
  })

  // ---- assets ----
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  const assetStatus = z.enum(['in_use', 'in_stock', 'repair', 'retired'])
  const assignee = async (orgId: string, id: string | null | undefined) => {
    if (id && !(await pool.query('SELECT 1 FROM users WHERE id=$1 AND org_id=$2 AND active', [id, orgId])).rowCount) throw new HttpError(400, 'Unknown user')
  }
  app.get('/api/assets', async (_q, res) => {
    const u = me(res)
    res.json((await pool.query(`SELECT a.id,a.tag,a.name,a.category,a.serial,a.status,a.location,a.warranty_until,a.assigned_to,x.name AS assignee
      FROM assets a LEFT JOIN users x ON x.id=a.assigned_to WHERE a.org_id=$1 AND ($2 OR a.assigned_to=$3) ORDER BY a.tag`, [u.org_id, isStaff(u), u.id])).rows)
  })
  app.post('/api/assets', need('admin', 'technician'), async (req, res) => {
    const u = me(res)
    const b = z.object({ tag: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60),
      serial: z.string().trim().max(100).optional(), status: assetStatus.optional(), assignedTo: z.string().uuid().nullable().optional(),
      location: z.string().trim().max(120).optional(), warrantyUntil: date.nullable().optional() }).parse(req.body)
    await assignee(u.org_id, b.assignedTo)
    const r = (await pool.query(`INSERT INTO assets(org_id,tag,name,category,serial,status,assigned_to,location,warranty_until)
      VALUES($1,$2,$3,$4,$5,COALESCE($6,'in_use'),$7,$8,$9) RETURNING id,tag,name,status`,
      [u.org_id, b.tag, b.name, b.category, b.serial ?? null, b.status ?? null, b.assignedTo ?? null, b.location ?? null, b.warrantyUntil ?? null])).rows[0]
    await audit(pool, u, 'asset.create', 'asset', r.id, { tag: b.tag })
    res.status(201).json(r)
  })
  app.patch('/api/assets/:id', need('admin', 'technician'), async (req, res) => {
    const u = me(res), id = z.string().uuid().parse(req.params.id)
    const b = z.object({ status: assetStatus.optional(), location: z.string().trim().max(120).optional(), assignedTo: z.string().uuid().nullable().optional(), warrantyUntil: date.nullable().optional() }).parse(req.body)
    await assignee(u.org_id, b.assignedTo)
    const r = await pool.query(`UPDATE assets SET status=COALESCE($1,status), location=COALESCE($2,location),
      assigned_to=CASE WHEN $3 THEN $4::uuid ELSE assigned_to END, warranty_until=CASE WHEN $5 THEN $6::date ELSE warranty_until END
      WHERE id=$7 AND org_id=$8 RETURNING id`, [b.status ?? null, b.location ?? null, 'assignedTo' in b, b.assignedTo ?? null, 'warrantyUntil' in b, b.warrantyUntil ?? null, id, u.org_id])
    if (!r.rowCount) throw new HttpError(404, 'Asset not found')
    await audit(pool, u, 'asset.update', 'asset', id, b)
    res.json({ ok: true })
  })

  // ---- knowledge base ----
  app.get('/api/kb', async (req, res) => {
    const u = me(res)
    const q = z.string().max(100).optional().parse(req.query.q)
    const like = q ? '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%' : null
    res.json((await pool.query(`SELECT id,title,body,category,published,updated_at FROM kb_articles WHERE org_id=$1 AND ($2 OR published)
      AND ($3::text IS NULL OR title ILIKE $3 OR body ILIKE $3) ORDER BY updated_at DESC LIMIT 100`, [u.org_id, isStaff(u), like])).rows)
  })
  app.post('/api/kb', need('admin', 'technician'), async (req, res) => {
    const u = me(res)
    const b = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), category: z.string().trim().min(1).max(60).default('General'), published: z.boolean().default(false) }).parse(req.body)
    const r = (await pool.query('INSERT INTO kb_articles(org_id,title,body,category,published,author_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [u.org_id, b.title, b.body, b.category, b.published, u.id])).rows[0]
    await audit(pool, u, 'kb.create', 'article', r.id)
    res.status(201).json(r)
  })
  app.patch('/api/kb/:id', need('admin', 'technician'), async (req, res) => {
    const u = me(res), id = z.string().uuid().parse(req.params.id)
    const b = z.object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(20000).optional(), category: z.string().trim().min(1).max(60).optional(), published: z.boolean().optional() }).parse(req.body)
    const r = await pool.query(`UPDATE kb_articles SET title=COALESCE($1,title), body=COALESCE($2,body), category=COALESCE($3,category),
      published=COALESCE($4,published), updated_at=now() WHERE id=$5 AND org_id=$6 RETURNING id`, [b.title ?? null, b.body ?? null, b.category ?? null, b.published ?? null, id, u.org_id])
    if (!r.rowCount) throw new HttpError(404, 'Article not found')
    await audit(pool, u, 'kb.update', 'article', id, { published: b.published })
    res.json({ ok: true })
  })

  // ---- billing (organisation admin) ----
  app.get('/api/billing', need('admin'), async (_q, res) => {
    const u = me(res)
    const o = (await pool.query(`SELECT o.plan_code,o.period_end,o.paid,p.name AS plan_name,p.max_agents,p.price_month,
      (SELECT count(*)::int FROM users WHERE org_id=o.id AND active AND role<>'requester') AS agents FROM organisations o JOIN plans p ON p.code=o.plan_code WHERE o.id=$1`, [u.org_id])).rows[0]
    const payments = (await pool.query('SELECT id,plan_code,months,amount,method,status,mpesa_receipt,created_at FROM payments WHERE org_id=$1 ORDER BY created_at DESC LIMIT 10', [u.org_id])).rows
    const plans = (await pool.query('SELECT code,name,max_agents,price_month FROM plans WHERE active ORDER BY price_month')).rows
    res.json({ ...o, state: subState(o), payments, plans })
  })
  app.post('/api/billing/checkout', need('admin'), async (req, res) => {
    const u = me(res)
    const b = z.object({ planCode: z.string().min(1).max(30), months: z.union([z.literal(1), z.literal(12)]), phone: z.string().max(20) }).parse(req.body)
    const phone = normalisePhone(b.phone)
    const plan = (await pool.query('SELECT * FROM plans WHERE code=$1 AND active', [b.planCode])).rows[0]
    if (!plan) throw new HttpError(400, 'Unknown plan')
    const used = (await pool.query("SELECT count(*)::int AS n FROM users WHERE org_id=$1 AND active AND role<>'requester'", [u.org_id])).rows[0].n
    if (used > plan.max_agents) throw new HttpError(400, `You have ${used} active ICT agents but ${plan.name} allows ${plan.max_agents}. Disable agents or choose a larger plan.`)
    const amount = plan.price_month * b.months
    const p = (await pool.query("INSERT INTO payments(org_id,plan_code,months,amount,method,phone) VALUES($1,$2,$3,$4,'mpesa',$5) RETURNING id", [u.org_id, plan.code, b.months, amount, phone])).rows[0]
    try {
      const r = await d.mpesa.stkPush({ phone, amount, ref: 'TD' + p.id.slice(0, 8) })
      await pool.query('UPDATE payments SET checkout_request_id=$1 WHERE id=$2', [r.checkoutRequestId, p.id])
    } catch (e) {
      console.error('M-Pesa STK push failed:', (e as Error).message)
      await pool.query("UPDATE payments SET status='failed' WHERE id=$1", [p.id])
      throw new HttpError(502, 'Could not start the M-Pesa payment prompt. Try again or contact support.')
    }
    await audit(pool, u, 'billing.checkout', 'payment', p.id, { plan: plan.code, months: b.months, amount })
    res.status(201).json({ paymentId: p.id, amount })
  })
  app.get('/api/billing/payments/:id', need('admin'), async (req, res) => {
    const id = z.string().uuid().parse(req.params.id)
    const r = (await pool.query('SELECT id,status,amount,mpesa_receipt FROM payments WHERE id=$1 AND org_id=$2', [id, me(res).org_id])).rows[0]
    if (!r) throw new HttpError(404, 'Payment not found')
    res.json(r)
  })

  // ---- password management ----
  app.post('/api/auth/change-password', async (req, res) => {
    const u = me(res)
    const b = z.object({ current: z.string().max(200), password }).parse(req.body)
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0]
    if (!(await bcrypt.compare(b.current, row.password_hash))) throw new HttpError(400, 'Your current password is incorrect')
    if (b.current === b.password) throw new HttpError(400, 'Choose a password different from the current one')
    const n = (await pool.query('UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=false WHERE id=$2 RETURNING password_changed_at', [await bcrypt.hash(b.password, 12), u.id])).rows[0]
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id])
    await startSession(req, res, u.id)
    await audit(pool, u, 'user.password_change', 'user', u.id)
    res.json({ token: sign(u.id, n.password_changed_at) })
  })
  // Target must be in the caller's organisation (org admin) or be an organisation admin (platform admin).
  const target = async (actor: U, id: string, platformMode: boolean) => {
    const t = (platformMode
      ? await pool.query("SELECT id,org_id,name,email FROM users WHERE id=$1 AND role='admin' AND NOT is_platform", [id])
      : await pool.query('SELECT id,org_id,name,email FROM users WHERE id=$1 AND org_id=$2 AND NOT is_platform', [id, actor.org_id])).rows[0]
    if (!t) throw new HttpError(404, 'User not found')
    if (t.id === actor.id) throw new HttpError(400, 'Use Change password for your own account')
    return t as { id: string; org_id: string; name: string; email: string }
  }
  const tempPassword = async (actor: U, id: string, platformMode: boolean, pw: string) => {
    const t = await target(actor, id, platformMode)
    await pool.query('UPDATE users SET password_hash=$1, password_changed_at=now(), must_change_password=true WHERE id=$2', [await bcrypt.hash(pw, 12), id])
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [id])
    await audit(pool, actor, 'user.temp_password', 'user', id, { by: platformMode ? 'platform' : 'org_admin' })
    notify.send([t.email], 'Your TechDesk password was reset', 'An administrator set a temporary password for your account. Sign in with it and you will be asked to choose a new password. If you did not expect this, contact your administrator.')
  }
  const resetLink = async (actor: U, id: string, platformMode: boolean) => {
    const t = await target(actor, id, platformMode)
    const raw = await makeToken(pool, 'reset', t.email, t.org_id, null, t.id, 1)
    await audit(pool, actor, 'user.reset_link', 'user', id, { by: platformMode ? 'platform' : 'org_admin' })
    notify.send([t.email], 'Reset your TechDesk password', `An administrator sent you a password reset link (valid 1 hour):\n${appUrl()}/#/reset?token=${raw}`)
  }
  const pwBody = z.object({ password })
  app.post('/api/users/:id/password', need('admin'), async (req, res) => { await tempPassword(me(res), z.string().uuid().parse(req.params.id), false, pwBody.parse(req.body).password); res.json({ ok: true }) })
  app.post('/api/users/:id/reset-link', need('admin'), async (req, res) => { await resetLink(me(res), z.string().uuid().parse(req.params.id), false); res.json({ ok: true }) })
  app.get('/api/platform/orgs/:id/admins', platform, async (req, res) => {
    res.json((await pool.query("SELECT id,name,email,active FROM users WHERE org_id=$1 AND role='admin' AND NOT is_platform ORDER BY name", [z.string().uuid().parse(req.params.id)])).rows)
  })
  app.post('/api/platform/users/:id/password', platform, async (req, res) => { await tempPassword(me(res), z.string().uuid().parse(req.params.id), true, pwBody.parse(req.body).password); res.json({ ok: true }) })
  app.post('/api/platform/users/:id/reset-link', platform, async (req, res) => { await resetLink(me(res), z.string().uuid().parse(req.params.id), true); res.json({ ok: true }) })

  // ---- platform administration (Orbitra staff only) ----
  app.get('/api/platform/orgs', platform, async (_q, res) => {
    const rows = (await pool.query(`SELECT o.id,o.name,o.email_domain,o.plan_code,o.period_end,o.paid,o.created_at,
      (SELECT count(*)::int FROM users WHERE org_id=o.id AND active AND role<>'requester') AS agents,
      (SELECT count(*)::int FROM users WHERE org_id=o.id) AS users FROM organisations o ORDER BY o.created_at DESC LIMIT 500`)).rows
    res.json(rows.map(r => ({ ...r, state: subState(r) })))
  })
  app.post('/api/platform/orgs/:id/payments', platform, async (req, res) => {
    const u = me(res), id = z.string().uuid().parse(req.params.id)
    const b = z.object({ planCode: z.string().min(1).max(30), months: z.number().int().min(1).max(36), amount: z.number().int().min(1), reference: z.string().trim().min(1).max(100) }).parse(req.body)
    await tx(async c => {
      if (!(await c.query('SELECT 1 FROM organisations WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'Organisation not found')
      if (!(await c.query('SELECT 1 FROM plans WHERE code=$1', [b.planCode])).rowCount) throw new HttpError(400, 'Unknown plan')
      const p = (await c.query("INSERT INTO payments(org_id,plan_code,months,amount,method,status,reference,paid_at) VALUES($1,$2,$3,$4,'manual','paid',$5,now()) RETURNING id", [id, b.planCode, b.months, b.amount, b.reference])).rows[0]
      await applyPlan(c, id, b.planCode, b.months)
      await audit(c, u, 'billing.manual_payment', 'payment', p.id, { org: id, ...b })
    })
    res.status(201).json({ ok: true })
  })
  app.patch('/api/platform/plans/:code', platform, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), max_agents: z.number().int().min(1).optional(), price_month: z.number().int().min(1).optional(), active: z.boolean().optional() }).parse(req.body)
    const r = await pool.query('UPDATE plans SET name=COALESCE($1,name), max_agents=COALESCE($2,max_agents), price_month=COALESCE($3,price_month), active=COALESCE($4,active) WHERE code=$5 RETURNING code',
      [b.name ?? null, b.max_agents ?? null, b.price_month ?? null, b.active ?? null, String(req.params.code)])
    if (!r.rowCount) throw new HttpError(404, 'Plan not found')
    await audit(pool, me(res), 'plan.update', 'plan', String(req.params.code), b)
    res.json({ ok: true })
  })
}
