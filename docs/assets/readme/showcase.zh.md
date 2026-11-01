# Payments API 集成指南

本指南介绍如何使用 Payments API 创建并确认支付意图，面向首次集成支付能力的服务端开发者。

## 准备工作

- 一个沙箱账号和一个测试 API Key。
- 一台能够发起 HTTPS 请求的服务器。
- Node.js 20 或更高版本，用于运行示例代码。

## 请求认证

在 `Authorization` 请求头中携带密钥。切勿在浏览器代码中暴露该密钥。

```bash
curl https://api.example.com/v1/payments \
  -H "Authorization: Bearer $PAYMENTS_API_KEY" \
  -H "Content-Type: application/json"
```

## 创建支付意图

1. 在服务器端收集金额和币种。
2. 使用幂等键创建支付意图。
3. 将 client secret 返回给结账页面。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| amount | integer | 是 | 以最小货币单位表示的金额。 |
| currency | string | 是 | 三位 ISO 货币代码。 |
| capture_method | string | 否 | `automatic` 或 `manual`。 |
| metadata | object | 否 | 最多 20 个用于对账的键值对。 |

> [!NOTE]
> 金额始终为整数。例如，10.50 USD 应写成 `1050`。

## 处理错误

只重试幂等请求，并对 `429` 和 `503` 响应使用指数退避。完整错误 schema 见 [API 参考](https://api.example.com/docs)。

| 代码 | 含义 | 处理方式 |
| --- | --- | --- |
| `card_declined` | 发卡行拒绝了该笔支付。 | 请客户更换支付方式。 |
| `rate_limited` | 短时间内请求过多。 | 按 `Retry-After` 响应头稍后重试。 |
| `processing_error` | 支付无法处理。 | 使用同一幂等键重试。 |

## 验证 Webhook

在信任 Webhook 负载之前，请先验证签名。[^1]

[^1]: 签名验证可防止重放攻击和伪造事件。
