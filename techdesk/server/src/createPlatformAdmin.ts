import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { migrate, pool } from './db.js'

// Usage: npm run platform-admin -- you@yourcompany.com 'a-long-password'
const [email, pw] = process.argv.slice(2)
if (!email || !pw || pw.length < 10) { console.error('Usage: npm run platform-admin -- <email> <password of 10+ characters>'); process.exit(1) }
await migrate()
const hash = await bcrypt.hash(pw, 12)
let org = (await pool.query("SELECT id FROM organisations WHERE name='Orbitra Platform' LIMIT 1")).rows[0]
org ??= (await pool.query("INSERT INTO organisations(name,paid,period_end) VALUES('Orbitra Platform',true,now()+interval '100 years') RETURNING id")).rows[0]
await pool.query(`INSERT INTO users(org_id,name,email,password_hash,role,is_platform) VALUES($1,'Platform Admin',lower($2),$3,'admin',true)
  ON CONFLICT (email) DO UPDATE SET password_hash=$3, is_platform=true, password_changed_at=now()`, [org.id, email, hash])
console.log('Platform admin ready:', email.toLowerCase())
await pool.end()
