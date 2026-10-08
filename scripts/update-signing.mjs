// The signing side of the extension's self-update (docs/extension.md §21). The extension trusts ONLY a manifest that
// carries a valid ECDSA P-256 / SHA-256 signature made with one of the private keys that belong to the public keys
// built into extension/lib/update-keys.js. The signature is the raw 64-byte r||s form (IEEE P1363), base64: that is
// what WebCrypto's verify takes, so the extension needs no DER parsing. Private keys live outside the repository
// (~/.config/interp-app/) and are never printed, logged or copied into dist/.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UPDATE_KEY_DIR = join(homedir(), '.config', 'interp-app');
export const DEFAULT_UPDATE_KEY_FILE = join(UPDATE_KEY_DIR, 'update-signing-primary.pem');
export const DEFAULT_UPDATE_BACKUP_KEY_FILE = join(UPDATE_KEY_DIR, 'update-signing-backup.pem');

const failWith = (code) => Object.assign(new Error(code), { code });

/** A fresh P-256 key pair: { privatePem (PKCS8), publicB64 (SPKI DER, base64) }. */
export function generateUpdateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** The private key object for a PEM, or UPDATE_SIGNING_KEY_INVALID: unreadable, encrypted, a public key, or not P-256. The error never carries the PEM. */
function privateKeyOf(privatePem) {
  let key;
  try { key = createPrivateKey(privatePem); } catch { throw failWith('UPDATE_SIGNING_KEY_INVALID'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw failWith('UPDATE_SIGNING_KEY_INVALID');
  return key;
}

/** The public key (SPKI DER base64) that belongs to a PKCS8 PEM private key; a key of another curve is refused like an unreadable one. */
export function publicKeyOf(privatePem) {
  return createPublicKey(privateKeyOf(privatePem)).export({ type: 'spki', format: 'der' }).toString('base64');
}

/** Signs the exact bytes of the manifest file: base64 of the 64-byte r||s signature. */
export function signUpdateManifest(manifestBytes, privatePem) {
  return sign('sha256', Buffer.from(manifestBytes), { key: privateKeyOf(privatePem), dsaEncoding: 'ieee-p1363' }).toString('base64');
}

/** The same check the extension makes (Node side, for the release script's own round trip and for tests). */
export function verifyUpdateManifest(manifestBytes, signatureB64, publicB64) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicB64, 'base64'), format: 'der', type: 'spki' });
    return verify('sha256', Buffer.from(manifestBytes), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
