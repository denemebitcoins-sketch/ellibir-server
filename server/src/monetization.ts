import { createPublicKey, createSign, createVerify, randomUUID } from 'crypto';
import type { Request } from 'express';
import { rpcService, verifyToken } from './supabase';

const ADMOB_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.elli.bir';

type AdMobKey = { keyId: number; pem?: string; base64?: string };
let keyCache: { expiresAt: number; keys: Map<string, string> } | null = null;

function base64UrlBytes(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - normalized.length % 4) % 4), 'base64');
}

async function admobKeys(): Promise<Map<string, string>> {
  if (keyCache && keyCache.expiresAt > Date.now()) return keyCache.keys;
  const response = await fetch(ADMOB_KEYS_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`admob_keys_http_${response.status}`);
  const payload: any = await response.json();
  const keys = new Map<string, string>();
  for (const key of (payload?.keys || []) as AdMobKey[]) {
    if (key.pem) keys.set(String(key.keyId), key.pem);
    else if (key.base64) {
      const der = Buffer.from(key.base64, 'base64');
      keys.set(String(key.keyId), createPublicKey({ key: der, type: 'spki', format: 'der' })
        .export({ type: 'spki', format: 'pem' }).toString());
    }
  }
  if (!keys.size) throw new Error('admob_keys_empty');
  keyCache = { expiresAt: Date.now() + 23 * 60 * 60 * 1000, keys };
  return keys;
}

export async function verifyAdMobSsv(originalUrl: string): Promise<URLSearchParams> {
  const qIndex = originalUrl.indexOf('?');
  if (qIndex < 0) throw new Error('ssv_query_missing');
  const raw = originalUrl.slice(qIndex + 1);
  const marker = '&signature=';
  const sigAt = raw.lastIndexOf(marker);
  if (sigAt < 0) throw new Error('ssv_signature_missing');
  const signedContent = raw.slice(0, sigAt);
  const params = new URLSearchParams(raw);
  const signature = params.get('signature') || '';
  const keyId = params.get('key_id') || '';
  const keys = await admobKeys();
  const pem = keys.get(keyId);
  if (!pem) throw new Error('ssv_key_unknown');
  const verifier = createVerify('SHA256');
  verifier.update(Buffer.from(signedContent, 'utf8'));
  verifier.end();
  if (!verifier.verify(pem, base64UrlBytes(signature))) throw new Error('ssv_signature_invalid');
  return params;
}

export async function handleAdMobSsv(req: Request): Promise<Record<string, unknown>> {
  const params = await verifyAdMobSsv(req.originalUrl);
  const sessionId = params.get('custom_data') || '';
  const transactionId = params.get('transaction_id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('ssv_session_invalid');
  if (!transactionId) throw new Error('ssv_transaction_missing');
  return await rpcService('finalize_rewarded_ad', {
    p_session_id: sessionId,
    p_transaction_id: transactionId,
    p_ad_unit: params.get('ad_unit') || '',
    p_reward_item: params.get('reward_item') || '',
    p_reward_amount: Number(params.get('reward_amount') || 0),
  });
}

function parseUnifiedReceipt(raw: string): any {
  const wrapper = JSON.parse(raw || '{}');
  const payload = typeof wrapper.Payload === 'string' ? JSON.parse(wrapper.Payload) : wrapper.Payload;
  const json = typeof payload?.json === 'string' ? JSON.parse(payload.json) : payload?.json;
  return {
    store: wrapper.Store,
    transactionId: wrapper.TransactionID || json?.orderId || '',
    packageName: json?.packageName || '',
    productId: json?.productId || '',
    purchaseToken: json?.purchaseToken || '',
    raw: wrapper,
  };
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function googleAccessToken(): Promise<string> {
  const email = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL || '';
  const privateKey = (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('play_verifier_not_configured');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`); signer.end();
  const assertion = `${header}.${claims}.${b64url(signer.sign(privateKey))}`;
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`play_oauth_${response.status}`);
  const json: any = await response.json();
  if (!json?.access_token) throw new Error('play_oauth_token_missing');
  return json.access_token;
}

const PRODUCTS: Record<string, { type: 'consumable' | 'subscription'; chips?: number; diamonds?: number; vipMonths?: number }> = {
  'onlinekahvem.chips.100k': { type: 'consumable', chips: 100_000 },
  'onlinekahvem.chips.250k': { type: 'consumable', chips: 250_000 },
  'onlinekahvem.chips.600k': { type: 'consumable', chips: 600_000 },
  'onlinekahvem.chips.1500k': { type: 'consumable', chips: 1_500_000 },
  'onlinekahvem.chips.4000k': { type: 'consumable', chips: 4_000_000 },
  'onlinekahvem.diamond.100': { type: 'consumable', diamonds: 100 },
  'onlinekahvem.diamond.300': { type: 'consumable', diamonds: 300 },
  'onlinekahvem.diamond.750': { type: 'consumable', diamonds: 750 },
  'onlinekahvem.diamond.1750': { type: 'consumable', diamonds: 1750 },
  'onlinekahvem.diamond.4000': { type: 'consumable', diamonds: 4000 },
  'onlinekahvem.vip.1month': { type: 'subscription', vipMonths: 1 },
  'onlinekahvem.vip.6month': { type: 'subscription', vipMonths: 6 },
  'onlinekahvem.vip.12month': { type: 'subscription', vipMonths: 12 },
};

async function verifyGoogleProduct(token: string, productId: string, type: string): Promise<any> {
  const access = await googleAccessToken();
  const encoded = encodeURIComponent(token);
  const url = type === 'subscription'
    ? `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${encoded}`
    : `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/products/${encodeURIComponent(productId)}/tokens/${encoded}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`play_verify_${response.status}`);
  return await response.json();
}

function storeMatchesProduct(store: any, productId: string, type: 'consumable' | 'subscription'): boolean {
  // ProductPurchase is fetched through a product-specific URL. Subscriptions v2
  // is token-only, so its returned line item must be bound to the requested SKU.
  if (type === 'consumable') return true;
  return Array.isArray(store?.lineItems)
    && store.lineItems.some((item: any) => String(item?.productId || '') === productId);
}

export async function verifyPlayPurchase(authHeader: string | undefined, receipt: string, requestedProduct: string) {
  const userId = await verifyToken((authHeader || '').replace(/^Bearer\s+/i, ''));
  if (!userId) throw new Error('auth_required');
  const parsed = parseUnifiedReceipt(receipt);
  const productId = parsed.productId || requestedProduct;
  const product = PRODUCTS[productId];
  if (!product || productId !== requestedProduct) throw new Error('product_invalid');
  if (parsed.store !== 'GooglePlay' || parsed.packageName !== PACKAGE_NAME || !parsed.purchaseToken)
    throw new Error('receipt_invalid');
  const store = await verifyGoogleProduct(parsed.purchaseToken, productId, product.type);
  if (!storeMatchesProduct(store, productId, product.type)) throw new Error('store_product_mismatch');
  const valid = product.type === 'subscription'
    ? ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'].includes(store?.subscriptionState)
    : Number(store?.purchaseState ?? 1) === 0;
  if (!valid) throw new Error('purchase_not_active');
  return await rpcService('finalize_play_purchase', {
    p_user_id: userId, p_product_id: productId, p_purchase_token: parsed.purchaseToken,
    p_order_id: parsed.transactionId, p_package_name: PACKAGE_NAME,
    p_product_type: product.type, p_raw_receipt: parsed.raw, p_store_response: store,
  });
}

export const _test = { parseUnifiedReceipt, base64UrlBytes, storeMatchesProduct };
