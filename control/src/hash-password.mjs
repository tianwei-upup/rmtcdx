import crypto from 'node:crypto';
const password = process.env.RMT_ADMIN_PASSWORD;
if (!password || password.length < 24) throw new Error('RMT_ADMIN_PASSWORD must contain at least 24 characters');
const salt = crypto.randomBytes(16).toString('hex');
console.log(`scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`);
