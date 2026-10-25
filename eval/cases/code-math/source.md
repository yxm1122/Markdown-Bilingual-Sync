The helper below normalizes a heading before it is hashed:

```ts
export function normalizeHeading(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}
```

Inline math such as $O(n \log n)$ stays unchanged, and so does the display equation:

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$
