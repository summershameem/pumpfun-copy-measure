import { createHash } from 'node:crypto';

export const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P = (1n << 255n) - 19n;
const mod = n => (n % P + P) % P;
function pow(base, exponent) {
  let result = 1n;
  for (base = mod(base); exponent; exponent >>= 1n, base = mod(base * base)) {
    if (exponent & 1n) result = mod(result * base);
  }
  return result;
}
const D = mod(-121665n * pow(121666n, P - 2n));

export function decode58(value) {
  if (typeof value !== 'string' || !value.length || value.length > 10000) throw Error('Invalid base58');
  let number = 0n;
  for (const ch of value) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw Error('Invalid base58');
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number) { bytes.push(Number(number & 255n)); number >>= 8n; }
  for (const ch of value) { if (ch !== '1') break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}

export function encode58(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let result = '';
  while (number) { result = ALPHABET[Number(number % 58n)] + result; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}

export function validAddress(value) {
  try { return typeof value === 'string' && value.length <= 44 && decode58(value).length === 32; }
  catch { return false; }
}

// Public-address derivation only: no keypair, signing, or transaction construction.
function onEd25519Curve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = y * 256n + BigInt(i === 31 ? bytes[i] & 127 : bytes[i]);
  const y2 = mod(y * y);
  const denominator = mod(D * y2 + 1n);
  if (!denominator) return false;
  const x2 = mod((y2 - 1n) * pow(denominator, P - 2n));
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}

export function programAddress(seeds, program = PROGRAM) {
  const owner = decode58(program);
  if (owner.length !== 32 || seeds.some(seed => seed.length > 32)) throw Error('Invalid PDA seeds');
  for (let bump = 255; bump >= 0; bump--) {
    const address = createHash('sha256').update(Buffer.concat([
      ...seeds, Buffer.from([bump]), owner, Buffer.from('ProgramDerivedAddress'),
    ])).digest();
    if (!onEd25519Curve(address)) return encode58(address);
  }
  throw Error('Unable to derive public account address');
}

export function curveAddress(mint) {
  if (!validAddress(mint)) throw Error('Invalid mint address');
  return programAddress([Buffer.from('bonding-curve'), decode58(mint)]);
}
