import type { PaystackBank } from './paystack.client.js';

/** Development bank list (subset of Paystack's Nigerian banks, real CBN codes). */
export const MOCK_BANKS: PaystackBank[] = [
  { code: '044', name: 'Access Bank', slug: 'access-bank', type: 'nuban' },
  { code: '023', name: 'Citibank Nigeria', slug: 'citibank-nigeria', type: 'nuban' },
  { code: '050', name: 'Ecobank Nigeria', slug: 'ecobank-nigeria', type: 'nuban' },
  { code: '070', name: 'Fidelity Bank', slug: 'fidelity-bank', type: 'nuban' },
  { code: '011', name: 'First Bank of Nigeria', slug: 'first-bank-of-nigeria', type: 'nuban' },
  { code: '214', name: 'First City Monument Bank', slug: 'first-city-monument-bank', type: 'nuban' },
  { code: '058', name: 'Guaranty Trust Bank', slug: 'guaranty-trust-bank', type: 'nuban' },
  { code: '030', name: 'Heritage Bank', slug: 'heritage-bank', type: 'nuban' },
  { code: '301', name: 'Jaiz Bank', slug: 'jaiz-bank', type: 'nuban' },
  { code: '082', name: 'Keystone Bank', slug: 'keystone-bank', type: 'nuban' },
  { code: '50211', name: 'Kuda Bank', slug: 'kuda-bank', type: 'nuban' },
  { code: '999992', name: 'OPay Digital Services (OPay)', slug: 'paycom', type: 'nuban' },
  { code: '999991', name: 'PalmPay', slug: 'palmpay', type: 'nuban' },
  { code: '076', name: 'Polaris Bank', slug: 'polaris-bank', type: 'nuban' },
  { code: '101', name: 'Providus Bank', slug: 'providus-bank', type: 'nuban' },
  { code: '221', name: 'Stanbic IBTC Bank', slug: 'stanbic-ibtc-bank', type: 'nuban' },
  { code: '068', name: 'Standard Chartered Bank', slug: 'standard-chartered-bank', type: 'nuban' },
  { code: '232', name: 'Sterling Bank', slug: 'sterling-bank', type: 'nuban' },
  { code: '032', name: 'Union Bank of Nigeria', slug: 'union-bank-of-nigeria', type: 'nuban' },
  { code: '033', name: 'United Bank For Africa', slug: 'united-bank-for-africa', type: 'nuban' },
  { code: '215', name: 'Unity Bank', slug: 'unity-bank', type: 'nuban' },
  { code: '035', name: 'Wema Bank', slug: 'wema-bank', type: 'nuban' },
  { code: '057', name: 'Zenith Bank', slug: 'zenith-bank', type: 'nuban' },
];

const FIRST = ['ADEBAYO', 'CHINONSO', 'FUNMILAYO', 'IBRAHIM', 'NGOZI', 'OLUWASEUN', 'EMEKA', 'AISHA', 'TUNDE', 'CHIAMAKA'];
const LAST = ['OKONKWO', 'ADEYEMI', 'BELLO', 'NWOSU', 'OGUNLEYE', 'EZE', 'ABUBAKAR', 'OKAFOR', 'BALOGUN', 'IBEKWE'];

/**
 * Deterministic fake account name for a 10-digit account number. Numbers
 * starting with "000" do not exist (to exercise the error path).
 */
export function mockAccountName(accountNumber: string): string | null {
  if (!/^\d{10}$/.test(accountNumber) || accountNumber.startsWith('000')) return null;
  const n = accountNumber.split('').reduce((a, c) => (a * 31 + Number(c)) % 1_000_003, 7);
  return `${FIRST[n % FIRST.length]} ${LAST[Math.floor(n / 7) % LAST.length]} HOSPITALITY`;
}
