import { describe, expect, it } from 'vitest';
import { _test } from './emailAuth';

describe('email auth OTP helpers', () => {
  it('normalizes and validates email addresses conservatively', () => {
    expect(_test.normalizeEmail('  TEST@Example.COM ')).toBe('test@example.com');
    expect(_test.validEmail('oyuncu@example.com')).toBe(true);
    expect(_test.validEmail('oyuncu@example')).toBe(false);
    expect(_test.validEmail('oyuncu example.com')).toBe(false);
  });

  it('keeps only six numeric OTP characters', () => {
    expect(_test.cleanCode(' 12a-34 567 ')).toBe('123456');
  });

  it('hashes OTPs per user/email/purpose and compares safely', () => {
    const a = _test.hashCode('a@example.com', 'user-1', '123456', 'link');
    const b = _test.hashCode('a@example.com', 'user-1', '123456', 'link');
    const c = _test.hashCode('a@example.com', 'user-2', '123456', 'link');
    expect(_test.sameHash(a, b)).toBe(true);
    expect(_test.sameHash(a, c)).toBe(false);
  });

  it('renders branded Turkish OTP email content without auth links', () => {
    const text = _test.textMail('123456', 'link');
    const html = _test.htmlMail('123456', 'login');
    expect(text).toContain('123456');
    expect(text).toContain('Online Kahvem');
    expect(html).toContain('123456');
    expect(html).not.toMatch(/localhost|href=/i);
  });
});
