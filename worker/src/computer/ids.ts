// Pure: the platform's random identifiers (`op_`, `ckp_`, `lyr_` plus 26 Crockford base32
// characters, lowercase), as `@cfo/contracts`' ID schemas accept them.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function randomId(prefix: "op" | "ckp" | "lyr"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % 32];
  return `${prefix}_${id}`;
}
