# Concierge acceptable-use policy

Version: `2026-09-26`

Hotels accept this policy once (per hotel group, per version) before they can switch the concierge on or publish services. The API serves the same text at `GET /api/v1/concierge/aup` (source: `src/modules/concierge/aup.ts`; a unit test keeps this file and the code in step). Changing the text needs a new version, and every hotel accepts again.

## Summary

- The concierge is for lawful services only: spa and wellness, dining, celebrations, grooming, transport, tours, family, business and similar.
- No sexual services, escorts, companionship for hire or dating introductions, in any form or under any name.
- No drugs, weapons, gambling facilitation or anything else that is illegal in Nigeria.
- Work only with licensed, vetted providers, and keep guests safe.
- Service texts are screened automatically; flagged services are hidden until the platform reviews them.
- The platform may hide services or suspend the concierge of a hotel that breaks this policy.

## Prohibited

- `SEXUAL_SERVICES`: Sexual services of any kind, escorts, companionship for hire or dating introductions
- `DRUGS`: Illegal drugs, or medicines supplied without a prescription
- `WEAPONS`: Weapons, ammunition or explosives
- `GAMBLING`: Arranging or facilitating gambling or betting
- `ILLEGAL`: Anything else that is illegal in Nigeria (forged documents, black-market currency, trafficking)
- `EXPLOITATION`: Anything involving minors, coercion or exploitation of any person

## Policy

This policy applies to every hotel that uses the concierge: the service catalogue, guest requests, quotes, messages to guests and to vendors.

1. Lawful services only. The concierge arranges lawful services for guests: wellness and spa treatments by licensed therapists, dining and private chefs, celebrations (flowers, candles, cake and room decoration), grooming, transport, licensed security and protocol, tours and experiences, childcare by vetted sitters, shopping, photography, events, table reservations, business services and laundry.

2. Prohibited. You must not offer, arrange, advertise or accept requests for: sexual services of any kind, escorts, companionship for hire or dating introductions; illegal drugs or medicines without a prescription; weapons, ammunition or explosives; gambling or betting facilitation; forged documents, black-market currency or any other service that is illegal in Nigeria; anything involving minors, coercion or the exploitation of any person.

3. Providers. Vendors you use must be lawful businesses with the licences their work needs. You are responsible for choosing and supervising them, and for your guests' safety.

4. Screening and review. Service names, descriptions and questions, and the text of guest requests, are screened automatically. A flagged service is hidden from guests until the platform reviews it. A flagged guest request is never fulfilled automatically: a manager decides. The platform may review, hide or reject any service at any time.

5. Privacy. Private (discreet) requests are for the guest's privacy, not to hide prohibited activity. Keep private requests to staff who need to see them, and never share guest details with vendors beyond what the job needs.

6. Enforcement. The platform may hide services, suspend the concierge of a hotel, suspend the hotel's account and report illegal activity to the authorities. Suspected trafficking or exploitation is always reported.

7. Acceptance. By accepting, you confirm that you have read this policy, that you have the authority to accept it for your hotel group, and that your team will follow it.

## How it is enforced

- Every service name, description, variant, question and option, and the text of every guest request, is screened against the denylist in `src/modules/concierge/denylist.ts` (word boundaries, folded accents, common letter substitutions and spaced-out letters).
- A flagged service is saved as `PENDING_REVIEW`, hidden from guests, and listed in the platform console review queue (approve, reject with a reason, or suspend the hotel's concierge).
- A flagged guest request is never priced, confirmed or sent to a vendor automatically. The guest sees a neutral "We'll get back to you" and a manager with `concierge.review` clears or declines it.
- The platform can hide any service at any time and suspend a hotel's concierge; every such action is in the platform audit log and in the hotel's audit trail.
