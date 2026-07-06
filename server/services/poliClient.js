// POLi Merchant API client (REST/JSON, v2).
//
// The legacy XML MerchantAPIService (merchantapi.apac.paywithpoli.com) this
// file originally targeted no longer resolves via DNS — POLi's current API
// is a JSON REST API under poliapi.apac.paywithpoli.com/api/v2, documented
// at https://apidocs.apac.paywithpoli.com/. Verified against that doc's
// published request/response examples (2026-07):
//   - Auth: HTTP Basic, base64("MerchantCode:AuthenticationCode")
//   - InitiateTransaction request has no MerchantCheckoutURL/MerchantData/
//     UserIPAddress/Timeout fields (those were legacy-XML-only) and adds a
//     separate CancellationURL alongside FailureURL.
//   - InitiateTransaction response has no separate "Token" field — the
//     token is a query param embedded in NavigateURL.
//   - GetTransaction response amount field is "PaymentAmount", not
//     "CurrencyAmount".
// Still unconfirmed against a real live call (docs only) — first live
// sandbox/production transaction should double check these shapes.

const BASE_URL = 'https://poliapi.apac.paywithpoli.com/api/v2';

const POLI_CONFIGURED = !!(process.env.POLI_MERCHANT_CODE && process.env.POLI_AUTH_CODE);

function authHeader() {
  const token = Buffer.from(`${process.env.POLI_MERCHANT_CODE}:${process.env.POLI_AUTH_CODE}`).toString('base64');
  return `Basic ${token}`;
}

async function postJson(path, body) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(`POLi API HTTP ${resp.status} calling ${path}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

async function getJson(path) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: { 'Authorization': authHeader() },
  });
  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(`POLi API HTTP ${resp.status} calling ${path}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

// amount: number (dollars, e.g. 49.00). All URL fields must be absolute.
async function initiateTransaction({
  amount, currencyCode = 'NZD', merchantRef,
  homePageUrl, successUrl, failureUrl, cancellationUrl, notificationUrl,
}) {
  if (!POLI_CONFIGURED) throw new Error('POLi is not configured (POLI_MERCHANT_CODE/POLI_AUTH_CODE missing).');

  const json = await postJson('/Transaction/Initiate', {
    Amount: amount.toFixed(2),
    CurrencyCode: currencyCode,
    MerchantReference: merchantRef,
    MerchantHomepageURL: homePageUrl,
    SuccessURL: successUrl,
    FailureURL: failureUrl,
    CancellationURL: cancellationUrl || failureUrl,
    NotificationURL: notificationUrl,
  });

  if (!json.Success) {
    throw new Error(`POLi InitiateTransaction returned an error (${json.ErrorCode}): ${json.ErrorMessage}`);
  }

  const navigateUrl = json.NavigateURL;
  const token = navigateUrl ? new URL(navigateUrl).searchParams.get('Token') : null;

  if (!navigateUrl || !token) {
    throw new Error(
      `POLi InitiateTransaction response didn't contain the expected NavigateURL/Token — ` +
      `raw response: ${JSON.stringify(json).slice(0, 1000)}`
    );
  }

  return { navigateUrl, token, poliRef: json.TransactionRefNo || null };
}

async function getTransaction(token) {
  if (!POLI_CONFIGURED) throw new Error('POLi is not configured (POLI_MERCHANT_CODE/POLI_AUTH_CODE missing).');

  const json = await getJson(`/Transaction/GetTransaction?token=${encodeURIComponent(token)}`);

  return {
    statusCode: json.TransactionStatusCode || null,
    errors: json.ErrorMessage || null,
    merchantRef: json.MerchantReference || null,
    amount: json.PaymentAmount != null ? String(json.PaymentAmount) : null,
    financialInstitution: json.FinancialInstitutionCode || null,
    raw: JSON.stringify(json),
  };
}

function isSuccessStatus(statusCode) {
  return typeof statusCode === 'string' && statusCode.toLowerCase() === 'completed';
}

module.exports = { POLI_CONFIGURED, initiateTransaction, getTransaction, isSuccessStatus };
