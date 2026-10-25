下面的辅助函数会在计算哈希之前规范化标题：

```ts
export function normalizeHeading(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}
```

如 $O(n \log n)$ 这样的行内公式保持不变，独立公式同样如此：

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$
