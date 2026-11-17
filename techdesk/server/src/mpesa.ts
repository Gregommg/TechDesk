export type Mpesa = { stkPush(a: { phone: string; amount: number; ref: string }): Promise<{ checkoutRequestId: string }> }

/** Safaricom Daraja STK push (Lipa Na M-Pesa Online). Needs the MPESA_* variables. */
export function daraja(): Mpesa {
  return {
    async stkPush({ phone, amount, ref }) {
      const e = process.env
      for (const k of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET', 'APP_URL'])
        if (!e[k]) throw new Error(`${k} is not set`)
      const base = e.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'
      const tr = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${e.MPESA_CONSUMER_KEY}:${e.MPESA_CONSUMER_SECRET}`).toString('base64') } })
      if (!tr.ok) throw new Error(`Daraja auth failed (${tr.status})`)
      const { access_token } = (await tr.json()) as { access_token: string }
      const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
      const password = Buffer.from(`${e.MPESA_SHORTCODE}${e.MPESA_PASSKEY}${ts}`).toString('base64')
      const r = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ BusinessShortCode: e.MPESA_SHORTCODE, Password: password, Timestamp: ts, TransactionType: 'CustomerPayBillOnline',
          Amount: amount, PartyA: phone, PartyB: e.MPESA_SHORTCODE, PhoneNumber: phone,
          CallBackURL: `${e.APP_URL}/api/mpesa/callback/${e.MPESA_CALLBACK_SECRET}`, AccountReference: ref, TransactionDesc: 'TechDesk plan' }) })
      const j = (await r.json()) as { ResponseCode?: string; CheckoutRequestID?: string }
      if (!r.ok || j.ResponseCode !== '0' || !j.CheckoutRequestID) throw new Error(`STK push rejected: ${JSON.stringify(j).slice(0, 200)}`)
      return { checkoutRequestId: j.CheckoutRequestID }
    },
  }
}
