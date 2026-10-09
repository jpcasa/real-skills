// Second line of defence for what is sent to Jev. The first is that the model
// writes the symptom line without names and that report text is never sent at
// all. This strips what a pattern can catch: emails, phone numbers, long
// digit runs (account, order and card-like numbers). It does not catch names.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const DIGITS = /\d{6,}/g;

export function scrub(text) {
  return String(text ?? '')
    .replace(EMAIL, '[email]')
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone]' : m))
    .replace(DIGITS, '[number]');
}

export const scrubAll = (xs) => (Array.isArray(xs) ? xs.map(scrub) : []);
