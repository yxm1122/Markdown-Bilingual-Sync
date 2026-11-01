# Payments API integration guide

This guide walks you through creating and confirming a payment intent with the Payments API. It is written for server-side developers who are integrating payments for the first time.

## Before you start

- A sandbox account and a test API key.
- A server that can make HTTPS requests.
- Node.js 20 or later for the sample code.

## Authenticate requests

Send your secret key in the `Authorization` header. Never expose this key in browser code.

```bash
curl https://api.example.com/v1/payments \
  -H "Authorization: Bearer $PAYMENTS_API_KEY" \
  -H "Content-Type: application/json"
```

## Create a payment intent

1. Collect the amount and currency on your server.
2. Create a payment intent with an idempotency key.
3. Return the client secret to your checkout page.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| amount | integer | Yes | Amount in the smallest currency unit. |
| currency | string | Yes | Three-letter ISO currency code. |
| capture_method | string | No | `automatic` or `manual`. |
| metadata | object | No | Up to 20 key-value pairs for reconciliation. |

> [!NOTE]
> Amounts are always integers. For example, `10.50` USD is `1050`.

## Handle errors

Retry only idempotent requests, and use exponential backoff for `429` and `503` responses. See the [API reference](https://api.example.com/docs) for the full error schema.

| Code | Meaning | Action |
| --- | --- | --- |
| `card_declined` | The issuer declined the payment. | Ask the customer for another method. |
| `rate_limited` | Too many requests in a short period. | Retry after the `Retry-After` header. |
| `processing_error` | The payment could not be processed. | Retry with the same idempotency key. |

## Verify webhooks

Validate the signature before you trust a webhook payload.[^1]

[^1]: Signature verification prevents replay attacks and forged events.
