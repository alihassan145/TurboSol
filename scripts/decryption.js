// decrypt-wallet.js
import crypto from "crypto";

// === Put your values here ===
const ENCRYPTED_PRIVATE_KEY =
  "a4b882a1527b9fd4d4b8fa9a75c3af58:73d964092b49b1263d289df7442da2b235aed0b26e2d4f795830dae7923a469cbb664a46c68f5a9226c9583c698665db29fb6079f09f7cd7b4241ab7d745ee4acf0dfde027cedc47b71749e2095ade1c46567881d4de30f360ddd5be2760e757"; // your stored encrypted key
const ENCRYPTION_KEY_HEX =
  "42b8382c153d2d7f312983a98ae1385111d763a0049d6dbd8959531971efb9a7"; // 32-byte hex string (64 chars)
// =============================

function decryptWallet(encrypted, encryptionKeyHex) {
  if (!encryptionKeyHex || encryptionKeyHex.length !== 64) {
    throw new Error("Encryption key must be 64 hex characters (32 bytes).");
  }

  const key = Buffer.from(encryptionKeyHex, "hex");
  const [ivHex, dataHex] = encrypted.split(":");
  if (!ivHex || !dataHex) {
    throw new Error("Invalid encrypted format. Expected ivHex:dataHex");
  }

  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return decrypted.toString("utf8"); // Base58 private key
}

// Run
const privateKeyBase58 = decryptWallet(
  ENCRYPTED_PRIVATE_KEY,
  ENCRYPTION_KEY_HEX
);
console.log("Decrypted Private Key (Base58):", privateKeyBase58);
