# Scheduled broadcasts (difusiones programadas)

The "Nueva difusión" wizard no longer sends from the browser. It only saves
the broadcast (`status = 'scheduled'`, `scheduled_at`, and
`audience_filter.dispatch = 'server'`) and one `pending` row per recipient in
`broadcast_recipients`. The sending is done by the server, so a broadcast goes
out even if the tab is closed. "Enviar ahora" and "Programar" take the same
path: "now" is just `scheduled_at = now`.

## How it is triggered

`GET /api/broadcasts/cron` does the work. Call it **every minute** from an
external pinger (cron-job.org, GitHub Actions, a VPS cron...):

```
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
  https://<your-domain>/api/broadcasts/cron
```

- Auth is the same as `/api/calls/cron`: header `x-cron-secret` equal to
  `AUTOMATION_CRON_SECRET`, or `Authorization: Bearer <CRON_SECRET>`. With
  neither variable set the route answers `503`.
- `vercel.json` is intentionally not changed: the Vercel plan may reject
  per-minute crons, so the trigger is external.
- A run works for at most about 240 s (`maxDuration = 300`), sends 10
  messages per second, and leaves what is left for the next tick.

## Safety rules

- Only broadcasts with `audience_filter->>'dispatch' = 'server'` are ever
  sent. Older `scheduled` / `sending` rows without that marker are ignored.
- A broadcast is claimed with a compare-and-swap `UPDATE`
  (`scheduled -> sending`, or a stale `sending` row, i.e. `updated_at` older
  than 60 s). Two overlapping runs cannot own the same broadcast.
- Each recipient is updated with `status = 'pending'` as a condition, so a
  recipient is never sent twice. `whatsapp_message_id` is stored so the Meta
  status webhook can mark delivered / read.
- Cancelling (`scheduled -> draft`, detail page) and claiming are both
  conditional updates; whichever happens first wins.
- Before each send the dispatcher checks `do_not_call` for the account. A
  person who replies BAJA (or STOP, "darme de baja", "no molestar") is added
  there by the webhook with `source = 'whatsapp_baja'`, so the dialer skips
  them too.
- Meta's answer decides what happens next: throughput errors (130429, 80007,
  131056) keep the recipient pending for the next tick; payment, restriction,
  paused-template or expired-token errors (131042, 131048, 131031, 368, 132015,
  132016, 132001, 190) stop the broadcast and show the reason on its detail
  page. A message Meta holds for quality is recorded as sent with a note.
- Meta charges per delivered message, to the card of the WhatsApp Business
  account. Recipients must have opted in.
