import { describe, expect, it } from 'vitest';

import { clientKey, LoginThrottle } from '../../src/platform/http/login-throttle.js';

const config = { maxAttempts: 3, baseLockSeconds: 60, maxLockSeconds: 600, accountCeiling: 5, accountWindowSeconds: 3600, accountLockSeconds: 900 };

describe('LoginThrottle', () => {
  it('bloqueia o par (conta, IP) sem atingir outro IP', () => {
    const throttle = new LoginThrottle(config);
    for (let i = 0; i < 3; i += 1) throttle.fail('login', 'a@x.com', '1.1.1.1');
    expect(throttle.retryAfter('login', 'a@x.com', '1.1.1.1')).toBeGreaterThan(0);
    expect(throttle.retryAfter('login', 'a@x.com', '2.2.2.2')).toBe(0);
  });

  it('o teto da conta tranca endereços novos, mas não o endereço onde o dono já entrou', () => {
    const throttle = new LoginThrottle(config);
    throttle.succeed('login', 'a@x.com', '9.9.9.9');
    for (let i = 0; i < 5; i += 1) throttle.fail('login', 'a@x.com', `10.0.0.${i}`);
    expect(throttle.retryAfter('login', 'a@x.com', '8.8.8.8')).toBeGreaterThan(0);
    expect(throttle.retryAfter('login', 'a@x.com', '9.9.9.9')).toBe(0);
  });

  it('o endereço conhecido expira', () => {
    const throttle = new LoginThrottle(config);
    const now = Date.now();
    throttle.succeed('login', 'a@x.com', '9.9.9.9', now - 31 * 86_400_000);
    for (let i = 0; i < 5; i += 1) throttle.fail('login', 'a@x.com', `10.0.0.${i}`, now);
    expect(throttle.retryAfter('login', 'a@x.com', '9.9.9.9', now)).toBeGreaterThan(0);
  });
});

describe('clientKey', () => {
  it('agrupa IPv6 por /64 em qualquer posição do "::" e mantém IPv4', () => {
    expect(clientKey('2001:0:0:5::1')).toBe(clientKey('2001::5:1:2:3:4'));
    expect(clientKey('2001:db8:abcd:12:1::5')).toBe(clientKey('2001:DB8:abcd:12:ffff:1:2:3'));
    expect(clientKey('2001:db8:abcd:12::1')).not.toBe(clientKey('2001:db8:abcd:13::1'));
    expect(clientKey('::ffff:198.51.100.2')).toBe('198.51.100.2');
    expect(clientKey(null)).toBe('desconhecido');
  });
});
