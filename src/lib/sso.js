import crypto from 'node:crypto';

// GHL cifra el contexto de usuario de las Custom Pages con CryptoJS AES.encrypt(json, sharedSecret),
// que produce el formato OpenSSL "Salted__": base64( "Salted__" + salt(8) + ciphertext ).
// La clave/iv se derivan con EVP_BytesToKey (MD5) a partir del passphrase (Shared Secret) + salt.
export function decryptGhlSso(encryptedBase64, sharedSecret) {
  if (!encryptedBase64 || !sharedSecret) throw new Error('faltan datos para descifrar el SSO');
  const data = Buffer.from(String(encryptedBase64), 'base64');
  if (data.length < 16 || data.subarray(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error('payload SSO con formato inesperado');
  }
  const salt = data.subarray(8, 16);
  const ciphertext = data.subarray(16);
  const { key, iv } = evpBytesToKey(Buffer.from(String(sharedSecret), 'utf8'), salt, 32, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const obj = JSON.parse(out.toString('utf8'));
  if (!obj || typeof obj !== 'object') throw new Error('payload SSO no es un objeto');
  return obj;
}

// EVP_BytesToKey (OpenSSL) con MD5, tal y como lo hace CryptoJS por defecto.
function evpBytesToKey(pass, salt, keyLen, ivLen) {
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pass, salt])).digest();
    d = Buffer.concat([d, prev]);
  }
  return { key: d.subarray(0, keyLen), iv: d.subarray(keyLen, keyLen + ivLen) };
}
