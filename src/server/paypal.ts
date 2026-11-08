import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  LogLevel,
  type LoggerInterface,
  OrdersController,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  UsagePattern,
  VaultController,
  VaultTokenRequestType,
} from '@paypal/paypal-server-sdk';

/** A PayPal failure with the fields we are allowed to log and show. Never carries credentials. */
export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId: string | null,
    readonly issue: string | null,
  ) {
    super(message);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The SDK logs every request at the configured level. Batchday logs its own failures with debug IDs instead. */
const silentLogger: LoggerInterface = { log: () => undefined };

let client: Client | null = null;
let vault: VaultController | null = null;
let orders: OrdersController | null = null;

function sdkClient(): Client {
  if (client) return client;
  const env = process.env.PAYPAL_ENV === 'live' ? Environment.Production : Environment.Sandbox;
  client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: requireEnv('PAYPAL_CLIENT_ID'),
      oAuthClientSecret: requireEnv('PAYPAL_CLIENT_SECRET'),
    },
    environment: env,
    timeout: 15_000,
    logging: { logger: silentLogger, logLevel: LogLevel.Error, logRequest: { logBody: false }, logResponse: { logBody: false } },
  });
  return client;
}

function vaultClient(): VaultController {
  return (vault ??= new VaultController(sdkClient()));
}

function ordersClient(): OrdersController {
  return (orders ??= new OrdersController(sdkClient()));
}

function debugIdOf(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'paypal-debug-id');
  return key ? headers[key] : null;
}

async function call<T>(op: string, fn: () => Promise<{ result: T; headers: Record<string, string> }>) {
  try {
    const res = await fn();
    return { result: res.result, debugId: debugIdOf(res.headers) };
  } catch (err) {
    if (err instanceof ApiError) {
      let issue: string | null = null;
      let debugId = debugIdOf(err.headers);
      try {
        const body = JSON.parse(typeof err.body === 'string' ? err.body : '{}');
        issue = body?.details?.[0]?.issue ?? body?.name ?? null;
        debugId = debugId ?? body?.debug_id ?? null;
      } catch {
        /* non-JSON body */
      }
      throw new PayPalError(`PayPal ${op} failed with HTTP ${err.statusCode}`, err.statusCode, debugId, issue);
    }
    // Network failure or timeout: the request may or may not have reached PayPal.
    throw new PayPalError(`PayPal ${op} did not return a response`, 0, null, err instanceof Error ? err.name : null);
  }
}

/** Vault v3 setup token for saving a PayPal wallet without a purchase. */
export async function createSetupToken(opts: { requestId: string; returnUrl: string; cancelUrl: string; description: string }) {
  const { result, debugId } = await call('setup token create', () =>
    vaultClient().createSetupToken({
      paypalRequestId: opts.requestId,
      body: {
        paymentSource: {
          paypal: {
            description: opts.description,
            usagePattern: UsagePattern.Immediate,
            usageType: PaypalPaymentTokenUsageType.Merchant,
            customerType: PaypalPaymentTokenCustomerType.Consumer,
            // One token per reservation, so cancelling one reservation cannot revoke another by the same buyer.
            permitMultiplePaymentTokens: true,
            experienceContext: {
              brandName: 'Batchday',
              returnUrl: opts.returnUrl,
              cancelUrl: opts.cancelUrl,
            },
          },
        },
      },
    }),
  );
  const approveUrl = result.links?.find((l) => l.rel === 'approve')?.href;
  if (!result.id || !approveUrl) throw new PayPalError('PayPal setup token response missing id or approve link', 502, debugId, null);
  return { setupTokenId: result.id, approveUrl, debugId };
}

/** Exchanges an approved setup token for a reusable payment token (the vault_id). */
export async function createPaymentToken(opts: { requestId: string; setupTokenId: string }) {
  const { result, debugId } = await call('payment token create', () =>
    vaultClient().createPaymentToken({
      paypalRequestId: opts.requestId,
      body: { paymentSource: { token: { id: opts.setupTokenId, type: VaultTokenRequestType.SetupToken } } },
    }),
  );
  if (!result.id) throw new PayPalError('PayPal payment token response missing id', 502, debugId, null);
  const paypal = result.paymentSource?.paypal;
  const name = [paypal?.name?.givenName, paypal?.name?.surname].filter(Boolean).join(' ') || null;
  return {
    vaultId: result.id,
    customerId: result.customer?.id ?? null,
    email: paypal?.emailAddress ?? null,
    name,
    debugId,
  };
}

export interface ChargeResult {
  orderId: string | null;
  orderStatus: string | null;
  captureId: string | null;
  captureStatus: string | null;
  debugId: string | null;
}

/**
 * Merchant-initiated charge on a saved PayPal wallet (Orders v2, intent CAPTURE, vault_id).
 * requestId is the PayPal-Request-Id: PayPal returns the original order for a repeated id
 * instead of creating a second one.
 */
export async function chargeVault(opts: {
  requestId: string;
  vaultId: string;
  amount: string;
  currency: 'USD';
  referenceId: string;
  description: string;
}): Promise<ChargeResult> {
  const { result, debugId } = await call('order create', () =>
    ordersClient().createOrder({
      paypalRequestId: opts.requestId,
      prefer: 'return=representation',
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: opts.referenceId,
            customId: opts.referenceId,
            description: opts.description,
            amount: { currencyCode: opts.currency, value: opts.amount },
          },
        ],
        paymentSource: { paypal: { vaultId: opts.vaultId } },
      },
    }),
  );
  const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
  return {
    orderId: result.id ?? null,
    orderStatus: result.status ?? null,
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ?? null,
    debugId,
  };
}

export async function getOrderStatus(orderId: string) {
  const { result, debugId } = await call('order get', () => ordersClient().getOrder({ id: orderId }));
  const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
  return { orderId: result.id ?? null, status: result.status ?? null, captureId: capture?.id ?? null, captureStatus: capture?.status ?? null, debugId };
}

/** Deletes a saved wallet at PayPal. Afterwards PayPal rejects any charge on it. 404 means it is already gone. */
export async function deletePaymentToken(vaultId: string): Promise<{ debugId: string | null; alreadyGone: boolean }> {
  try {
    const { debugId } = await call('payment token delete', () => vaultClient().deletePaymentToken(vaultId));
    return { debugId, alreadyGone: false };
  } catch (err) {
    if (err instanceof PayPalError && err.status === 404) return { debugId: err.debugId, alreadyGone: true };
    throw err;
  }
}
