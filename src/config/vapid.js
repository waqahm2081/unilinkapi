import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(__dirname, 'vapid-keys.json');

/** Stable defaults so push works without env; override via VAPID_* in production. */
const DEFAULT_KEYS = {
  publicKey: 'BCAR-cFAtSskdE3NtOSrE2z7PkaFR9iHefLNCCWaRnNBj7gVpMLUiFrC11qvvJSUTgO-HQgk3EViWg26BjqpwgI',
  privateKey: 'h9ti1msxxj0vYUnW0MgnzYvnFLKNAEbQI49eAnaf0KQ',
};

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }

  try {
    if (fs.existsSync(KEYS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
      if (parsed?.publicKey && parsed?.privateKey) return parsed;
    }
  } catch (err) {
    console.warn('Could not read vapid-keys.json:', err.message);
  }

  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(DEFAULT_KEYS, null, 2));
  } catch {
    /* ignore write errors on read-only FS */
  }

  return DEFAULT_KEYS;
}

const keys = loadKeys();
const subject = process.env.VAPID_SUBJECT || 'mailto:admin@unilink.local';

webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;
export { webpush };
