import type { Express } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { me, need } from './app.js'

const num = (x: unknown) => (x === null || x === undefined ? null : Math.round(Number(x)))
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null)
const localDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })
const days = (q: unknown) => z.coerce.number().int().min(1).max(365).catch(30).parse(q)

function series(n: number, created: any[], resolved: any[]) {
  const weekly = n > 31
  const c = Object.fromEntries(created.map(r => [r.b, r.n])), s = Object.fromEntries(resolved.map(r => [r.b, r.n]))
  const keys = [...new Set([...Object.keys(c), ...Object.keys(s)])].sort()
  if (weekly && !keys.length) return []
  const start = weekly ? keys[0] : localDay(new Date(Date.now() - (n - 1) * 864e5)), end = weekly ? keys[keys.length - 1] : localDay(new Date())
  const out: { date: string; created: number; resolved: number }[] = []
  for (let t = Date.parse(start); t <= Date.parse(end); t += (weekly ? 7 : 1) * 864e5) {
    const k = new Date(t).toISOString().slice(0, 10)
    out.push({ date: k, created: c[k] ?? 0, resolved: s[k] ?? 0 })
  }
  return out
}
const MISSED_RESOLUTION = `((t.resolved_at IS NULL AND t.resolve_due < now()) OR t.resolved_at > t.resolve_due)`
const MISSED_RESPONSE = `((t.first_response_at IS NULL AND t.response_due < now()) OR t.first_response_at > t.response_due)`

export function registerAnalytics(app: Express) {
  app.get('/api/analytics', need('admin'), async (req, res) => {
    const org = me(res).org_id, n = days(req.query.days), since = new Date(Date.now() - n * 864e5)
    const unit = n > 31 ? 'week' : 'day'
    const grp = (col: string) => pool.query(`SELECT ${col} AS label, count(*)::int AS n FROM tickets WHERE org_id=$1 AND created_at>=$2 GROUP BY 1 ORDER BY n DESC`, [org, since])
    const bucket = (col: string) => `to_char(date_trunc($3::text, ${col} AT TIME ZONE 'Africa/Nairobi'),'YYYY-MM-DD')`
    const [sum, resolvedN, open, created, resolved, cat, pri, st, dep, assets, staff, unassigned, overdue] = await Promise.all([
      pool.query(`SELECT count(*)::int AS created,
        avg(extract(epoch FROM first_response_at - created_at)/60) AS avg_first_response_min,
        avg(extract(epoch FROM resolved_at - created_at)/60) AS avg_resolution_min,
        count(*) FILTER (WHERE resolved_at IS NOT NULL OR resolve_due < now())::int AS res_n,
        count(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_at <= resolve_due)::int AS res_met,
        count(*) FILTER (WHERE first_response_at IS NOT NULL OR response_due < now())::int AS resp_n,
        count(*) FILTER (WHERE first_response_at IS NOT NULL AND first_response_at <= response_due)::int AS resp_met
        FROM tickets WHERE org_id=$1 AND created_at>=$2`, [org, since]),
      pool.query('SELECT count(*)::int AS n FROM tickets WHERE org_id=$1 AND resolved_at>=$2', [org, since]),
      pool.query(`SELECT count(*)::int AS open, count(*) FILTER (WHERE assignee_id IS NULL)::int AS unassigned FROM tickets WHERE org_id=$1 AND status IN ('open','in_progress')`, [org]),
      pool.query(`SELECT ${bucket('created_at')} AS b, count(*)::int AS n FROM tickets WHERE org_id=$1 AND created_at>=$2 GROUP BY 1`, [org, since, unit]),
      pool.query(`SELECT ${bucket('resolved_at')} AS b, count(*)::int AS n FROM tickets WHERE org_id=$1 AND resolved_at>=$2 GROUP BY 1`, [org, since, unit]),
      grp('category'), grp('priority'), grp('status'),
      pool.query(`SELECT min(department) AS label, count(*)::int AS n FROM tickets WHERE org_id=$1 AND created_at>=$2 AND department IS NOT NULL AND department<>''
        GROUP BY lower(department) ORDER BY n DESC LIMIT 8`, [org, since]),
      pool.query(`SELECT s.tag, s.name, count(*)::int AS n FROM tickets t JOIN assets s ON s.id=t.asset_id WHERE t.org_id=$1 AND t.created_at>=$2 GROUP BY s.id ORDER BY n DESC LIMIT 5`, [org, since]),
      pool.query(`SELECT u.id,u.name,u.role,
        (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.assignee_id=u.id AND t.created_at>=$2) AS assigned,
        (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.assignee_id=u.id AND t.resolved_at>=$2) AS resolved,
        (SELECT avg(extract(epoch FROM t.resolved_at-t.created_at)/60) FROM tickets t WHERE t.org_id=$1 AND t.assignee_id=u.id AND t.resolved_at>=$2) AS avg_resolution_min,
        (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.assignee_id=u.id AND t.status IN ('open','in_progress')) AS open_now,
        (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND COALESCE(t.breached_assignee_id,t.assignee_id)=u.id AND t.created_at>=$2 AND ${MISSED_RESOLUTION}) AS missed_resolution,
        (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND COALESCE(t.response_breach_assignee_id,t.assignee_id)=u.id AND t.created_at>=$2 AND ${MISSED_RESPONSE}) AS missed_response
        FROM users u WHERE u.org_id=$1 AND u.active AND u.role<>'requester' ORDER BY missed_resolution DESC, missed_response DESC, u.name`, [org, since]),
      pool.query(`SELECT count(*) FILTER (WHERE COALESCE(t.breached_assignee_id,t.assignee_id) IS NULL AND ${MISSED_RESOLUTION})::int AS resolution,
        count(*) FILTER (WHERE COALESCE(t.response_breach_assignee_id,t.assignee_id) IS NULL AND ${MISSED_RESPONSE})::int AS response
        FROM tickets t WHERE t.org_id=$1 AND t.created_at>=$2`, [org, since]),
      pool.query(`SELECT t.id,t.number,t.title,t.priority,t.status,t.resolve_due,a.name AS assignee FROM tickets t LEFT JOIN users a ON a.id=t.assignee_id
        WHERE t.org_id=$1 AND t.status IN ('open','in_progress') AND t.resolve_due < now() ORDER BY t.resolve_due LIMIT 20`, [org]),
    ])
    const s = sum.rows[0]
    const summary = { created: s.created, resolved: resolvedN.rows[0].n, open_now: open.rows[0].open, unassigned_open: open.rows[0].unassigned,
      avg_first_response_min: num(s.avg_first_response_min), avg_resolution_min: num(s.avg_resolution_min),
      resolution_sla_pct: pct(s.res_met, s.res_n), response_sla_pct: pct(s.resp_met, s.resp_n), resolution_sample: s.res_n }
    const staffRows = staff.rows.map(r => ({ ...r, avg_resolution_min: num(r.avg_resolution_min) }))
    const insights: string[] = []
    if (dep.rows[0] && s.created) insights.push(`${dep.rows[0].label} raised the most tickets: ${dep.rows[0].n} of ${s.created} (${pct(dep.rows[0].n, s.created)}%).`)
    if (cat.rows[0] && s.created) insights.push(`${cat.rows[0].label} is the most common category: ${cat.rows[0].n} tickets (${pct(cat.rows[0].n, s.created)}%).`)
    if (assets.rows[0]?.n >= 2) insights.push(`Equipment ${assets.rows[0].tag} (${assets.rows[0].name}) appeared in ${assets.rows[0].n} tickets. Check whether repair or replacement is due.`)
    if (summary.resolution_sla_pct !== null && s.res_n >= 5 && summary.resolution_sla_pct < 80) insights.push(`Only ${summary.resolution_sla_pct}% of tickets met their resolution deadline. Review staffing or the SLA targets.`)
    for (const r of staffRows.filter(x => x.missed_resolution > 0).slice(0, 3)) insights.push(`${r.name} had ${r.missed_resolution} ticket(s) pass the resolution deadline unresolved or late.`)
    if (open.rows[0].unassigned > 0) insights.push(`${open.rows[0].unassigned} open ticket(s) have no assignee.`)
    res.json({ days: n, unit, summary, series: series(n, created.rows, resolved.rows), byCategory: cat.rows, byPriority: pri.rows, byStatus: st.rows,
      byDepartment: dep.rows, topAssets: assets.rows, staff: staffRows, unassignedMissed: unassigned.rows[0], overdue: overdue.rows, insights })
  })

  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s // stop spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"'
  }
  app.get('/api/analytics/export.csv', need('admin'), async (req, res) => {
    const org = me(res).org_id, since = new Date(Date.now() - days(req.query.days) * 864e5)
    const { rows } = await pool.query(`SELECT t.number,t.title,t.status,t.priority,t.category,t.department,t.room,r.name AS requester,a.name AS assignee,s.tag AS asset,
      t.created_at,t.first_response_at,t.resolved_at,t.resolve_due,(CASE WHEN ${MISSED_RESOLUTION} THEN 'yes' ELSE 'no' END) AS missed_resolution_deadline
      FROM tickets t JOIN users r ON r.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id LEFT JOIN assets s ON s.id=t.asset_id
      WHERE t.org_id=$1 AND t.created_at>=$2 ORDER BY t.number`, [org, since])
    const cols = ['number', 'title', 'status', 'priority', 'category', 'department', 'room', 'requester', 'assignee', 'asset', 'created_at', 'first_response_at', 'resolved_at', 'resolve_due', 'missed_resolution_deadline']
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="techdesk-tickets.csv"')
    res.send([cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n'))
  })
}
