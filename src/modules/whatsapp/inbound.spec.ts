import { createHmac } from 'node:crypto';
import { extractMessages, verifyHubSignature } from './inbound.service.js';

const SECRET = 'wa-app-secret';
const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '2348031234567', text: { body: '1' } }] } }] }] }));
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('WhatsApp webhook', () => {
  it('accepts the Meta signature of the raw body', () => {
    expect(verifyHubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects missing, malformed, wrong-secret and tampered signatures', () => {
    expect(verifyHubSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyHubSignature(body, 'sha1=abc', SECRET)).toBe(false);
    expect(verifyHubSignature(body, 'sha256=zz', SECRET)).toBe(false);
    expect(verifyHubSignature(body, sign(body, 'other'), SECRET)).toBe(false);
    expect(verifyHubSignature(Buffer.from(body.toString().replace('"1"', '"2"')), sign(body), SECRET)).toBe(false);
    expect(verifyHubSignature(body, sign(body), undefined)).toBe(false);
  });

  it('extracts text and quick-reply messages', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'a', from: '2348031234567', text: { body: 'DIGEST' } },
                  { id: 'b', from: '2348031234567', button: { text: '1' } },
                  { id: 'c', from: '2348031234567', interactive: { button_reply: { title: 'ACK' } } },
                  { from: 'no-id' },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(extractMessages(payload)).toEqual([
      { id: 'a', from: '2348031234567', text: 'DIGEST' },
      { id: 'b', from: '2348031234567', text: '1' },
      { id: 'c', from: '2348031234567', text: 'ACK' },
    ]);
    expect(extractMessages({})).toEqual([]);
  });
});
