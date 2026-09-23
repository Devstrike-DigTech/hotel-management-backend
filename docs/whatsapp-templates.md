# WhatsApp message templates

Outside the 24-hour customer-service window the WhatsApp Cloud API only delivers templates that Meta has approved.
Every message HotelOS starts on WhatsApp is one of the templates below. Submit each one in WhatsApp Manager
(Account tools > Message templates > Create template) exactly as written: same name, category, language, body and
sample values. The source of truth is `src/modules/whatsapp/templates.registry.ts`; a unit test fails if this file and
the registry drift apart.

After Meta approves a template, add its name to `WHATSAPP_APPROVED_TEMPLATES` (comma separated) so the admin app shows it
as approved. Until then messages are still attempted and the Cloud API error is recorded on the notification log.

Replies inside the 24-hour window (for example the answer to an owner who sent `DIGEST`) are sent as plain text and do
not need a template.

| Name | Category | Language | Used for |
| --- | --- | --- | --- |
| `owner_daily_digest` | UTILITY | en | Nightly owner digest (23:00) and the DIGEST reply |
| `guard_alert_high` | UTILITY | en | Real-time owner alert for HIGH Revenue Guard flags |
| `booking_confirmed` | UTILITY | en | Guest booking confirmation (paid online or pay at hotel) for hotels with whatsapp_messaging |
| `pre_arrival` | UTILITY | en | Pre-arrival message 24 hours before check-in |
| `review_request` | UTILITY | en | Review request 4 hours after check-out (guests without an email address) |
| `payment_receipt` | UTILITY | en | Payment receipt (online payments) when the guest has no email address |
| `otp_code` | AUTHENTICATION | en | Guest sign-in code sent over WhatsApp |
| `guest_message` | UTILITY | en | Guest inbox: staff start or resume a conversation outside the 24-hour window |
| `pre_arrival_confirm` | UTILITY | en | Guest inbox: pre-arrival arrival-time confirmation 24 hours before check-in |
| `in_stay_welcome` | UTILITY | en | Guest inbox: welcome after check-in, inviting requests |

## owner_daily_digest

- Category: UTILITY
- Language: English (`en`)
- Used for: Nightly owner digest (23:00) and the DIGEST reply

Body:

```
{{1}} daily summary for {{2}}.
Rooms sold: {{3}} of {{4}} ({{5}} occupancy).
Revenue: {{6}}. Money received: {{7}}.
Check-ins: {{8}}. Check-outs: {{9}}. Day use: {{10}}.
Revenue Guard: {{11}}.
Reply DIGEST at any time for the latest figures.
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | hotel name | The Palmwine House |
| `{{2}}` | business date | Tue 22 Sep 2026 |
| `{{3}}` | rooms sold | 17 |
| `{{4}}` | rooms available | 23 |
| `{{5}}` | occupancy | 74% |
| `{{6}}` | revenue | ₦1,845,000 |
| `{{7}}` | money received | ₦1,612,500 |
| `{{8}}` | check-ins | 6 |
| `{{9}}` | check-outs | 5 |
| `{{10}}` | day-use stays | 1 |
| `{{11}}` | guard summary | 2 open flags, top: Room 204 occupied with no stay |

## guard_alert_high

- Category: UTILITY
- Language: English (`en`)
- Used for: Real-time owner alert for HIGH Revenue Guard flags

Body:

```
Revenue Guard alert at {{1}}: {{2}} high-risk flag(s).
{{3}}
Amount involved: {{4}}.
Review: {{5}}
Reply 1 to acknowledge.
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | hotel name | The Palmwine House |
| `{{2}}` | number of flags | 2 |
| `{{3}}` | top flag | Room 204 occupied with no checked-in stay |
| `{{4}}` | amount | ₦85,000 |
| `{{5}}` | admin link | https://admin.hotelos.ng/guard |

Buttons:

- Quick reply: "1"

## booking_confirmed

- Category: UTILITY
- Language: English (`en`)
- Used for: Guest booking confirmation (paid online or pay at hotel) for hotels with whatsapp_messaging

Body:

```
Hello {{1}}, your booking {{2}} at {{3}} is confirmed.
Check-in: {{4}}
Check-out: {{5}}
Room: {{6}}
Total: {{7}} ({{8}}).
Manage your booking: {{9}}
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | guest first name | Adaeze |
| `{{2}}` | booking code | PWH-7K3Q |
| `{{3}}` | hotel name | The Palmwine House |
| `{{4}}` | check-in | Fri 2 Oct 2026, 14:00 |
| `{{5}}` | check-out | Sun 4 Oct 2026, 12:00 |
| `{{6}}` | room type | Deluxe King |
| `{{7}}` | total | ₦182,750 |
| `{{8}}` | payment status | paid online |
| `{{9}}` | manage link | https://hotelos.ng/trips/PWH-7K3Q?t=abc |

## pre_arrival

- Category: UTILITY
- Language: English (`en`)
- Used for: Pre-arrival message 24 hours before check-in

Body:

```
Hello {{1}}, we look forward to welcoming you to {{2}} on {{3}}.
Check-in is from {{4}}. Address: {{5}}.
Hotel phone: {{6}}.
Your booking {{7}}: {{8}}
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | guest first name | Adaeze |
| `{{2}}` | hotel name | The Palmwine House |
| `{{3}}` | arrival date | Fri 2 Oct 2026 |
| `{{4}}` | check-in time | 14:00 |
| `{{5}}` | address | 14 Admiralty Way, Lekki Phase 1, Lagos |
| `{{6}}` | hotel phone | +234 803 555 0100 |
| `{{7}}` | booking code | PWH-7K3Q |
| `{{8}}` | manage link | https://hotelos.ng/trips/PWH-7K3Q?t=abc |

## review_request

- Category: UTILITY
- Language: English (`en`)
- Used for: Review request 4 hours after check-out (guests without an email address)

Body:

```
Hello {{1}}, thank you for staying at {{2}}. How was your stay? Please leave a short review by {{3}}: {{4}}
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | guest first name | Adaeze |
| `{{2}}` | hotel name | The Palmwine House |
| `{{3}}` | deadline | Fri 23 Oct 2026 |
| `{{4}}` | review link | https://hotelos.ng/review?t=abc |

## payment_receipt

- Category: UTILITY
- Language: English (`en`)
- Used for: Payment receipt (online payments) when the guest has no email address

Body:

```
Payment received: {{1}} for booking {{2}} at {{3}}. Receipt number {{4}}. Thank you.
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | amount | ₦182,750 |
| `{{2}}` | booking code | PWH-7K3Q |
| `{{3}}` | hotel name | The Palmwine House |
| `{{4}}` | receipt number | RCT-2026-000456 |

## otp_code

- Category: AUTHENTICATION
- Language: English (`en`)
- Used for: Guest sign-in code sent over WhatsApp

Body:

```
{{1}} is your verification code. For your security, do not share this code.
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | code | 482913 |

Buttons:

- Copy code: "Copy code"

## Inbound replies

Point the WhatsApp webhook at `https://<api-host>/api/v1/webhooks/whatsapp` with verify token `WHATSAPP_VERIFY_TOKEN`;
deliveries are checked against `X-Hub-Signature-256` using `WHATSAPP_APP_SECRET`. Owners and managers can reply:

- `1` (or `ACK`): acknowledge the latest Revenue Guard alert and its flags.
- `DIGEST`: receive today's summary now.
- anything else: a short help message.

## guest_message

- Category: UTILITY
- Language: English (`en`)
- Used for: Guest inbox: staff start or resume a conversation outside the 24-hour window

Body:

```
Hello {{1}}, this is {{2}}. {{3}} Reply to this message to chat with us.
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | guest first name | Adaeze |
| `{{2}}` | hotel name | The Palmwine House |
| `{{3}}` | message | Your airport pickup is confirmed for 3pm tomorrow. |

## pre_arrival_confirm

- Category: UTILITY
- Language: English (`en`)
- Used for: Guest inbox: pre-arrival arrival-time confirmation 24 hours before check-in
- Button: quick reply `1`

Body:

```
Hello {{1}}, we look forward to welcoming you at {{2}} on {{3}}. Reply 1 to confirm your arrival time.
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | guest first name | Adaeze |
| `{{2}}` | hotel name | The Palmwine House |
| `{{3}}` | arrival date | Fri 2 Oct 2026 |

## in_stay_welcome

- Category: UTILITY
- Language: English (`en`)
- Used for: Guest inbox: welcome after check-in, inviting requests

Body:

```
Welcome to {{1}}, {{2}}. You are in room {{3}}. Reply to this message with any request and our team will help.
```

| Placeholder | Meaning | Sample value |
| --- | --- | --- |
| `{{1}}` | hotel name | The Palmwine House |
| `{{2}}` | guest first name | Adaeze |
| `{{3}}` | room number | 204 |
