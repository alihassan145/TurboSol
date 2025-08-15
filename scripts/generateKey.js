import crypto from 'node:crypto';

// Generate 32-byte (256-bit) hex encryption key
const key = crypto.randomBytes(32).toString('hex');
console.log(`WALLET_ENCRYPTION_KEY=${key}`);