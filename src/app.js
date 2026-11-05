import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { UPLOADS_ROOT } from './config/uploads.js';
import authRoutes from './routes/auth.js';
import leadRoutes from './routes/LeadRoutes.js';
import staffRoutes from './routes/StaffRoutes.js';
import counselorRoutes from './routes/CounselorRoutes.js';
import studentRoutes from './routes/StudentRoutes.js';
import visitorLogRoutes from './routes/VisitorLogRoutes.js';
import countryRoutes from './routes/countryRoutes.js';
import universityRoutes from './routes/universityRoutes.js';
import intakeRoutes from './routes/intakeRoutes.js';
import ApplicationRoutes from './routes/ApplicationRoutes.js';
import VisaRoutes from './routes/VisaRoutes.js';
import VisaEnquiryRoutes from './routes/VisaEnquiryRoutes.js';
import FinanceRoutes from './routes/FinanceRoutes.js';
import employees from './routes/employees.js';
import expenses from './routes/expenses.js';
import meetingsRouter from './routes/meetings.js';
import portalRoutes from './routes/PortalRoutes.js';
import notificationRoutes from './routes/NotificationRoutes.js';

const app = express();

// Simple CORS - same domain now, but keep for local development
app.use(cors({
  origin: [
    'https://unilinkweb.cyb360.com',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!fs.existsSync(UPLOADS_ROOT)) {
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

// Serve uploaded files from persistent UPLOAD_DIR when set (Railway volume),
// otherwise backend/src/uploads. Missing files get a clear 404 (not "Route not found").
app.use('/uploads', express.static(UPLOADS_ROOT, { fallthrough: true }));
app.use('/uploads', (req, res) => {
  res.status(404).json({
    message: 'As this is a test server, files are automatically deleted after every new deployment to the server due to storage restrictions, please move to live server for permanent storage.',
    path: req.originalUrl,
  });
});

// Routes - IMPORTANT: No /api prefix here since .htaccess strips it
app.use('/auth', authRoutes);
app.use('/', staffRoutes);
app.use('/', leadRoutes);
app.use('/', counselorRoutes);
app.use('/', studentRoutes);
app.use('/', visitorLogRoutes);
app.use('/', countryRoutes);
app.use('/', universityRoutes);
app.use('/', intakeRoutes);
app.use('/', ApplicationRoutes);
app.use('/', VisaRoutes);
app.use('/', VisaEnquiryRoutes);
app.use('/', FinanceRoutes);
app.use('/', employees);
app.use('/', expenses);
app.use('/', meetingsRouter);
app.use('/', portalRoutes);
app.use('/', notificationRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

export default app;
