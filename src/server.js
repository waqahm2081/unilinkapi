import dotenv from 'dotenv';
dotenv.config();
import app from './app.js';
import { ensureSchemaMigrations } from './config/db.js';
import { ensureNotificationSchema } from './services/notificationService.js';

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await ensureSchemaMigrations();
    await ensureNotificationSchema();
  } catch (err) {
    console.error('Failed to run schema migrations:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
