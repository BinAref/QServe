/**
 * Deterministic JSON serialisation.
 *
 * A signature is over bytes, so signer and verifier must agree byte-for-byte on
 * how an object becomes text. `JSON.stringify` does not guarantee key order
 * across engines or versions, so we impose one: keys sorted by Unicode code
 * point, no insignificant whitespace, `undefined` members dropped.
 *
 * The signed artefact is always kept as the *string* produced here, never
 * re-serialised from a parsed object, so verification cannot drift.
 */

export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('cannot canonicalise a non-finite number');
      }
      // Avoid "-0" and exponent-notation ambiguity for integral values.
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('cannot canonicalise a bigint');
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`cannot canonicalise a ${typeof value}`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => serialise(v === undefined ? null : v)).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  if (typeof (object as { toJSON?: unknown }).toJSON === 'function') {
    return serialise((object as { toJSON: () => unknown }).toJSON());
  }

  const parts: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const member = object[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialise(member)}`);
  }
  return `{${parts.join(',')}}`;
}
