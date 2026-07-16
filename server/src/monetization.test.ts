import { describe, expect, it } from 'vitest';
import { _test } from './monetization';

describe('monetization parser', () => {
  it('extracts a Google Play purchase from the Unity unified receipt', () => {
    const raw = JSON.stringify({
      Store: 'GooglePlay', TransactionID: 'GPA.123',
      Payload: JSON.stringify({ json: JSON.stringify({
        orderId: 'GPA.123', packageName: 'com.elli.bir',
        productId: 'onlinekahvem.diamond.10', purchaseToken: 'token-1',
      }), signature: 'sig' }),
    });
    const receipt = _test.parseUnifiedReceipt(raw);
    expect(receipt.productId).toBe('onlinekahvem.diamond.10');
    expect(receipt.purchaseToken).toBe('token-1');
    expect(receipt.packageName).toBe('com.elli.bir');
  });

  it('decodes URL-safe base64 signatures', () => {
    expect(_test.base64UrlBytes('SGVsbG8td29ybGQ').toString()).toBe('Hello-world');
  });

  it('binds a subscription token to the exact Google Play product', () => {
    const store = { lineItems: [{ productId: 'onlinekahvem.vip.1month' }] };
    expect(_test.storeMatchesProduct(store, 'onlinekahvem.vip.1month', 'subscription')).toBe(true);
    expect(_test.storeMatchesProduct(store, 'onlinekahvem.vip.12month', 'subscription')).toBe(false);
    expect(_test.storeMatchesProduct({}, 'onlinekahvem.vip.1month', 'subscription')).toBe(false);
  });
});
