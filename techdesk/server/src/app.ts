import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import { z } from 'zod'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { pool, tx, type Q } from './db.js'
import { smtpMailer } from './mail.js'
import { daraja } from './mpesa.js'
import { makeNotifier, registerPublic, registerFeatures, assertSeat, subState, startSession, type Deps } from './features.js'
import { registerAnalytics } from './analytics.js'

export type Role = 'admin' | 'technician' | 'requester'
export type U = { id: string; org_id: string; role: Role; name: string; email: string; is_platform?: boolean; password_changed_at?: Date; must_change_password?: boolean }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
export const me = (res: Response) => res.locals.user as U
export const isStaff = (u: U) => u.role !== 'requester'
const secret = () => {
  const s = process.env.JWT_SECRET
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set to 32+ characters')
  return s
}
export const sign = (id: string, pv: Date) => jwt.sign({ uid: id, pv: pv.getTime() }, secret(), { expiresIn: '15m' })
export const audit = (q: Q, u: U, action: string, entity: string, id: string, detail: object = {}) =>
  q.query('INSERT INTO audit_logs(org_id,actor_id,action,entity,entity_id,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [u.org_id, u.id, action, entity, id, JSON.stringify(detail)])

const email = z.string().trim().toLowerCase().email().max(200)
const password = z.string().min(10, 'Password must be at least 10 characters').max(200)
const name = z.string().trim().min(1).max(120)
const priority = z.enum(['low', 'medium', 'high', 'urgent'])
const status = z.enum(['open', 'in_progress', 'resolved', 'closed'])
const ALLOWED = new Set(['image/png', 'image/jpeg', 'application/pdf', 'text/plain'])
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com'])
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12)

const TICKET_SQL = `SELECT t.id,t.number,t.title,t.description,t.category,t.department,t.room,t.response_breached,t.priority,t.status,t.assignee_id,t.created_at,t.updated_at,
  t.response_due,t.resolve_due,t.first_response_at,t.resolved_at,t.breached,t.asset_id,s.tag AS asset_tag,s.name AS asset_name,r.name AS requester,a.name AS assignee
  FROM tickets t JOIN users r ON r.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id LEFT JOIN assets s ON s.id=t.asset_id`

async function auth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token) throw new HttpError(401, 'Sign in required')
  let p: { uid: string; pv: number }
  try { p = jwt.verify(token, secret()) as { uid: string; pv: number } } catch { throw new HttpError(401, 'Session expired, sign in again') }
  const { rows } = await pool.query(`SELECT u.id,u.org_id,u.role,u.name,u.email,u.is_platform,u.password_changed_at,u.must_change_password,o.period_end,o.paid,o.plan_code
    FROM users u JOIN organisations o ON o.id=u.org_id WHERE u.id=$1 AND u.active`, [p.uid])
  const r = rows[0]
  if (!r || p.pv !== new Date(r.password_changed_at).getTime()) throw new HttpError(401, 'Session expired, sign in again')
  const state = subState(r)
  res.locals.user = { id: r.id, org_id: r.org_id, role: r.role, name: r.name, email: r.email, is_platform: r.is_platform, must_change_password: r.must_change_password }
  res.locals.sub = { state, plan: r.plan_code, periodEnd: r.period_end }
  if (r.must_change_password && !['/me', '/auth/change-password'].includes(req.path)) throw new HttpError(403, 'Please choose a new password first')
  if (state === 'suspended' && !r.is_platform && req.method !== 'GET' && !req.path.startsWith('/billing'))
    throw new HttpError(402, 'Your subscription has expired. An administrator can renew it under Billing.')
  next()
}
export const need = (...roles: Role[]) => (_q: Request, res: Response, next: NextFunction) =>
  roles.includes(me(res).role) ? next() : next(new HttpError(403, 'You do not have permission for this action'))

// Loads the ticket only if it belongs to the caller's organisation (and, for requesters, to them).
async function loadTicket(req: Request, res: Response, next: NextFunction) {
  const id = z.string().uuid().safeParse(req.params.id)
  if (!id.success) throw new HttpError(404, 'Ticket not found')
  const u = me(res)
  const { rows } = await pool.query('SELECT * FROM tickets WHERE id=$1 AND org_id=$2 AND ($3 OR requester_id=$4)',
    [id.data, u.org_id, isStaff(u), u.id])
  if (!rows[0]) throw new HttpError(404, 'Ticket not found')
  res.locals.ticket = rows[0]
  next()
}

export function createApp(deps: Partial<Deps> = {}) {
  secret()
  const d: Deps = { mailer: deps.mailer ?? smtpMailer(), mpesa: deps.mpesa ?? daraja() }
  const notify = makeNotifier(d.mailer)
  const app = express()
  app.set('trust proxy', 1)
  app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'img-src': ["'self'", 'data:', 'blob:'] } } }))
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? false }))
  app.use(express.json({ limit: '100kb' }))
  const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? 'uploads')
  fs.mkdirSync(uploadDir, { recursive: true })
  const upload = multer({
    storage: multer.diskStorage({ destination: uploadDir, filename: (_r, _f, cb) => cb(null, crypto.randomUUID()) }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_r, f, cb) => ALLOWED.has(f.mimetype) ? cb(null, true)
      : cb(new HttpError(400, 'Only PNG, JPEG, PDF or text files up to 5 MB are allowed')),
  })
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 10000 : 30 })

  app.get('/api/health', (_q, res) => { res.json({ ok: true }) })

  app.post('/api/auth/register', authLimiter, async (req, res) => {
    if (process.env.ALLOW_REGISTRATION === 'false') throw new HttpError(403, 'Registration is disabled')
    const b = z.object({ orgName: name, name, email, password, planCode: z.string().max(30).default('starter') }).parse(req.body)
    const domain = b.email.split('@')[1]
    if (FREE_MAIL.has(domain) && process.env.ALLOW_FREE_EMAIL !== 'true') throw new HttpError(400, 'Please register with your organisation work email address (not a personal Gmail/Yahoo address)')
    if (!(await pool.query('SELECT 1 FROM plans WHERE code=$1 AND active', [b.planCode])).rowCount) throw new HttpError(400, 'Unknown plan')
    const hash = await bcrypt.hash(b.password, 12)
    const user = await tx(async c => {
      const o = await c.query('INSERT INTO organisations(name,plan_code,email_domain) VALUES($1,$2,$3) RETURNING id', [b.orgName, b.planCode, FREE_MAIL.has(domain) ? null : domain])
      await c.query(`INSERT INTO sla_policies(org_id,priority,response_min,resolve_min) VALUES ($1,'urgent',30,240),($1,'high',60,480),($1,'medium',240,1440),($1,'low',480,4320)`, [o.rows[0].id])
      const u = (await c.query(`INSERT INTO users(org_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,'admin')
        RETURNING id,org_id,name,email,role,password_changed_at`, [o.rows[0].id, b.name, b.email, hash])).rows[0] as U
      await audit(c, u, 'org.register', 'organisation', u.org_id)
      return u
    })
    await startSession(req, res, user.id)
    res.status(201).json({ token: sign(user.id, user.password_changed_at as Date), user })
  })

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const b = z.object({ email, password: z.string().max(200) }).parse(req.body)
    const { rows } = await pool.query('SELECT id,org_id,name,email,role,password_hash,password_changed_at FROM users WHERE email=$1 AND active', [b.email])
    const ok = await bcrypt.compare(b.password, rows[0]?.password_hash ?? DUMMY_HASH)
    if (!rows[0] || !ok) throw new HttpError(401, 'Incorrect email or password')
    const { password_hash: _ph, ...user } = rows[0]
    await startSession(req, res, user.id)
    res.json({ token: sign(user.id, user.password_changed_at as Date), user })
  })

  registerPublic(app, d, notify)
  app.use('/api', auth)
  app.get('/api/me', (_q, res) => { const u = me(res); res.json({ id: u.id, name: u.name, email: u.email, role: u.role, is_platform: u.is_platform, must_change_password: u.must_change_password, sub: res.locals.sub }) })

  app.get('/api/users', need('admin', 'technician'), async (_q, res) => {
    const { rows } = await pool.query('SELECT id,name,email,role,active FROM users WHERE org_id=$1 ORDER BY name', [me(res).org_id])
    res.json(rows)
  })
  app.patch('/api/users/:id', need('admin'), async (req, res) => {
    const u = me(res)
    const id = z.string().uuid().parse(req.params.id)
    const b = z.object({ active: z.boolean().optional(), role: z.enum(['admin', 'technician', 'requester']).optional() }).parse(req.body)
    if (id === u.id) throw new HttpError(400, 'You cannot change your own role or status')
    const cur = (await pool.query('SELECT active,role FROM users WHERE id=$1 AND org_id=$2', [id, u.org_id])).rows[0]
    if (!cur) throw new HttpError(404, 'User not found')
    if ((b.active ?? cur.active) && (b.role ?? cur.role) !== 'requester' && !(cur.active && cur.role !== 'requester')) await assertSeat(u.org_id)
    const { rows } = await pool.query(`UPDATE users SET active=COALESCE($1,active), role=COALESCE($2,role)
      WHERE id=$3 AND org_id=$4 RETURNING id,name,email,role,active`, [b.active ?? null, b.role ?? null, id, u.org_id])
    if (!rows[0]) throw new HttpError(404, 'User not found')
    await audit(pool, u, 'user.update', 'user', id, b)
    res.json(rows[0])
  })

  app.get('/api/dashboard', need('admin', 'technician'), async (_q, res) => {
    const u = me(res)
    const by = await pool.query('SELECT status, count(*)::int AS n FROM tickets WHERE org_id=$1 GROUP BY status', [u.org_id])
    const x = await pool.query(`SELECT count(*) FILTER (WHERE assignee_id IS NULL AND status IN ('open','in_progress'))::int AS unassigned,
      count(*) FILTER (WHERE assignee_id=$2 AND status IN ('open','in_progress'))::int AS mine FROM tickets WHERE org_id=$1`, [u.org_id, u.id])
    res.json({ byStatus: Object.fromEntries(by.rows.map(r => [r.status, r.n])), ...x.rows[0] })
  })

  app.get('/api/tickets', async (req, res) => {
    const u = me(res)
    const st = status.optional().parse(req.query.status)
    const { rows } = await pool.query(`${TICKET_SQL} WHERE t.org_id=$1 AND ($2 OR t.requester_id=$3)
      AND ($4::text IS NULL OR t.status=$4) ORDER BY t.created_at DESC LIMIT 200`, [u.org_id, isStaff(u), u.id, st ?? null])
    res.json(rows)
  })
  app.post('/api/tickets', async (req, res) => {
    const u = me(res)
    const b = z.object({ title: name.max(200), description: z.string().trim().min(1).max(5000),
      category: z.string().trim().min(1).max(60), priority, assetId: z.string().uuid().optional(), department: z.string().trim().max(100).optional(), room: z.string().trim().max(60).optional() }).parse(req.body)
    if (b.assetId && !(await pool.query('SELECT 1 FROM assets WHERE id=$1 AND org_id=$2 AND ($3 OR assigned_to=$4)', [b.assetId, u.org_id, isStaff(u), u.id])).rowCount) throw new HttpError(400, 'Unknown asset')
    const t = await tx(async c => {
      const n = (await c.query('UPDATE organisations SET ticket_seq=ticket_seq+1 WHERE id=$1 RETURNING ticket_seq', [u.org_id])).rows[0].ticket_seq
      const r = (await c.query(`INSERT INTO tickets(org_id,number,title,description,category,priority,requester_id,asset_id,department,room,response_due,resolve_due)
        SELECT $1::uuid,$2::int,$3::text,$4::text,$5::text,$6::text,$7::uuid,$8::uuid,$9::text,$10::text, now()+make_interval(mins=>p.response_min), now()+make_interval(mins=>p.resolve_min)
        FROM (SELECT 1) x LEFT JOIN sla_policies p ON p.org_id=$1::uuid AND p.priority=$6::text
        RETURNING id,number,title,status,priority,response_due,resolve_due`, [u.org_id, n, b.title, b.description, b.category, b.priority, u.id, b.assetId ?? null, b.department || null, b.room || null])).rows[0]
      await c.query("INSERT INTO ticket_events(ticket_id,org_id,actor_id,type) VALUES($1,$2,$3,'created')", [r.id, u.org_id, u.id])
      await audit(c, u, 'ticket.create', 'ticket', r.id, { number: n })
      return r
    })
    void notify.staff(u.org_id, `New ticket TD-${t.number}: ${t.title}`, `${u.name} opened a ${b.priority} priority ticket (${b.category}).\n\n${b.description.slice(0, 500)}\n\n${process.env.APP_URL ?? ''}`)
    res.status(201).json(t)
  })
  app.get('/api/tickets/:id', loadTicket, async (_q, res) => {
    const u = me(res), id = res.locals.ticket.id
    const t = (await pool.query(`${TICKET_SQL} WHERE t.id=$1`, [id])).rows[0]
    const messages = (await pool.query(`SELECT m.id,m.body,m.internal,m.created_at,a.name AS author,a.role FROM messages m
      JOIN users a ON a.id=m.author_id WHERE m.ticket_id=$1 AND ($2 OR NOT m.internal) ORDER BY m.created_at`, [id, isStaff(u)])).rows
    const attachments = (await pool.query('SELECT id,filename,size,created_at FROM attachments WHERE ticket_id=$1 ORDER BY created_at', [id])).rows
    const events = (await pool.query(`SELECT e.type,e.detail,e.created_at,a.name AS actor FROM ticket_events e LEFT JOIN users a ON a.id=e.actor_id
      WHERE e.ticket_id=$1 AND ($2 OR e.type NOT IN ('sla_breach','response_breach')) ORDER BY e.id`, [id, isStaff(u)])).rows
    res.json({ ticket: t, messages, attachments, events })
  })
  app.patch('/api/tickets/:id', need('admin', 'technician'), loadTicket, async (req, res) => {
    const u = me(res), id = res.locals.ticket.id
    const b = z.object({ status: status.optional(), priority: priority.optional(), assigneeId: z.string().uuid().nullable().optional() }).parse(req.body)
    if (b.assigneeId) {
      const ok = await pool.query("SELECT 1 FROM users WHERE id=$1 AND org_id=$2 AND active AND role<>'requester'", [b.assigneeId, u.org_id])
      if (!ok.rowCount) throw new HttpError(400, 'Assignee must be an active technician or admin in your organisation')
    }
    await pool.query(`UPDATE tickets SET status=COALESCE($1,status), priority=COALESCE($2,priority),
      assignee_id=CASE WHEN $3 THEN $4::uuid ELSE assignee_id END, updated_at=now(),
      first_response_at=CASE WHEN first_response_at IS NULL AND $1::text IS NOT NULL AND $1::text<>status THEN now() ELSE first_response_at END,
      resolved_at=CASE WHEN COALESCE($1,status) IN ('resolved','closed') THEN COALESCE(resolved_at,now()) ELSE NULL END WHERE id=$5 AND org_id=$6`,
      [b.status ?? null, b.priority ?? null, 'assigneeId' in b, b.assigneeId ?? null, id, u.org_id])
    await audit(pool, u, 'ticket.update', 'ticket', id, b)
    const tk = res.locals.ticket
    const ev = (type: string, detail: object) => pool.query('INSERT INTO ticket_events(ticket_id,org_id,actor_id,type,detail) VALUES($1,$2,$3,$4,$5)', [id, u.org_id, u.id, type, JSON.stringify(detail)])
    if (b.status && b.status !== tk.status) await ev('status', { from: tk.status, to: b.status })
    if ('assigneeId' in b && (b.assigneeId ?? null) !== tk.assignee_id) {
      const nm = b.assigneeId ? (await pool.query('SELECT name FROM users WHERE id=$1', [b.assigneeId])).rows[0]?.name : null
      await ev('assigned', { to: nm })
    }
    if (b.assigneeId && b.assigneeId !== tk.assignee_id) void notify.user(b.assigneeId, `Ticket TD-${tk.number} was assigned to you`, `${tk.title}\n\n${process.env.APP_URL ?? ''}`)
    if (b.status && b.status !== tk.status) void notify.user(tk.requester_id, `Your ticket TD-${tk.number} is now ${b.status.replace('_', ' ')}`, `${tk.title}\n\n${process.env.APP_URL ?? ''}`)
    res.json({ ok: true })
  })
  app.post('/api/tickets/:id/messages', loadTicket, async (req, res) => {
    const u = me(res), id = res.locals.ticket.id
    const b = z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().optional() }).parse(req.body)
    const internal = isStaff(u) && !!b.internal
    const { rows } = await pool.query('INSERT INTO messages(ticket_id,org_id,author_id,body,internal) VALUES($1,$2,$3,$4,$5) RETURNING id', [id, u.org_id, u.id, b.body, internal])
    await pool.query('UPDATE tickets SET updated_at=now() WHERE id=$1', [id])
    const tk = res.locals.ticket
    if (!internal) {
      const note = `TD-${tk.number}: ${tk.title}\n\n${u.name} wrote:\n${b.body.slice(0, 1000)}\n\n${process.env.APP_URL ?? ''}`
      if (isStaff(u)) {
        await pool.query('UPDATE tickets SET first_response_at=COALESCE(first_response_at,now()) WHERE id=$1', [id])
        void notify.user(tk.requester_id, `Update on your ticket TD-${tk.number}`, note)
      } else if (tk.assignee_id) void notify.user(tk.assignee_id, `New reply on TD-${tk.number}`, note)
      else void notify.staff(u.org_id, `New reply on TD-${tk.number}`, note)
    }
    await audit(pool, u, internal ? 'ticket.note' : 'ticket.reply', 'ticket', id)
    res.status(201).json(rows[0])
  })
  app.post('/api/tickets/:id/attachments', loadTicket, upload.single('file'), async (req, res) => {
    const u = me(res), f = req.file
    if (!f) throw new HttpError(400, 'Choose a file to upload')
    const { rows } = await pool.query(`INSERT INTO attachments(ticket_id,org_id,uploader_id,filename,mime,size,stored_name)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,filename,size`, [res.locals.ticket.id, u.org_id, u.id, path.basename(f.originalname).slice(0, 200), f.mimetype, f.size, f.filename])
    await audit(pool, u, 'ticket.attach', 'ticket', res.locals.ticket.id, { filename: rows[0].filename })
    res.status(201).json(rows[0])
  })
  app.get('/api/attachments/:id', async (req, res) => {
    const u = me(res)
    const id = z.string().uuid().safeParse(req.params.id)
    const { rows } = id.success ? await pool.query(`SELECT a.* FROM attachments a JOIN tickets t ON t.id=a.ticket_id
      WHERE a.id=$1 AND a.org_id=$2 AND ($3 OR t.requester_id=$4)`, [id.data, u.org_id, isStaff(u), u.id]) : { rows: [] }
    if (!rows[0]) throw new HttpError(404, 'Attachment not found')
    res.download(path.join(uploadDir, rows[0].stored_name), rows[0].filename)
  })
  app.get('/api/audit', need('admin'), async (_q, res) => {
    const { rows } = await pool.query(`SELECT l.id,l.action,l.entity,l.entity_id,l.detail,l.created_at,u.name AS actor
      FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE l.org_id=$1 ORDER BY l.id DESC LIMIT 100`, [me(res).org_id])
    res.json(rows)
  })
  registerFeatures(app, d, notify)
  registerAnalytics(app)
  app.use('/api', (_q, _s, next) => next(new HttpError(404, 'Not found')))

  const dist = path.resolve(process.env.WEB_DIST ?? '../web/dist')
  if (fs.existsSync(dist)) {
    app.use(express.static(dist))
    app.use((req, res, next) => req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next())
  }

  app.use((err: any, _q: Request, res: Response, _n: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`) })
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Upload failed: ' + err.message })
    if (err?.code === '23505') return res.status(409).json({ error: 'That record already exists (email already in use?)' })
    console.error(err)
    res.status(500).json({ error: 'Something went wrong on our side' })
  })
  return app
}
