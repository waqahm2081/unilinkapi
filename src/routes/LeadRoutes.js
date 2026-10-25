import express from 'express';
import bcrypt from 'bcrypt';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pool, { ensureSchemaMigrations } from '../config/db.js';
import { claimStudentRegistrationId } from '../utils/studentRegistrationId.js';
import { qualificationsToEducationRows } from '../utils/qualificationsToEducation.js';
import { ensureUploadSubdir } from '../config/uploads.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, ensureUploadSubdir('meeting-notes'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'meeting-note-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, JPG, PNG, GIF) and PDFs are allowed'));
    }
  }
});

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

const REFERRED_BY_NAME_TRIGGERS = ['Friend or Family', 'Other', 'Person Name'];

const requiresReferredByName = (referredBy) =>
  REFERRED_BY_NAME_TRIGGERS.includes(String(referredBy || '').trim());

const generatePassword = (length = 12) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

const getRegistrationFilter = (view = 'active') => {
  if (view === 'registered') return 'l.is_registered = TRUE';
  if (view === 'all') return '1=1';
  return '(l.is_registered = FALSE OR l.is_registered IS NULL)';
};

const STUDENT_USER_ID_SQL = `(
  SELECT u.id FROM users u
  WHERE u.role = 'client'
    AND (
      u.source_lead_id = l.id
      OR (
        u.source_lead_id IS NULL
        AND LOWER(u.email) = LOWER(l.email)
        AND l.is_registered = TRUE
      )
    )
  ORDER BY u.id DESC
  LIMIT 1
)`;

const STUDENT_CODE_SQL = `(
  SELECT u.student_id FROM users u
  WHERE u.role = 'client'
    AND (
      u.source_lead_id = l.id
      OR (
        u.source_lead_id IS NULL
        AND LOWER(u.email) = LOWER(l.email)
        AND l.is_registered = TRUE
      )
    )
  ORDER BY u.id DESC
  LIMIT 1
)`;

const resolveLeadIdForStudent = async (connection, studentId, userRow = null) => {
  const db = connection || pool;
  let user = userRow;

  if (!user) {
    const [users] = await db.query(
      'SELECT id, source_lead_id, email, invoice_id FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    if (users.length === 0) return null;
    user = users[0];
  }

  if (user.source_lead_id) return user.source_lead_id;

  const [counselorLinks] = await db.query(
    `SELECT transferred_from_lead_id
     FROM student_counselors
     WHERE user_id = ? AND transferred_from_lead_id IS NOT NULL
     LIMIT 1`,
    [studentId]
  );
  if (counselorLinks.length > 0) return counselorLinks[0].transferred_from_lead_id;

  if (user.invoice_id) {
    const [invoiceLeads] = await db.query(
      'SELECT id FROM leads WHERE invoice_id = ? LIMIT 1',
      [user.invoice_id]
    );
    if (invoiceLeads.length > 0) return invoiceLeads[0].id;
  }

  const [emailLeads] = await db.query(
    `SELECT id FROM leads
     WHERE LOWER(email) = LOWER(?) AND is_registered = TRUE
     ORDER BY registered_at DESC LIMIT 1`,
    [user.email]
  );
  return emailLeads.length > 0 ? emailLeads[0].id : null;
};

const fetchLeadHistoryById = async (leadId) => {
  const [lead] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
  if (lead.length === 0) return null;

  let followUps;
  try {
    [followUps] = await pool.query(
      `SELECT fu.id, fu.lead_id, fu.follow_up_number, fu.notes, fu.followed_up_at,
              COALESCE(fu.purpose_of_visit, l.purpose_of_visit) as purpose_of_visit
       FROM follow_ups fu
       LEFT JOIN leads l ON fu.lead_id = l.id
       WHERE fu.lead_id = ?
       ORDER BY fu.followed_up_at DESC`,
      [leadId]
    );
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    [followUps] = await pool.query(
      `SELECT fu.*, l.purpose_of_visit
       FROM follow_ups fu
       LEFT JOIN leads l ON fu.lead_id = l.id
       WHERE fu.lead_id = ?
       ORDER BY fu.followed_up_at DESC`,
      [leadId]
    );
  }

  const [changes] = await pool.query(
    `SELECT lc.*, fu.follow_up_number, fu.followed_up_at
     FROM lead_changes lc
     LEFT JOIN follow_ups fu ON lc.follow_up_id = fu.id
     WHERE lc.lead_id = ?
     ORDER BY lc.changed_at DESC`,
    [leadId]
  );

  const [studentLinks] = await pool.query(
    `SELECT id, student_id FROM users
     WHERE source_lead_id = ? AND role = 'client'
     ORDER BY id DESC LIMIT 1`,
    [leadId]
  );

  return {
    lead: lead[0],
    followUps,
    changes,
    studentUserId: studentLinks[0]?.id || null,
    studentCode: studentLinks[0]?.student_id || null,
  };
};

const serializeQualifications = (qualifications) => {
  if (!Array.isArray(qualifications) || qualifications.length === 0) return null;
  const filtered = qualifications.filter(q =>
    q.level?.trim() ||
    q.qualification?.trim() ||
    q.instituteName?.trim() ||
    q.institute_name?.trim() ||
    q.percentage?.trim() ||
    q.cgpaDivision?.trim() ||
    q.subject?.trim() ||
    q.grade?.trim() ||
    (Array.isArray(q.aLevelTypes) && q.aLevelTypes.length > 0) ||
    (q.stages && typeof q.stages === 'object' && Object.keys(q.stages).length > 0) ||
    (Array.isArray(q.subjects) && q.subjects.some(s => s.subject?.trim() || s.grade?.trim()))
  );
  return filtered.length > 0 ? JSON.stringify(filtered) : null;
};

const serializeAdmissionTests = (admissionTests) => {
  if (!admissionTests || typeof admissionTests !== 'object') return null;
  return JSON.stringify(admissionTests);
};

const serializeCountries = (countriesOfInterest) => {
  if (!Array.isArray(countriesOfInterest) || countriesOfInterest.length === 0) return null;
  return JSON.stringify(countriesOfInterest);
};

const normalizeChangeValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value).trim();
    }
  }
  return String(value).trim();
};

const serializeChangeValue = (value) => {
  const normalized = normalizeChangeValue(value);
  return normalized === '' ? null : normalized;
};

const parseLeadCountries = (countriesOfInterest) => {
  if (!countriesOfInterest) return [];
  try {
    const parsed = typeof countriesOfInterest === 'string'
      ? JSON.parse(countriesOfInterest)
      : countriesOfInterest;
    return Array.isArray(parsed) ? parsed.map(c => String(c).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
};

const resolveLeadCountries = (countriesOfInterest, countriesOther) => {
  const other = (countriesOther || '').trim();
  return parseLeadCountries(countriesOfInterest)
    .map(c => (c.toLowerCase() === 'other' ? (other || null) : c))
    .filter(Boolean);
};

const invoiceStatusToLeadStatus = (invoiceStatus) => {
  if (invoiceStatus === 'Paid') return 'Paid';
  if (invoiceStatus === 'Partially Paid') return 'Partially Paid';
  return 'Unpaid';
};

const LEAD_STATUS_ENUM = {
  new: 'New',
  contacted: 'Contacted',
  in_progress: 'In Progress',
  converted: 'Converted',
  closed: 'Closed',
};

const toLeadStatusEnum = (value) => {
  if (!value) return 'new';
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return LEAD_STATUS_ENUM[normalized] ? normalized : 'new';
};

const parseCountryLabels = (value) => {
  if (!value) return [];
  return String(value).split(',').map(c => c.trim()).filter(Boolean);
};

const getInvoiceCountries = async (db, invoiceId, studentCountry, manualStudentCountry) => {
  const countries = new Map();
  const addCountry = (name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!countries.has(key)) countries.set(key, trimmed);
  };

  parseCountryLabels(studentCountry).forEach(addCountry);
  parseCountryLabels(manualStudentCountry).forEach(addCountry);

  const [rows] = await db.query(
    `SELECT DISTINCT country_name FROM invoice_country_services
     WHERE invoice_id = ? AND country_name IS NOT NULL AND TRIM(country_name) != ''`,
    [invoiceId]
  );
  rows.forEach(r => addCountry(r.country_name));

  return Array.from(countries.values());
};

// ─── DB Migration Note ────────────────────────────────────────────────────────
// Run the following ALTER statements once against your MySQL database if you
// haven't already added these columns:
//
//   ALTER TABLE leads
//     ADD COLUMN IF NOT EXISTS program      VARCHAR(100)  NULL,
//     ADD COLUMN IF NOT EXISTS grades       TEXT          NULL,
//     ADD COLUMN IF NOT EXISTS purpose_of_visit TEXT      NULL,
//     ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'Unpaid',
//     ADD COLUMN IF NOT EXISTS qualifications TEXT        NULL,
//     ADD COLUMN IF NOT EXISTS counsellor_notes TEXT      NULL,
//     ADD COLUMN IF NOT EXISTS referred_by  VARCHAR(255)  NULL,
//     ADD COLUMN IF NOT EXISTS referred_by_name VARCHAR(255) NULL,
//     ADD COLUMN IF NOT EXISTS countries_other VARCHAR(255) NULL,
//     ADD COLUMN IF NOT EXISTS admission_tests TEXT       NULL,
//     ADD COLUMN IF NOT EXISTS invoice_id INT NULL;
//     ADD COLUMN IF NOT EXISTS institute_name VARCHAR(255) NULL;
//
//   ALTER TABLE follow_ups
//     ADD COLUMN IF NOT EXISTS purpose_of_visit TEXT NULL;
//
// For the users table, ensure the following columns exist:
//   middle_name, surname, alternative_email, landline, postal_code,
//   nationality, marital_status, gender, city_of_birth, country_of_birth,
//   passport_no, passport_issue_date, passport_place_of_issue,
//   source_inquiry, payment_status VARCHAR(20) DEFAULT 'Unpaid',
//   invoice_id INT NULL  ← NEW: links the student to an invoice at registration
//
// Run GET /leads/migrate-invoice to add the invoice_id column safely.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Migrate: add invoice_id to users table ───────────────────────────────────
router.get('/leads/migrate-invoice', async (req, res) => {
  try {
    await ensureSchemaMigrations();
    res.json({ success: true, message: 'Migration applied: users.invoice_id, source_lead_id, and nullable dob are ready.' });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Invoice search for student registration ──────────────────────────────────
// GET /leads/invoices/search?q=searchTerm
// Returns invoices that are NOT yet linked to any student (invoice_id on users),
// filtered by invoice_id string, student_name, or final_amount.
// Only Student-type invoices are returned (commission invoices aren't linked to students).
router.get('/leads/invoices/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) {
      return res.json({ success: true, invoices: [] });
    }

    const searchTerm = `%${q.trim()}%`;

    const [invoices] = await pool.query(
      `SELECT 
         i.id,
         i.invoice_id,
         i.invoice_type,
         i.invoice_date,
         i.final_amount,
         i.payment_status,
         i.student_name,
         i.student_ref_id,
         i.is_manual_student,
         i.manual_student_name,
         ba.bank_name,
         ba.account_name
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       WHERE i.invoice_type = 'Student'
         AND i.id NOT IN (
           SELECT invoice_id FROM users WHERE invoice_id IS NOT NULL
         )
         AND (
           i.invoice_id LIKE ?
           OR i.student_name LIKE ?
           OR i.manual_student_name LIKE ?
           OR i.student_ref_id LIKE ?
           OR CAST(i.final_amount AS CHAR) LIKE ?
         )
       ORDER BY i.created_at DESC
       LIMIT 20`,
      [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]
    );

    res.json({ success: true, invoices });
  } catch (error) {
    console.error('Error searching invoices:', error);
    res.status(500).json({ success: false, message: 'Failed to search invoices' });
  }
});

// Create new lead (First Time Query)
router.post('/leads', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      fullName, email, phone, address,
      interest, program, instituteName,
      countriesOfInterest, countriesOther,
      qualifications, referredBy, referredByName, counsellorNotes, admissionTests
    } = req.body;
    
    if (!fullName || !email || !phone || !address || !interest || !referredBy?.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }
    if (requiresReferredByName(referredBy) && !referredByName?.trim()) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Referred By (Name) is required when Friend or Family or Other is selected'
      });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();
   

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Full name must be at least 3 characters long' });
    }

    if (address.trim().length < 10) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a complete address (minimum 10 characters)' });
    }
    
    const [existingLead] = await connection.query(
      'SELECT id, full_name, email FROM leads WHERE email = ?',
      [trimmedEmail]
    );
    
    if (existingLead.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'A lead with this email address already exists. Please use the Follow Up option to update your information.',
        existingLead: { name: existingLead[0].full_name, email: existingLead[0].email }
      });
    }

    const countriesJson = serializeCountries(countriesOfInterest);
    const qualificationsJson = serializeQualifications(qualifications);
    const admissionTestsJson = serializeAdmissionTests(admissionTests);
    
    let result;
    try {
      [result] = await connection.query(
        `INSERT INTO leads
           (full_name, email, phone, address, interest, program, institute_name,
            countries_of_interest, countries_other, qualifications,
            referred_by, referred_by_name, counsellor_notes, admission_tests, is_follow_up, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, 'New')`,
        [
          trimmedName, trimmedEmail, trimmedPhone, address.trim(),
          interest.trim(), program?.trim() || null, instituteName?.trim() || null,
          countriesJson, countriesOther?.trim() || null, qualificationsJson,
          referredBy?.trim() || null, referredByName?.trim() || null, counsellorNotes?.trim() || null,
          admissionTestsJson
        ]
      );
    } catch (insertErr) {
      if (insertErr.code !== 'ER_BAD_FIELD_ERROR') throw insertErr;
      [result] = await connection.query(
        `INSERT INTO leads
           (full_name, email, phone, address, interest, program,
            countries_of_interest, countries_other, qualifications,
            referred_by, counsellor_notes, admission_tests, is_follow_up, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, 'New')`,
        [
          trimmedName, trimmedEmail, trimmedPhone, address.trim(),
          interest.trim(), program?.trim() || null,
          countriesJson, countriesOther?.trim() || null, qualificationsJson,
          referredBy?.trim() || null, counsellorNotes?.trim() || null,
          admissionTestsJson
        ]
      );
    }
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Your Form has been submitted successfully!',
      leadId: result.insertId
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating lead:', error);
    res.status(500).json({ success: false, message: 'An error occurred while submitting your registration. Please try again later.' });
  } finally {
    connection.release();
  }
});

// Lookup lead for follow-up
router.post('/leads/lookup', async (req, res) => {
  try {
    const { lookupName, lookupEmail, lookupPhone, purposeOfVisit } = req.body;
    
    if (!lookupName) {
      return res.status(400).json({ success: false, message: 'Full name is required to lookup your information' });
    }

    const hasEmail = lookupEmail && lookupEmail.trim().length > 0;
    const hasPhone = lookupPhone && lookupPhone.trim().length > 0;

    if (!hasEmail && !hasPhone) {
      return res.status(400).json({ success: false, message: 'Please provide either an email address or phone number' });
    }

    const trimmedName = lookupName.trim();

    if (hasEmail && !validateEmail(lookupEmail.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (hasPhone && !validatePhone(lookupPhone.trim())) {
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    if (!purposeOfVisit || !purposeOfVisit.trim()) {
      return res.status(400).json({ success: false, message: 'Purpose of visit is required' });
    }

    let whereClause = 'LOWER(TRIM(full_name)) = LOWER(?)';
    const queryParams = [trimmedName];

    if (hasEmail && hasPhone) {
      whereClause += ' AND (LOWER(TRIM(email)) = LOWER(?) OR REPLACE(REPLACE(REPLACE(phone, " ", ""), "-", ""), "+", "") LIKE ?)';
      const normalizedPhone = '%' + lookupPhone.trim().replace(/\D/g, '');
      queryParams.push(lookupEmail.trim().toLowerCase(), normalizedPhone);
    } else if (hasEmail) {
      whereClause += ' AND LOWER(TRIM(email)) = LOWER(?)';
      queryParams.push(lookupEmail.trim().toLowerCase());
    } else {
      whereClause += ' AND REPLACE(REPLACE(REPLACE(phone, " ", ""), "-", ""), "+", "") LIKE ?';
      const normalizedPhone = '%' + lookupPhone.trim().replace(/\D/g, '');
      queryParams.push(normalizedPhone);
    }
    
    let leads;
    try {
      [leads] = await pool.query(
        `SELECT id, full_name, email, phone, address, interest, program, institute_name, comments,
                countries_of_interest, countries_other, grades, qualification, qualifications,
                referred_by, referred_by_name, counsellor_notes, admission_tests,
                (SELECT COUNT(*) FROM follow_ups WHERE lead_id = leads.id) as follow_up_count,
                created_at, updated_at
         FROM leads 
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT 1`,
        queryParams
      );
    } catch (lookupErr) {
      if (lookupErr.code !== 'ER_BAD_FIELD_ERROR') throw lookupErr;
      [leads] = await pool.query(
        `SELECT id, full_name, email, phone, address, interest, program, comments,
                countries_of_interest, countries_other, grades, qualification, qualifications,
                referred_by, counsellor_notes, admission_tests,
                (SELECT COUNT(*) FROM follow_ups WHERE lead_id = leads.id) as follow_up_count,
                created_at, updated_at
         FROM leads 
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT 1`,
        queryParams
      );
    }
    
    if (leads.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No record found with the provided details. Please check your information or submit a new registration.' 
      });
    }

    await pool.query(
      'UPDATE leads SET purpose_of_visit = ? WHERE id = ?',
      [purposeOfVisit.trim(), leads[0].id]
    );
    
    res.json({
      success: true,
      message: 'Your information has been retrieved successfully',
      lead: leads[0]
    });
    
  } catch (error) {
    console.error('Error looking up lead:', error);
    res.status(500).json({ success: false, message: 'An error occurred while looking up your information. Please try again later.' });
  }
});

// Create follow-up and track changes
router.post('/leads/:leadId/follow-up', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const {
      fullName, email, phone, address,
      interest, program, instituteName,
      countriesOfInterest, countriesOther,
      qualifications, referredBy, referredByName, counsellorNotes, admissionTests,
      purposeOfVisit,
      recordOnly
    } = req.body;

    // Record-only: log the visit without editing lead fields
    if (recordOnly) {
      const [currentLead] = await connection.query('SELECT id, purpose_of_visit FROM leads WHERE id = ?', [leadId]);
      if (currentLead.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Lead record not found' });
      }

      const [followUpCount] = await connection.query(
        'SELECT COUNT(*) as count FROM follow_ups WHERE lead_id = ?',
        [leadId]
      );
      const nextFollowUpNumber = followUpCount[0].count + 1;
      const purpose = purposeOfVisit?.trim() || null;

      try {
        await connection.query(
          'INSERT INTO follow_ups (lead_id, follow_up_number, notes, purpose_of_visit) VALUES (?, ?, ?, ?)',
          [leadId, nextFollowUpNumber, `Follow-up #${nextFollowUpNumber}`, purpose]
        );
      } catch (insertErr) {
        if (insertErr.code !== 'ER_BAD_FIELD_ERROR') throw insertErr;
        await connection.query(
          'INSERT INTO follow_ups (lead_id, follow_up_number, notes) VALUES (?, ?, ?)',
          [leadId, nextFollowUpNumber, `Follow-up #${nextFollowUpNumber}`]
        );
      }

      try {
        await connection.query(
          'UPDATE leads SET purpose_of_visit = ?, is_follow_up = TRUE WHERE id = ?',
          [purpose || currentLead[0].purpose_of_visit || null, leadId]
        );
      } catch (updateErr) {
        if (updateErr.code !== 'ER_BAD_FIELD_ERROR') throw updateErr;
        await connection.query(
          'UPDATE leads SET is_follow_up = TRUE WHERE id = ?',
          [leadId]
        );
      }

      await connection.commit();
      return res.json({
        success: true,
        message: 'Follow-up recorded successfully!',
        followUpNumber: nextFollowUpNumber
      });
    }
    
    if (!fullName || !email || !phone || !address || !interest) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Full name must be at least 3 characters long' });
    }

    if (address.trim().length < 10) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a complete address (minimum 10 characters)' });
    }
    
    const [currentLead] = await connection.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    
    if (currentLead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead record not found' });
    }
    
    const oldData = currentLead[0];

    if (trimmedEmail !== oldData.email.toLowerCase()) {
      const [emailCheck] = await connection.query(
        'SELECT id FROM leads WHERE email = ? AND id != ?',
        [trimmedEmail, leadId]
      );
      if (emailCheck.length > 0) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: 'This email address is already associated with another record. Please use a different email.' });
      }
    }
    
    const [followUpCount] = await connection.query(
      'SELECT COUNT(*) as count FROM follow_ups WHERE lead_id = ?',
      [leadId]
    );
    
    const nextFollowUpNumber = followUpCount[0].count + 1;
    
    let followUpResult;
    try {
      [followUpResult] = await connection.query(
        'INSERT INTO follow_ups (lead_id, follow_up_number, notes, purpose_of_visit) VALUES (?, ?, ?, ?)',
        [
          leadId,
          nextFollowUpNumber,
          `Follow-up #${nextFollowUpNumber} - Updated information`,
          purposeOfVisit?.trim() || null
        ]
      );
    } catch (insertErr) {
      // Fallback if purpose_of_visit column is not yet migrated
      if (insertErr.code === 'ER_BAD_FIELD_ERROR') {
        [followUpResult] = await connection.query(
          'INSERT INTO follow_ups (lead_id, follow_up_number, notes) VALUES (?, ?, ?)',
          [leadId, nextFollowUpNumber, `Follow-up #${nextFollowUpNumber} - Updated information`]
        );
      } else {
        throw insertErr;
      }
    }
    
    const followUpId = followUpResult.insertId;

    const countriesJson = serializeCountries(countriesOfInterest);
    const qualificationsJson = serializeQualifications(qualifications);
    const admissionTestsJson = serializeAdmissionTests(admissionTests);
    
    const changes = [];
    const fieldsToTrack = {
      fullName: 'full_name',
      email: 'email',
      phone: 'phone',
      address: 'address',
      interest: 'interest',
      program: 'program',
      instituteName: 'institute_name',
      counsellorNotes: 'counsellor_notes',
      countriesOfInterest: 'countries_of_interest',
      countriesOther: 'countries_other',
      qualifications: 'qualifications',
      referredBy: 'referred_by',
      referredByName: 'referred_by_name',
      admissionTests: 'admission_tests'
    };

    const newValues = {
      fullName: trimmedName,
      email: trimmedEmail,
      phone: trimmedPhone,
      address: address.trim(),
      interest: interest.trim(),
      program: program?.trim() || null,
      instituteName: instituteName?.trim() || null,
      counsellorNotes: counsellorNotes?.trim() || null,
      countriesOfInterest: countriesJson,
      countriesOther: countriesOther?.trim() || null,
      qualifications: qualificationsJson,
      referredBy: referredBy?.trim() || null,
      referredByName: referredByName?.trim() || null,
      admissionTests: admissionTestsJson
    };
    
    for (const [requestField, dbField] of Object.entries(fieldsToTrack)) {
      const newValue = newValues[requestField];
      const oldValue = oldData[dbField];
      const oldVal = normalizeChangeValue(oldValue);
      const newVal = normalizeChangeValue(newValue);
      if (newVal !== oldVal) {
        changes.push([
          leadId,
          followUpId,
          dbField,
          serializeChangeValue(oldValue),
          serializeChangeValue(newValue)
        ]);
      }
    }
    
    if (changes.length > 0) {
      await connection.query(
        `INSERT INTO lead_changes (lead_id, follow_up_id, field_name, old_value, new_value) VALUES ?`,
        [changes]
      );
    }
    
    try {
      await connection.query(
        `UPDATE leads 
         SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, program = ?, institute_name = ?,
             countries_of_interest = ?, countries_other = ?, qualifications = ?,
             referred_by = ?, referred_by_name = ?, counsellor_notes = ?, admission_tests = ?,
             purpose_of_visit = ?, is_follow_up = TRUE
         WHERE id = ?`,
        [
          trimmedName, trimmedEmail, trimmedPhone, address.trim(),
          interest.trim(), program?.trim() || null, instituteName?.trim() || null,
          countriesJson, countriesOther?.trim() || null, qualificationsJson,
          referredBy?.trim() || null, referredByName?.trim() || null, counsellorNotes?.trim() || null,
          admissionTestsJson,
          purposeOfVisit?.trim() || oldData.purpose_of_visit || null,
          leadId
        ]
      );
    } catch (updateErr) {
      if (updateErr.code !== 'ER_BAD_FIELD_ERROR') throw updateErr;
      await connection.query(
        `UPDATE leads 
         SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, program = ?,
             countries_of_interest = ?, countries_other = ?, qualifications = ?,
             referred_by = ?, counsellor_notes = ?, admission_tests = ?,
             purpose_of_visit = ?, is_follow_up = TRUE
         WHERE id = ?`,
        [
          trimmedName, trimmedEmail, trimmedPhone, address.trim(),
          interest.trim(), program?.trim() || null,
          countriesJson, countriesOther?.trim() || null, qualificationsJson,
          referredBy?.trim() || null, counsellorNotes?.trim() || null,
          admissionTestsJson,
          purposeOfVisit?.trim() || oldData.purpose_of_visit || null,
          leadId
        ]
      );
    }
    
    await connection.commit();
    
    res.json({ success: true, message: 'Follow-up recorded successfully!', followUpNumber: nextFollowUpNumber });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating follow-up:', error);
    res.status(500).json({ success: false, message: 'An error occurred while submitting your follow-up. Please try again later.' });
  } finally {
    connection.release();
  }
});

// Get lead history with all follow-ups and changes
router.get('/leads/:leadId/history', async (req, res) => {
  try {
    const { leadId } = req.params;
    const history = await fetchLeadHistoryById(leadId);
    if (!history) return res.status(404).json({ success: false, message: 'Lead not found' });
    res.json({ success: true, ...history });
  } catch (error) {
    console.error('Error fetching lead history:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch lead history' });
  }
});

// Get all follow-up entries (one row per follow-up visit)
router.get('/leads/followups', async (req, res) => {
  try {
    const view = req.query.view || 'active';
    const registrationFilter = getRegistrationFilter(view);

    let followups;
    try {
      [followups] = await pool.query(
        `SELECT fu.id as follow_up_id,
                fu.follow_up_number,
                fu.followed_up_at as last_follow_up,
                fu.notes,
                COALESCE(fu.purpose_of_visit, l.purpose_of_visit) as purpose_of_visit,
                l.id,
                l.full_name,
                l.phone,
                l.email,
                l.is_registered,
                l.registered_at,
                ${STUDENT_USER_ID_SQL} as student_user_id,
                ${STUDENT_CODE_SQL} as student_code
         FROM follow_ups fu
         INNER JOIN leads l ON l.id = fu.lead_id
         WHERE ${registrationFilter}
         ORDER BY fu.followed_up_at DESC`
      );
    } catch (queryErr) {
      // Fallback if follow_ups.purpose_of_visit column is not yet migrated
      if (queryErr.code !== 'ER_BAD_FIELD_ERROR') throw queryErr;
      [followups] = await pool.query(
        `SELECT fu.id as follow_up_id,
                fu.follow_up_number,
                fu.followed_up_at as last_follow_up,
                fu.notes,
                l.purpose_of_visit as purpose_of_visit,
                l.id,
                l.full_name,
                l.phone,
                l.email,
                l.is_registered,
                l.registered_at,
                ${STUDENT_USER_ID_SQL} as student_user_id,
                ${STUDENT_CODE_SQL} as student_code
         FROM follow_ups fu
         INNER JOIN leads l ON l.id = fu.lead_id
         WHERE ${registrationFilter}
         ORDER BY fu.followed_up_at DESC`
      );
    }

    const [registeredCountRows] = await pool.query(
      `SELECT COUNT(DISTINCT l.id) as total
       FROM leads l
       INNER JOIN follow_ups fu ON l.id = fu.lead_id
       WHERE l.is_registered = TRUE`
    );

    res.json({
      success: true,
      followups,
      total: followups.length,
      view,
      registeredCount: registeredCountRows[0]?.total || 0,
    });
  } catch (error) {
    console.error('Error fetching follow-ups:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch follow-ups' });
  }
});

// Get all leads
router.get('/leads', async (req, res) => {
  try {
    const view = req.query.view || 'active';
    const registrationFilter = getRegistrationFilter(view);
    const orderBy = view === 'registered'
      ? 'l.registered_at DESC'
      : 'l.created_at DESC';

    const [leads] = await pool.query(
      `SELECT l.*,
              COUNT(DISTINCT fu.id) as follow_up_count,
              MAX(fu.followed_up_at) as last_follow_up,
              COUNT(DISTINCT lca.counselor_id) as counselor_count,
              ${STUDENT_USER_ID_SQL} as student_user_id,
              ${STUDENT_CODE_SQL} as student_code
       FROM leads l
       LEFT JOIN follow_ups fu ON l.id = fu.lead_id
       LEFT JOIN lead_counselor_assignments lca ON l.id = lca.lead_id
       WHERE ${registrationFilter}
       GROUP BY l.id
       ORDER BY ${orderBy}`
    );

    const [registeredCountRows] = await pool.query(
      'SELECT COUNT(*) as total FROM leads WHERE is_registered = TRUE'
    );

    res.json({
      success: true,
      leads,
      total: leads.length,
      view,
      registeredCount: registeredCountRows[0]?.total || 0,
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch leads' });
  }
});

// Get single lead by ID
router.get('/leads/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [leads] = await pool.query(
      `SELECT l.*,
              COUNT(DISTINCT fu.id) as follow_up_count,
              MAX(fu.followed_up_at) as last_follow_up,
              ${STUDENT_USER_ID_SQL} as student_user_id,
              ${STUDENT_CODE_SQL} as student_code
       FROM leads l
       LEFT JOIN follow_ups fu ON l.id = fu.lead_id
       WHERE l.id = ?
       GROUP BY l.id`,
      [leadId]
    );
    if (leads.length === 0) return res.status(404).json({ success: false, message: 'Lead not found' });
    res.json({ success: true, lead: leads[0] });
  } catch (error) {
    console.error('Error fetching lead:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch lead' });
  }
});

// Update lead information
router.put('/leads/:leadId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { leadId } = req.params;
    const {
      fullName, email, phone, address,
      interest, program, instituteName, comments, counsellorNotes,
      status, countriesOfInterest, countriesOther,
      grades, qualification, qualifications,
      referredBy, referredByName, admissionTests
    } = req.body;
    
    if (!fullName || !email || !phone || !address || !interest || !referredBy?.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }
    if (requiresReferredByName(referredBy) && !referredByName?.trim()) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Referred By (Name) is required when Friend or Family or Other is selected'
      });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    const trimmedPhone = phone.trim();
   

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (minimum 10 digits)' });
    }

    const [existingLead] = await connection.query('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (existingLead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const [emailCheck] = await connection.query('SELECT id FROM leads WHERE email = ? AND id != ?', [trimmedEmail, leadId]);
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This email address is already associated with another lead' });
    }

    const countriesJson = serializeCountries(countriesOfInterest);
    const qualificationsJson = qualifications
      ? serializeQualifications(qualifications)
      : (qualification?.trim() || grades?.trim()
        ? JSON.stringify([{ qualification: qualification?.trim() || '', subject: '', grade: grades?.trim() || '' }])
        : null);
    const notesValue = counsellorNotes?.trim() || comments?.trim() || null;
    const admissionTestsJson = serializeAdmissionTests(admissionTests);
    const statusValue = toLeadStatusEnum(status);
    
    try {
      await connection.query(
        `UPDATE leads 
         SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, program = ?, institute_name = ?,
             counsellor_notes = ?, status = ?, countries_of_interest = ?, countries_other = ?,
             qualifications = ?, referred_by = ?, referred_by_name = ?, admission_tests = ?
         WHERE id = ?`,
        [
          trimmedName, trimmedEmail, trimmedPhone, address.trim(),
          interest.trim(), program?.trim() || null, instituteName?.trim() || null,
          notesValue, statusValue,
          countriesJson, countriesOther?.trim() || null,
          qualificationsJson, referredBy?.trim() || null, referredByName?.trim() || null,
          admissionTestsJson,
          leadId
        ]
      );
    } catch (updateErr) {
      if (updateErr.code !== 'ER_BAD_FIELD_ERROR') throw updateErr;
      await connection.query(
        `UPDATE leads 
         SET full_name = ?, email = ?, phone = ?, address = ?, interest = ?, program = ?,
             counsellor_notes = ?, status = ?, countries_of_interest = ?, countries_other = ?,
             qualifications = ?, referred_by = ?, admission_tests = ?
         WHERE id = ?`,
        [
          trimmedName, trimmedEmail, trimmedPhone, address.trim(),
          interest.trim(), program?.trim() || null,
          notesValue, statusValue,
          countriesJson, countriesOther?.trim() || null,
          qualificationsJson, referredBy?.trim() || null,
          admissionTestsJson,
          leadId
        ]
      );
    }
    
    await connection.commit();
    res.json({ success: true, message: 'Lead updated successfully' });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating lead:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the lead' });
  } finally {
    connection.release();
  }
});

const runOptionalQuery = async (connection, sql, params = []) => {
  try {
    await connection.query(sql, params);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_TABLE_ERROR') {
      throw err;
    }
  }
};

router.delete('/leads/:leadId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { leadId } = req.params;

    const [existingLead] = await connection.query(
      'SELECT id, full_name FROM leads WHERE id = ?',
      [leadId]
    );
    if (existingLead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    await runOptionalQuery(connection, 'DELETE FROM lead_changes WHERE lead_id = ?', [leadId]);
    await runOptionalQuery(connection, 'DELETE FROM follow_ups WHERE lead_id = ?', [leadId]);
    await runOptionalQuery(connection, 'DELETE FROM lead_counselor_assignments WHERE lead_id = ?', [leadId]);
    await runOptionalQuery(
      connection,
      'DELETE FROM counselor_meetings WHERE lead_id = ? AND user_id IS NULL',
      [leadId]
    );
    await runOptionalQuery(
      connection,
      'UPDATE counselor_meetings SET lead_id = NULL WHERE lead_id = ?',
      [leadId]
    );
    await runOptionalQuery(
      connection,
      'UPDATE users SET source_lead_id = NULL WHERE source_lead_id = ?',
      [leadId]
    );
    await runOptionalQuery(
      connection,
      'UPDATE student_counselors SET transferred_from_lead_id = NULL WHERE transferred_from_lead_id = ?',
      [leadId]
    );

    const [result] = await connection.query('DELETE FROM leads WHERE id = ?', [leadId]);
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    await connection.commit();
    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting lead:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the lead' });
  } finally {
    connection.release();
  }
});

// ─── Lead invoices (match by email only) ─────────────────────────────────────
router.get('/leads/:leadId/invoices', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [leads] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    if (leads.length === 0) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const lead = leads[0];
    const leadEmail = (lead.email || '').trim().toLowerCase();
    if (!leadEmail) {
      return res.status(400).json({ success: false, message: 'Lead email is required to match invoices' });
    }

    const leadCountries = resolveLeadCountries(lead.countries_of_interest, lead.countries_other);

    const [invoices] = await pool.query(
      `SELECT i.id, i.invoice_id, i.invoice_type, i.invoice_date, i.due_date,
              i.student_name, i.student_email, i.manual_student_name, i.manual_student_email,
              i.student_country, i.manual_student_country, i.final_amount, i.payment_status, i.paid_amount, i.payment_date,
              i.is_manual_student, i.created_at
       FROM invoices i
       WHERE i.invoice_type = 'Student'
         AND (
           LOWER(TRIM(i.student_email)) = ?
           OR LOWER(TRIM(i.manual_student_email)) = ?
         )
       ORDER BY i.created_at DESC`,
      [leadEmail, leadEmail]
    );

    const enriched = [];
    for (const inv of invoices) {
      const invoiceCountries = await getInvoiceCountries(
        pool, inv.id, inv.student_country, inv.manual_student_country
      );

      const [linkedUser] = await pool.query(
        'SELECT id FROM users WHERE invoice_id = ? LIMIT 1',
        [inv.id]
      );
      const [linkedLead] = await pool.query(
        'SELECT id FROM leads WHERE invoice_id = ? AND id != ? LIMIT 1',
        [inv.id, leadId]
      );

      enriched.push({
        ...inv,
        invoice_countries: invoiceCountries,
        countries_match: true,
        is_linked_to_lead: lead.invoice_id === inv.id,
        is_linked_to_student: linkedUser.length > 0,
        is_linked_to_other_lead: linkedLead.length > 0
      });
    }

    let linkedInvoice = null;
    if (lead.invoice_id) {
      linkedInvoice = enriched.find(i => i.id === lead.invoice_id) || null;
      if (!linkedInvoice) {
        const [rows] = await pool.query(
          `SELECT id, invoice_id, invoice_type, invoice_date, final_amount,
                  payment_status, paid_amount, payment_date, student_country, manual_student_country
           FROM invoices WHERE id = ?`,
          [lead.invoice_id]
        );
        if (rows.length > 0) {
          const invoiceCountries = await getInvoiceCountries(
            pool, rows[0].id, rows[0].student_country, rows[0].manual_student_country
          );
          linkedInvoice = {
            ...rows[0],
            invoice_countries: invoiceCountries,
            countries_match: true,
            is_linked_to_lead: true
          };
        }
      }
    }

    res.json({
      success: true,
      leadCountries,
      paymentStatus: lead.payment_status || 'Unpaid',
      linkedInvoiceId: lead.invoice_id || null,
      linkedInvoice,
      invoices: enriched
    });
  } catch (error) {
    console.error('Error fetching lead invoices:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoices for lead' });
  }
});

// ─── Link invoice + sync lead payment status ─────────────────────────────────
router.put('/leads/:leadId/payment', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { leadId } = req.params;
    const { invoiceId } = req.body;

    if (!invoiceId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Invoice is required' });
    }

    const [leads] = await connection.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    if (leads.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    const lead = leads[0];

    const [invoices] = await connection.query(
      `SELECT * FROM invoices WHERE id = ? AND invoice_type = 'Student'`,
      [invoiceId]
    );
    if (invoices.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student invoice not found' });
    }
    const invoice = invoices[0];

    const leadEmail = (lead.email || '').trim().toLowerCase();
    const invoiceEmails = [
      (invoice.student_email || '').trim().toLowerCase(),
      (invoice.manual_student_email || '').trim().toLowerCase()
    ].filter(Boolean);
    if (!invoiceEmails.includes(leadEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Invoice email does not match this lead' });
    }

    const [linkedUser] = await connection.query(
      'SELECT id FROM users WHERE invoice_id = ? LIMIT 1',
      [invoiceId]
    );
    if (linkedUser.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This invoice is already linked to a student profile' });
    }

    const [linkedOtherLead] = await connection.query(
      'SELECT id FROM leads WHERE invoice_id = ? AND id != ? LIMIT 1',
      [invoiceId, leadId]
    );
    if (linkedOtherLead.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This invoice is already linked to another lead' });
    }

    const leadPaymentStatus = invoiceStatusToLeadStatus(invoice.payment_status);

    await connection.query(
      'UPDATE leads SET invoice_id = ?, payment_status = ? WHERE id = ?',
      [invoiceId, leadPaymentStatus, leadId]
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'Payment status updated',
      paymentStatus: leadPaymentStatus,
      invoice
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating lead payment:', error);
    res.status(500).json({ success: false, message: 'Failed to update lead payment status' });
  } finally {
    connection.release();
  }
});

// ─── Register lead as student ─────────────────────────────────────────────────
// Accepts `applicantInfo`, `paymentStatus`, and optionally `invoiceId`.
// If invoiceId is provided, it is linked to the newly created user record.
// An invoice can only be linked to one student (enforced via DB + backend check).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/leads/:leadId/register-student', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await ensureSchemaMigrations();
    await connection.beginTransaction();
    const { leadId } = req.params;
    const { applicantInfo = {}, studentId: requestedStudentId } = req.body;

    const [leads] = await connection.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    if (leads.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    const lead = leads[0];

    const leadPaymentStatus = lead.payment_status || 'Unpaid';
    if (!['Paid', 'Partially Paid'].includes(leadPaymentStatus)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Payment must be Partially Paid or Paid before registering the student.'
      });
    }

    const invoiceId = lead.invoice_id || null;

    const nameParts = (lead.full_name || '').trim().split(/\s+/).filter(Boolean);
    const resolvedCountries = resolveLeadCountries(lead.countries_of_interest, lead.countries_other);
    const countryFromLead = resolvedCountries.length ? resolvedCountries.join(', ') : null;

    const leadDefaults = {
      name: nameParts[0] || '',
      middle_name: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
      surname: nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
      email: lead.email || '',
      mobile: lead.phone || '',
      address: lead.address || '',
      country: countryFromLead,
      course: lead.interest || lead.course || '',
      program: lead.program || '',
      source_inquiry: lead.referred_by || '',
      status: 'Active',
    };

    const mergedInfo = { ...leadDefaults, ...applicantInfo };

    const {
      name, middle_name, surname,
      nationality, marital_status, gender,
      dob, city_of_birth, country_of_birth,
      passport_no, passport_issue_date, passport_place_of_issue,
      address, postal_code, country,
      email, alternative_email,
      mobile, landline,
      course, program, source_inquiry,
      status: studentStatus,
    } = mergedInfo;

    if (!name || !name.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'First name is required.' });
    }
    if (!surname || !surname.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Last name is required.' });
    }
    if (!mobile || !mobile.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Mobile number is required.' });
    }
    if (!address || !address.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Address is required.' });
    }

    if (lead.is_registered) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'This lead is already registered as a student' });
    }

    if (invoiceId) {
      const [invCheck] = await connection.query(
        'SELECT id, invoice_type FROM invoices WHERE id = ?',
        [invoiceId]
      );
      if (invCheck.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Linked invoice not found.' });
      }
      const [alreadyLinked] = await connection.query(
        'SELECT id FROM users WHERE invoice_id = ?',
        [invoiceId]
      );
      if (alreadyLinked.length > 0) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: 'This invoice is already linked to another student.' });
      }
    }

    // Use applicantInfo.email if provided, else fall back to lead email
    const registrationEmail = (email && email.trim())
      ? email.trim().toLowerCase()
      : lead.email;

    const [existingUser] = await connection.query(
      'SELECT id FROM users WHERE email = ?', [registrationEmail]
    );
    if (existingUser.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A user with this email already exists in the system' });
    }

    let studentId;
    try {
      studentId = await claimStudentRegistrationId(connection, requestedStudentId);
    } catch (idErr) {
      await connection.rollback();
      return res.status(idErr.statusCode || 400).json({ success: false, message: idErr.message });
    }

    // ── Create password ───────────────────────────────────────────────────────
    const generatedPassword = generatePassword(12);
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);

    // ── Format dates ──────────────────────────────────────────────────────────
    const formattedDob = dob ? dob.split('T')[0] : null;
    const formattedPassportDate = passport_issue_date
      ? passport_issue_date.split('T')[0]
      : null;

    // ── Insert user with full applicant info ──────────────────────────────────
    // invoice_id column is added by GET /leads/migrate-invoice
    const admissionTestsJson = lead.admission_tests
      ? (typeof lead.admission_tests === 'string'
          ? lead.admission_tests
          : JSON.stringify(lead.admission_tests))
      : null;

    try {
      await connection.query(`ALTER TABLE users ADD COLUMN program VARCHAR(100) NULL`);
    } catch (err) {
      if (!String(err.message || '').includes('Duplicate column')) {
        console.warn('users.program ensure:', err.message);
      }
    }

    const [userResult] = await connection.query(
      `INSERT INTO users 
         (student_id, name, middle_name, surname,
          email, alternative_email,
          mobile, landline,
          address, postal_code, country,
          nationality, marital_status, gender,
          dob, city_of_birth, country_of_birth,
          passport_no, passport_issue_date, passport_place_of_issue,
          course, program, source_inquiry,
          payment_status,
          invoice_id,
          source_lead_id,
          admission_tests,
          password, plain_password, role, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', ?)`,
      [
        studentId,
        name.trim(),
        middle_name?.trim() || null,
        surname.trim(),
        registrationEmail,
        alternative_email?.trim() || null,
        mobile.trim(),
        landline?.trim() || null,
        address.trim(),
        postal_code?.trim() || null,
        country?.trim() || null,
        nationality?.trim() || null,
        marital_status || null,
        gender || null,
        formattedDob,
        city_of_birth?.trim() || null,
        country_of_birth?.trim() || null,
        passport_no?.trim() || null,
        formattedPassportDate,
        passport_place_of_issue?.trim() || null,
        course?.trim() || null,
        program?.trim() || null,
        source_inquiry || null,
        leadPaymentStatus,
        invoiceId || null,
        leadId,
        admissionTestsJson,
        hashedPassword,
        generatedPassword,
        studentStatus || 'Active',
      ]
    );
    const userId = userResult.insertId;

    const educationRows = qualificationsToEducationRows(lead.qualifications);
    if (educationRows.length > 0) {
      await connection.query(
        `INSERT INTO student_education (student_id, education_level, institute_name, start_date, end_date, subjects, result)
         VALUES ?`,
        [educationRows.map(row => [
          userId,
          row.education_level,
          row.institute_name,
          row.start_date,
          row.end_date,
          row.subjects,
          row.result
        ])]
      );
    }

    // ── Transfer assigned counselors ──────────────────────────────────────────
    const [assignedCounselors] = await connection.query(
      'SELECT counselor_id FROM lead_counselor_assignments WHERE lead_id = ?', [leadId]
    );
    if (assignedCounselors.length > 0) {
      const studentCounselorValues = assignedCounselors.map(c => [userId, c.counselor_id, leadId]);
      await connection.query(
        'INSERT INTO student_counselors (user_id, counselor_id, transferred_from_lead_id) VALUES ?',
        [studentCounselorValues]
      );
    }

    // ── Transfer meetings ─────────────────────────────────────────────────────
    await connection.query(
      'UPDATE counselor_meetings SET user_id = ?, lead_id = NULL WHERE lead_id = ?',
      [userId, leadId]
    );

    // ── Mark lead as registered and store payment status ──────────────────────
    await connection.query(
      'UPDATE leads SET is_registered = TRUE, registered_at = NOW(), payment_status = ? WHERE id = ?',
      [leadPaymentStatus, leadId]
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'Lead successfully registered as student',
      userId,
      studentId,
      counselorsTransferred: assignedCounselors.length,
      invoiceLinked: !!invoiceId,
      credentials: { email: registrationEmail, password: generatedPassword }
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error registering lead as student:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'This Registration ID is already in use. Please enter a unique ID.' });
    }
    res.status(500).json({ success: false, message: 'An error occurred while registering the student' });
  } finally {
    connection.release();
  }
});

// ============ COUNSELOR ASSIGNMENT ENDPOINTS ============

router.get('/leads/:leadId/counselors', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [counselors] = await pool.query(
      `SELECT c.*, lca.assigned_at, lca.notes as assignment_notes
       FROM counselors c
       INNER JOIN lead_counselor_assignments lca ON c.id = lca.counselor_id
       WHERE lca.lead_id = ? ORDER BY lca.assigned_at DESC`,
      [leadId]
    );
    res.json({ success: true, counselors });
  } catch (error) {
    console.error('Error fetching lead counselors:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch assigned counselors' });
  }
});

router.post('/leads/:leadId/assign-counselor', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { leadId } = req.params;
    const { counselorId, notes } = req.body;
    if (!counselorId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Counselor ID is required' });
    }
    const [lead] = await connection.query('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (lead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    const [counselor] = await connection.query('SELECT id FROM counselors WHERE id = ?', [counselorId]);
    if (counselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Counselor not found' });
    }
    const [existing] = await connection.query(
      'SELECT id FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This counselor is already assigned to this lead' });
    }
    await connection.query(
      'INSERT INTO lead_counselor_assignments (lead_id, counselor_id, notes) VALUES (?, ?, ?)',
      [leadId, counselorId, notes || null]
    );
    await connection.commit();
    res.json({ success: true, message: 'Counselor assigned successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error assigning counselor:', error);
    res.status(500).json({ success: false, message: 'An error occurred while assigning counselor' });
  } finally {
    connection.release();
  }
});

router.delete('/leads/:leadId/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { leadId, counselorId } = req.params;
    const [result] = await connection.query(
      'DELETE FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }
    await connection.commit();
    res.json({ success: true, message: 'Counselor removed successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error removing counselor:', error);
    res.status(500).json({ success: false, message: 'An error occurred while removing counselor' });
  } finally {
    connection.release();
  }
});

// ============ MEETING ENDPOINTS ============

router.get('/counselors/:counselorId/available-slots', async (req, res) => {
  try {
    const { counselorId } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'Date parameter is required' });
    const [meetings] = await pool.query(
      `SELECT meeting_time, duration_minutes FROM counselor_meetings 
       WHERE counselor_id = ? AND meeting_date = ? AND status != 'Cancelled' ORDER BY meeting_time`,
      [counselorId, date]
    );
    const bookedSlots = meetings.map(meeting => {
      const [hours, minutes] = meeting.meeting_time.split(':');
      const startMinutes = parseInt(hours) * 60 + parseInt(minutes);
      return { start: startMinutes, end: startMinutes + meeting.duration_minutes };
    });
    res.json({ success: true, bookedSlots });
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch available slots' });
  }
});

router.get('/leads/:leadId/meetings', async (req, res) => {
  try {
    const { leadId } = req.params;
    const [meetings] = await pool.query(
      `SELECT cm.*, c.name as counselor_name, c.counselor_id, c.email as counselor_email, l.full_name as lead_name
       FROM counselor_meetings cm
       INNER JOIN counselors c ON cm.counselor_id = c.id
       LEFT JOIN leads l ON cm.lead_id = l.id
       WHERE cm.lead_id = ? ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [leadId]
    );
    res.json({ success: true, meetings });
  } catch (error) {
    console.error('Error fetching lead meetings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch meetings' });
  }
});

router.post('/leads/:leadId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { leadId } = req.params;
    const { counselorId, meetingDate, meetingTime, durationMinutes, notes } = req.body;
    if (!counselorId || !meetingDate || !meetingTime || !durationMinutes) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }
    if (durationMinutes < 15 || durationMinutes > 480) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Duration must be between 15 minutes and 8 hours' });
    }
    const [assignment] = await connection.query(
      'SELECT id FROM lead_counselor_assignments WHERE lead_id = ? AND counselor_id = ?',
      [leadId, counselorId]
    );
    if (assignment.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'This counselor is not assigned to this lead' });
    }
    const [lead] = await connection.query('SELECT full_name FROM leads WHERE id = ?', [leadId]);
    if (lead.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    const [hours, minutes] = meetingTime.split(':');
    const startMinutes = parseInt(hours) * 60 + parseInt(minutes);
    const endMinutes = startMinutes + parseInt(durationMinutes);
    if (startMinutes < 540 || endMinutes > 1020) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Meetings must be scheduled between 9:00 AM and 5:00 PM' });
    }
    const [conflicts] = await connection.query(
      `SELECT id, meeting_time, duration_minutes FROM counselor_meetings
       WHERE counselor_id = ? AND meeting_date = ? AND status != 'Cancelled'`,
      [counselorId, meetingDate]
    );
    for (const meeting of conflicts) {
      const [mHours, mMinutes] = meeting.meeting_time.split(':');
      const mStart = parseInt(mHours) * 60 + parseInt(mMinutes);
      const mEnd = mStart + meeting.duration_minutes;
      if ((startMinutes >= mStart && startMinutes < mEnd) ||
          (endMinutes > mStart && endMinutes <= mEnd) ||
          (startMinutes <= mStart && endMinutes >= mEnd)) {
        await connection.rollback();
        return res.status(409).json({ success: false, message: `This time slot conflicts with an existing meeting from ${meeting.meeting_time} (${meeting.duration_minutes} minutes)` });
      }
    }
    await connection.query(
      `INSERT INTO counselor_meetings (counselor_id, lead_id, student_name, student_id, meeting_date, meeting_time, duration_minutes, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, leadId, lead[0].full_name, `LEAD-${leadId}`, meetingDate, meetingTime, durationMinutes, notes || null]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Meeting scheduled successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error scheduling meeting:', error);
    res.status(500).json({ success: false, message: 'An error occurred while scheduling the meeting' });
  } finally {
    connection.release();
  }
});

router.put('/meetings/:meetingId/notes', upload.single('notesImage'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { meetingId } = req.params;
    const { notes, status } = req.body;
    const notesImage = req.file ? `/uploads/meeting-notes/${req.file.filename}` : null;
    const [meeting] = await connection.query('SELECT id, meeting_notes_image FROM counselor_meetings WHERE id = ?', [meetingId]);
    if (meeting.length === 0) {
      await connection.rollback();
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Meeting not found' });
    }
    if (notesImage && meeting[0].meeting_notes_image) {
      const oldImagePath = path.join(__dirname, '..', meeting[0].meeting_notes_image);
      if (fs.existsSync(oldImagePath)) fs.unlinkSync(oldImagePath);
    }
    let updateFields = [];
    let updateValues = [];
    if (notes !== undefined) { updateFields.push('notes = ?'); updateValues.push(notes); }
    if (notesImage) { updateFields.push('meeting_notes_image = ?'); updateValues.push(notesImage); }
    if (status) { updateFields.push('status = ?'); updateValues.push(status); }
    if (updateFields.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }
    updateValues.push(meetingId);
    await connection.query(`UPDATE counselor_meetings SET ${updateFields.join(', ')} WHERE id = ?`, updateValues);
    await connection.commit();
    res.json({ success: true, message: 'Meeting updated successfully', notesImageUrl: notesImage });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error updating meeting notes:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating meeting notes' });
  } finally {
    connection.release();
  }
});

export default router;