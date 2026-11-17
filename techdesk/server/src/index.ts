import 'dotenv/config'
import { createApp } from './app.js'
import { migrate } from './db.js'
import { smtpMailer } from './mail.js'
import { makeNotifier, slaSweep } from './features.js'

await migrate()
const mailer = smtpMailer()
setInterval(() => slaSweep(makeNotifier(mailer)).catch(e => console.error('SLA sweep failed:', e)), 60_000)
const port = Number(process.env.PORT ?? 4000)
createApp({ mailer }).listen(port, () => console.log(`TechDesk listening on port ${port}`))
