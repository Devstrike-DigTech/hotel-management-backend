/**
 * Concierge acceptable-use policy (M8). Hotels accept it once (per hotel
 * group, per version) before they can switch the concierge on or publish
 * services. `docs/concierge-acceptable-use.md` carries the same text word for
 * word (a unit test keeps them in step). Changing the text means a new
 * `AUP_VERSION`, and every hotel accepts again.
 */
export const AUP_VERSION = '2026-09-26';

export const AUP_TITLE = 'Concierge acceptable-use policy';

export const AUP_PROHIBITED = [
  { code: 'SEXUAL_SERVICES', label: 'Sexual services of any kind, escorts, companionship for hire or dating introductions' },
  { code: 'DRUGS', label: 'Illegal drugs, or medicines supplied without a prescription' },
  { code: 'WEAPONS', label: 'Weapons, ammunition or explosives' },
  { code: 'GAMBLING', label: 'Arranging or facilitating gambling or betting' },
  { code: 'ILLEGAL', label: 'Anything else that is illegal in Nigeria (forged documents, black-market currency, trafficking)' },
  { code: 'EXPLOITATION', label: 'Anything involving minors, coercion or exploitation of any person' },
] as const;

export const AUP_SUMMARY = [
  'The concierge is for lawful services only: spa and wellness, dining, celebrations, grooming, transport, tours, family, business and similar.',
  'No sexual services, escorts, companionship for hire or dating introductions, in any form or under any name.',
  'No drugs, weapons, gambling facilitation or anything else that is illegal in Nigeria.',
  'Work only with licensed, vetted providers, and keep guests safe.',
  'Service texts are screened automatically; flagged services are hidden until the platform reviews them.',
  'The platform may hide services or suspend the concierge of a hotel that breaks this policy.',
];

export const AUP_TEXT = [
  'This policy applies to every hotel that uses the concierge: the service catalogue, guest requests, quotes, messages to guests and to vendors.',
  '1. Lawful services only. The concierge arranges lawful services for guests: wellness and spa treatments by licensed therapists, dining and private chefs, celebrations (flowers, candles, cake and room decoration), grooming, transport, licensed security and protocol, tours and experiences, childcare by vetted sitters, shopping, photography, events, table reservations, business services and laundry.',
  '2. Prohibited. You must not offer, arrange, advertise or accept requests for: sexual services of any kind, escorts, companionship for hire or dating introductions; illegal drugs or medicines without a prescription; weapons, ammunition or explosives; gambling or betting facilitation; forged documents, black-market currency or any other service that is illegal in Nigeria; anything involving minors, coercion or the exploitation of any person.',
  '3. Providers. Vendors you use must be lawful businesses with the licences their work needs. You are responsible for choosing and supervising them, and for your guests\' safety.',
  '4. Screening and review. Service names, descriptions and questions, and the text of guest requests, are screened automatically. A flagged service is hidden from guests until the platform reviews it. A flagged guest request is never fulfilled automatically: a manager decides. The platform may review, hide or reject any service at any time.',
  '5. Privacy. Private (discreet) requests are for the guest\'s privacy, not to hide prohibited activity. Keep private requests to staff who need to see them, and never share guest details with vendors beyond what the job needs.',
  '6. Enforcement. The platform may hide services, suspend the concierge of a hotel, suspend the hotel\'s account and report illegal activity to the authorities. Suspected trafficking or exploitation is always reported.',
  '7. Acceptance. By accepting, you confirm that you have read this policy, that you have the authority to accept it for your hotel group, and that your team will follow it.',
].join('\n\n');
