import nodemailer from 'nodemailer'

export type Mailer = (to: string[], subject: string, text: string) => Promise<void>

/** Sends through the SMTP server in SMTP_* variables. Without SMTP_HOST, emails are only logged (not sent). */
export function smtpMailer(): Mailer {
  const e = process.env
  if (!e.SMTP_HOST) return async (to, subject) => { console.warn(`[email NOT sent, SMTP_HOST not set] "${subject}" to ${to.join(', ')}`) }
  const port = Number(e.SMTP_PORT ?? 587)
  const t = nodemailer.createTransport({ host: e.SMTP_HOST, port, secure: port === 465, auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined })
  return async (to, subject, text) => { await t.sendMail({ from: e.SMTP_FROM ?? e.SMTP_USER, to, subject, text }) }
}
