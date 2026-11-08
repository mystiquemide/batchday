import {
  ApiError,
  Client,
  Environment,
  LogLevel,
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

let vault: VaultController | null = null;

function vaultClient(): VaultController {
  if (vault) return vault;
  const env = process.env.PAYPAL_ENV === 'live' ? Environment.Production : Environment.Sandbox;
  const client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: requireEnv('PAYPAL_CLIENT_ID'),
      oAuthClientSecret: requireEnv('PAYPAL_CLIENT_SECRET'),
    },
    environment: env,
    timeout: 15_000,
    logging: { logLevel: LogLevel.Warn, logRequest: { logBody: false }, logResponse: { logBody: false } },
  });
  vault = new VaultController(client);
  return vault;
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
    throw err;
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
            permitMultiplePaymentTokens: false,
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
