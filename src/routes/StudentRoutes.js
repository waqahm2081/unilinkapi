import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/db.js';
import { claimStudentRegistrationId } from '../utils/studentRegistrationId.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { ensureUploadSubdir, absoluteFromPublicPath } from '../config/uploads.js';
import {
  transferStudentDocsToApplication,
  cleanupCopiedFiles,
} from '../utils/transferStudentDocsToApplication.js';
import { optionalAuthenticate } from '../middleware/auth.js';
import { getCounselorProfileId } from '../utils/counselorAccess.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configure multer for document uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, ensureUploadSubdir('student-documents'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'doc-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDFs, and documents are allowed'));
    }
  }
});

const profileStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, ensureUploadSubdir('student-profiles'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const profileUpload = multer({
  storage: profileStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|webp|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = /jpeg|jpg|png|webp|gif/.test(file.mimetype) || file.mimetype.startsWith('image/');
    if (extname && mimetype) return cb(null, true);
    cb(new Error('Only image files (JPG, PNG, WEBP, GIF) are allowed for profile pictures'));
  }
});

const ensureProfilePictureColumn = async () => {
  try {
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS profile_picture VARCHAR(500) NULL
    `);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') return;
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN profile_picture VARCHAR(500) NULL`);
    } catch (err2) {
      if (err2.code !== 'ER_DUP_FIELDNAME') {
        console.warn('profile_picture column ensure:', err2.message);
      }
    }
  }
};

const ensureFamilyPostalCodeColumn = async () => {
  try {
    await pool.query(`
      ALTER TABLE student_family_details
      ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20) NULL
    `);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') return;
    try {
      await pool.query(`ALTER TABLE student_family_details ADD COLUMN postal_code VARCHAR(20) NULL`);
    } catch (err2) {
      if (err2.code !== 'ER_DUP_FIELDNAME') {
        console.warn('student_family_details.postal_code column ensure:', err2.message);
      }
    }
  }

  // Ensure type ENUM accepts 'Other' (Parents Details 4th subsection)
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM student_family_details LIKE 'type'`);
    const typeDef = String(cols[0]?.Type || '');
    if (typeDef.toLowerCase().startsWith('enum') && !/'other'/i.test(typeDef)) {
      await pool.query(
        `ALTER TABLE student_family_details MODIFY COLUMN type ENUM('Father','Mother','Sponsor','Other') NOT NULL`
      );
    }
  } catch (err) {
    console.warn('student_family_details.type ensure Other:', err.message);
  }
};

const ensureColumn = async (table, column, definition) => {
  try {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN IF NOT EXISTS \`${column}\` ${definition}`);
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') return;
    try {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    } catch (err2) {
      if (err2.code !== 'ER_DUP_FIELDNAME') {
        console.warn(`${table}.${column} column ensure:`, err2.message);
      }
    }
  }
};

const ensureIntendedProgramSchema = async () => {
  await ensureColumn('users', 'intake_session', 'VARCHAR(50) NULL');
  await ensureColumn('users', 'intake_year', 'VARCHAR(10) NULL');
  await ensureColumn('users', 'program', 'VARCHAR(100) NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_intended_programs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      country_id INT NULL,
      university_id INT NULL,
      program_name VARCHAR(255) NULL,
      study_mode VARCHAR(50) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_student_intended_programs_student (student_id)
    )
  `);
};

const ensureStudentNotesSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_notes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      note_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_student_notes_student (student_id)
    )
  `);
};

const ensureAdmissionTestsColumn = async () => {
  await ensureColumn('users', 'admission_tests', 'TEXT NULL');
};

const serializeAdmissionTests = (admissionTests) => {
  if (admissionTests == null) return null;
  if (typeof admissionTests === 'string') {
    const trimmed = admissionTests.trim();
    return trimmed || null;
  }
  if (typeof admissionTests === 'object') {
    return JSON.stringify(admissionTests);
  }
  return null;
};

const saveStudentNotes = async (connection, studentId, notes) => {
  if (!Array.isArray(notes)) return;
  await connection.query('DELETE FROM student_notes WHERE student_id = ?', [studentId]);
  const rows = notes
    .map(n => (typeof n === 'string' ? n : (n?.note_text || n?.text || '')))
    .map(text => String(text || '').trim())
    .filter(Boolean);
  for (const noteText of rows) {
    await connection.query(
      'INSERT INTO student_notes (student_id, note_text) VALUES (?, ?)',
      [studentId, noteText]
    );
  }
};

const saveIntendedPrograms = async (connection, studentId, intendedPrograms) => {
  if (!Array.isArray(intendedPrograms)) return;
  await connection.query('DELETE FROM student_intended_programs WHERE student_id = ?', [studentId]);
  const rows = intendedPrograms.filter(p =>
    p.country_id || p.university_id || (p.program_name && String(p.program_name).trim())
  );
  for (const p of rows) {
    await connection.query(
      `INSERT INTO student_intended_programs (student_id, country_id, university_id, program_name, study_mode)
       VALUES (?, ?, ?, ?, ?)`,
      [
        studentId,
        p.country_id || null,
        p.university_id || null,
        p.program_name?.trim() || null,
        p.study_mode?.trim() || null,
      ]
    );
  }
};

const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

const toPassportEntry = (item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return {
      number: String(item.number || item.passport_no || '').trim(),
      issueDate: String(item.issueDate || item.issue_date || '').split('T')[0] || '',
      placeOfIssue: String(item.placeOfIssue || item.place_of_issue || '').trim(),
    };
  }
  return {
    number: String(item || '').trim(),
    issueDate: '',
    placeOfIssue: '',
  };
};

const parsePassportList = (passportNo) => {
  if (!passportNo) return [];
  if (Array.isArray(passportNo)) return passportNo.map(toPassportEntry);
  if (typeof passportNo === 'object') return [toPassportEntry(passportNo)];
  if (typeof passportNo === 'string') {
    const trimmed = passportNo.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(toPassportEntry);
      if (parsed && typeof parsed === 'object') return [toPassportEntry(parsed)];
    } catch { /* plain string */ }
    return [toPassportEntry(trimmed)];
  }
  return [];
};

const serializePassportNo = (passportNo) => {
  const list = parsePassportList(passportNo).filter(p => p.number || p.issueDate || p.placeOfIssue);
  if (!list.length) return null;
  if (list.length === 1) return list[0].number || null;
  return JSON.stringify(list);
};

const firstPassportIssueDate = (passportNo, fallback) => {
  const first = parsePassportList(passportNo)[0];
  const value = first?.issueDate || fallback || null;
  if (!value) return null;
  return String(value).split('T')[0] || null;
};

const firstPassportPlaceOfIssue = (passportNo, fallback) => {
  const first = parsePassportList(passportNo)[0];
  const value = first?.placeOfIssue || fallback || '';
  return String(value).trim() || null;
};

const normalizeEducationMonth = (value) => {
  if (!value) return null;
  const v = String(value).trim();
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;
  if (v.includes('T')) return v.split('T')[0];
  return v.slice(0, 10);
};

const mapEducationRow = (edu) => {
  const subjectsValue = Array.isArray(edu.subjects)
    ? JSON.stringify(edu.subjects)
    : (typeof edu.subjects === 'string' ? (edu.subjects.trim() || null) : null);
  const resultValue = (edu.grade_cgpa ?? edu.result ?? edu.cgpa);
  return [
    edu.education_level?.trim() || null,
    edu.institute_name?.trim() || null,
    normalizeEducationMonth(edu.start_date),
    normalizeEducationMonth(edu.end_date),
    subjectsValue,
    typeof resultValue === 'string' ? (resultValue.trim() || null) : (resultValue || null),
  ];
};

const mapWorkRow = (work) => [
  work.company_name?.trim() || null,
  work.designation?.trim() || null,
  normalizeEducationMonth(work.date_from),
  normalizeEducationMonth(work.date_to),
  work.employment_type?.trim() || null,
];

const generatePassword = (length = 12) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

// ============ STUDENT CRUD ENDPOINTS ============

// Get all students
router.get('/students', optionalAuthenticate, async (req, res) => {
  try {
    const counselorProfileId = await getCounselorProfileId(req.user);
    const counselorFilter = counselorProfileId
      ? `AND EXISTS (
           SELECT 1 FROM student_counselors sc_scope
           WHERE sc_scope.user_id = u.id AND sc_scope.counselor_id = ?
         )`
      : '';
    const params = counselorProfileId ? [counselorProfileId] : [];

    const [students] = await pool.query(
      `SELECT u.id, u.student_id, u.name, u.middle_name, u.surname, u.email, 
        u.mobile, u.country, u.dob, u.status, u.course, u.created_at,
        COUNT(DISTINCT sc.counselor_id) as counselor_count,
        COUNT(DISTINCT cm.id) as meeting_count
      FROM users u
      LEFT JOIN student_counselors sc ON u.id = sc.user_id
      LEFT JOIN counselor_meetings cm ON u.id = cm.user_id
      WHERE u.role = 'client'
        ${counselorFilter}
      GROUP BY u.id
      ORDER BY u.created_at DESC`,
      params
    );
    res.json({ success: true, students, total: students.length });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch students' });
  }
});

// Get single student by ID with all details
router.get('/students/:studentId/credentials', async (req, res) => {
  try {
    const { studentId } = req.params;
    const [students] = await pool.query(
      `SELECT id, student_id, name, middle_name, surname, email, plain_password
       FROM users WHERE id = ? AND role = 'client'`,
      [studentId]
    );
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const student = students[0];
    if (!student.plain_password) {
      return res.status(404).json({
        success: false,
        message: 'Login credentials are not available for this student. Only students created after credential storage was enabled have a retrievable password.'
      });
    }
    res.json({
      success: true,
      credentials: {
        email: student.email,
        password: student.plain_password,
        studentName: [student.name, student.middle_name, student.surname].filter(Boolean).join(' '),
        studentRefId: student.student_id
      }
    });
  } catch (error) {
    console.error('Error fetching student credentials:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch student credentials' });
  }
});

// Get single student by ID with all details
router.get('/students/:studentId', optionalAuthenticate, async (req, res) => {
  try {
    await ensureIntendedProgramSchema();
    const { studentId } = req.params;

    const counselorProfileId = await getCounselorProfileId(req.user);
    if (counselorProfileId) {
      const [assigned] = await pool.query(
        'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ? LIMIT 1',
        [studentId, counselorProfileId]
      );
      if (!assigned.length) {
        return res.status(403).json({ success: false, message: 'Access denied for this student' });
      }
    }

    const [students] = await pool.query(
      `SELECT * FROM users WHERE id = ? AND role = 'client'`,
      [studentId]
    );
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const [education] = await pool.query(
      'SELECT * FROM student_education WHERE student_id = ? ORDER BY start_date DESC',
      [studentId]
    );

    const [workExperience] = await pool.query(
      'SELECT * FROM student_work_experience WHERE student_id = ? ORDER BY id DESC',
      [studentId]
    );

    const [documents] = await pool.query(
      'SELECT * FROM student_documents WHERE student_id = ? ORDER BY display_order ASC, uploaded_at DESC',
      [studentId]
    );

    const [counselors] = await pool.query(
      `SELECT c.*, sc.assigned_at
       FROM counselors c
       INNER JOIN student_counselors sc ON c.id = sc.counselor_id
       WHERE sc.user_id = ?
       ORDER BY sc.assigned_at DESC`,
      [studentId]
    );

    const [meetings] = await pool.query(
      `SELECT cm.*, c.name as counselor_name, c.counselor_id, c.email as counselor_email
       FROM counselor_meetings cm
       INNER JOIN counselors c ON cm.counselor_id = c.id
       WHERE cm.user_id = ?
       ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [studentId]
    );

    const [emergencyContacts] = await pool.query(
      'SELECT * FROM student_emergency_contact WHERE student_id = ? LIMIT 1',
      [studentId]
    );

    const [familyDetails] = await pool.query(
      'SELECT * FROM student_family_details WHERE student_id = ? ORDER BY FIELD(type, "Father","Mother","Sponsor","Other")',
      [studentId]
    );

    const [activities] = await pool.query(
      'SELECT * FROM student_activities WHERE student_id = ? ORDER BY id ASC',
      [studentId]
    );

    const [awards] = await pool.query(
      'SELECT * FROM student_awards WHERE student_id = ? ORDER BY id ASC',
      [studentId]
    );

    let notes = [];
    try {
      await ensureStudentNotesSchema();
      const [noteRows] = await pool.query(
        'SELECT * FROM student_notes WHERE student_id = ? ORDER BY id ASC',
        [studentId]
      );
      notes = noteRows;
    } catch (err) {
      console.warn('Student notes fetch:', err.message);
    }

    let intendedPrograms = [];
    try {
      await ensureIntendedProgramSchema();
      const [programRows] = await pool.query(
        'SELECT * FROM student_intended_programs WHERE student_id = ? ORDER BY id ASC',
        [studentId]
      );
      intendedPrograms = programRows;
    } catch (err) {
      console.warn('Intended programs fetch:', err.message);
    }

    res.json({
      success: true,
      student: students[0],
      education,
      workExperience,
      documents,
      assignedCounselors: counselors,
      meetings,
      emergencyContact: emergencyContacts[0] || null,
      familyDetails,
      activities,
      awards,
      notes,
      intendedPrograms
    });

  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch student' });
  }
});

router.get('/students/:studentId/lead-history', async (req, res) => {
  try {
    const { studentId } = req.params;

    const [users] = await pool.query(
      'SELECT id, source_lead_id, email, invoice_id FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const user = users[0];
    let leadId = user.source_lead_id;

    if (!leadId) {
      const [counselorLinks] = await pool.query(
        `SELECT transferred_from_lead_id
         FROM student_counselors
         WHERE user_id = ? AND transferred_from_lead_id IS NOT NULL
         LIMIT 1`,
        [studentId]
      );
      leadId = counselorLinks[0]?.transferred_from_lead_id || null;
    }

    if (!leadId && user.invoice_id) {
      const [invoiceLeads] = await pool.query(
        'SELECT id FROM leads WHERE invoice_id = ? LIMIT 1',
        [user.invoice_id]
      );
      leadId = invoiceLeads[0]?.id || null;
    }

    if (!leadId) {
      const [emailLeads] = await pool.query(
        `SELECT id FROM leads
         WHERE LOWER(email) = LOWER(?) AND is_registered = TRUE
         ORDER BY registered_at DESC LIMIT 1`,
        [user.email]
      );
      leadId = emailLeads[0]?.id || null;
    }

    if (!leadId) {
      return res.json({
        success: true,
        hasHistory: false,
        lead: null,
        followUps: [],
        changes: [],
      });
    }

    const [leadRows] = await pool.query('SELECT * FROM leads WHERE id = ?', [leadId]);
    if (leadRows.length === 0) {
      return res.json({
        success: true,
        hasHistory: false,
        lead: null,
        followUps: [],
        changes: [],
      });
    }

    const [followUps] = await pool.query(
      `SELECT fu.*, l.purpose_of_visit
       FROM follow_ups fu
       LEFT JOIN leads l ON fu.lead_id = l.id
       WHERE fu.lead_id = ?
       ORDER BY fu.followed_up_at DESC`,
      [leadId]
    );

    const [changes] = await pool.query(
      `SELECT lc.*, fu.follow_up_number, fu.followed_up_at
       FROM lead_changes lc
       LEFT JOIN follow_ups fu ON lc.follow_up_id = fu.id
       WHERE lc.lead_id = ?
       ORDER BY lc.changed_at DESC`,
      [leadId]
    );

    res.json({
      success: true,
      hasHistory: true,
      lead: leadRows[0],
      followUps,
      changes,
      leadId,
    });
  } catch (error) {
    console.error('Error fetching student lead history:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch lead history' });
  }
});

// Create new student
router.post('/students', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureFamilyPostalCodeColumn();
    await ensureIntendedProgramSchema();
    await ensureStudentNotesSchema();
    await ensureAdmissionTestsColumn();
    await connection.beginTransaction();

    const {
      firstName, middleName, surname, email, alternativeEmail,
      mobile, landline, address, postalCode, country, dob,
      nationality, maritalStatus, gender,
      cityOfBirth, countryOfBirth,
      passportNo, passportIssueDate, passportPlaceOfIssue,
      guardianName, guardianRelation, guardianMobile, guardianEmail,
      sourceInquiry, course, program, status,
      emergencyContact, familyDetails,
      education, workExperience, activities, awards, notes,
      intendedPrograms, intakeSession, intakeYear, admissionTests,
      studentId: requestedStudentId
    } = req.body;

    if (!firstName || !surname || !email || !mobile || !address || !country || !dob) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (!validatePhone(mobile)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number' });
    }

    const [existingUser] = await connection.query(
      'SELECT id FROM users WHERE email = ?', [trimmedEmail]
    );
    if (existingUser.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A user with this email already exists' });
    }

    let studentId;
    try {
      studentId = await claimStudentRegistrationId(connection, requestedStudentId);
    } catch (idErr) {
      await connection.rollback();
      return res.status(idErr.statusCode || 400).json({ success: false, message: idErr.message });
    }
    const generatedPassword = generatePassword(12);
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);

    const studentStatus = status || 'Active';

    const admissionTestsJson = serializeAdmissionTests(admissionTests);

    const [result] = await connection.query(
      `INSERT INTO users 
      (student_id, name, middle_name, surname, email, alternative_email, mobile, landline,
       address, postal_code, country, dob, nationality, marital_status, gender,
       city_of_birth, country_of_birth, passport_no, passport_issue_date, passport_place_of_issue,
       guardian_name, guardian_relation, guardian_mobile, guardian_email,
       source_inquiry, course, program, intake_session, intake_year, admission_tests,
       password, plain_password, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', ?)`,
      [
        studentId, firstName.trim(), middleName?.trim() || null, surname.trim(),
        trimmedEmail, alternativeEmail?.trim() || null,
        mobile.trim(), landline?.trim() || null,
        address.trim(), postalCode?.trim() || null,
        country, dob,
        nationality?.trim() || null, maritalStatus || null, gender || null,
        cityOfBirth?.trim() || null, countryOfBirth?.trim() || null,
        serializePassportNo(passportNo),
        firstPassportIssueDate(passportNo, passportIssueDate),
        firstPassportPlaceOfIssue(passportNo, passportPlaceOfIssue),
        guardianName?.trim() || null, guardianRelation?.trim() || null,
        guardianMobile?.trim() || null, guardianEmail?.trim() || null,
        sourceInquiry || null, course?.trim() || null, program?.trim() || null,
        intakeSession?.trim() || null, intakeYear ? String(intakeYear).trim() : null,
        admissionTestsJson,
        hashedPassword,
        generatedPassword,
        studentStatus
      ]
    );

    const newStudentId = result.insertId;

    if (emergencyContact && (emergencyContact.full_name || emergencyContact.contact_no)) {
      await connection.query(
        `INSERT INTO student_emergency_contact (student_id, full_name, relation, contact_no, email, address, postal_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newStudentId, emergencyContact.full_name || null, emergencyContact.relation || null,
         emergencyContact.contact_no || null, emergencyContact.email || null,
         emergencyContact.address || null, emergencyContact.postal_code || null]
      );
    }

    if (familyDetails && Array.isArray(familyDetails)) {
      for (const member of familyDetails) {
        if (member.type && (member.full_name || member.contact_no)) {
          await connection.query(
            `INSERT INTO student_family_details (student_id, type, full_name, relation, contact_no, email, profession, address, postal_code, sponsor_note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newStudentId, member.type, member.full_name || null, member.relation || null,
             member.contact_no || null, member.email || null, member.profession || null,
             member.address || null, member.postal_code || null, member.sponsor_note || null]
          );
        }
      }
    }

    if (education && Array.isArray(education) && education.length > 0) {
      const educationValues = education
        .filter(edu => edu.education_level?.trim())
        .map(edu => [newStudentId, ...mapEducationRow(edu)]);
      if (educationValues.length > 0) {
        await connection.query(
          `INSERT INTO student_education (student_id, education_level, institute_name, start_date, end_date, subjects, result)
           VALUES ?`,
          [educationValues]
        );
      }
    }

    if (activities && Array.isArray(activities) && activities.length > 0) {
      const activityValues = activities
        .filter(a => a.activity_name)
        .map(a => [newStudentId, a.activity_name, a.description || null,
          a.grade_levels || null, a.hours_per_week || null, a.weeks_per_year || null]);
      if (activityValues.length > 0) {
        await connection.query(
          `INSERT INTO student_activities (student_id, activity_name, description, grade_levels, hours_per_week, weeks_per_year)
           VALUES ?`,
          [activityValues]
        );
      }
    }

    if (awards && Array.isArray(awards) && awards.length > 0) {
      const awardValues = awards
        .filter(a => a.award_name)
        .map(a => [newStudentId, a.award_name, a.recognition_level || null,
          a.award_type || null, a.received_date || null, a.description || null]);
      if (awardValues.length > 0) {
        await connection.query(
          `INSERT INTO student_awards (student_id, award_name, recognition_level, award_type, received_date, description)
           VALUES ?`,
          [awardValues]
        );
      }
    }

    if (workExperience && Array.isArray(workExperience) && workExperience.length > 0) {
      const workValues = workExperience
        .filter(w => w.company_name?.trim() && w.designation?.trim())
        .map(w => [newStudentId, ...mapWorkRow(w)]);
      if (workValues.length > 0) {
        await connection.query(
          `INSERT INTO student_work_experience (student_id, company_name, designation, date_from, date_to, employment_type)
           VALUES ?`,
          [workValues]
        );
      }
    }

    await saveIntendedPrograms(connection, newStudentId, intendedPrograms);
    await saveStudentNotes(connection, newStudentId, notes);

    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Student created successfully',
      studentId: newStudentId,
      generatedStudentId: studentId,
      credentials: { email: trimmedEmail, password: generatedPassword }
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating student:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'This Registration ID is already in use. Please enter a unique ID.' });
    }
    res.status(500).json({ success: false, message: 'An error occurred while creating the student' });
  } finally {
    connection.release();
  }
});

// Update student
router.put('/students/:studentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureFamilyPostalCodeColumn();
    await ensureIntendedProgramSchema();
    await ensureStudentNotesSchema();
    await ensureAdmissionTestsColumn();
    await connection.beginTransaction();

    const { studentId } = req.params;
    const {
      firstName, middleName, surname, email, alternativeEmail,
      mobile, landline, address, postalCode, country, dob,
      nationality, maritalStatus, gender,
      cityOfBirth, countryOfBirth,
      passportNo, passportIssueDate, passportPlaceOfIssue,
      guardianName, guardianRelation, guardianMobile, guardianEmail,
      sourceInquiry, status, course, program,
      emergencyContact, familyDetails,
      education, workExperience, activities, awards, notes,
      intendedPrograms, intakeSession, intakeYear, counselorIds,
      admissionTests
    } = req.body;

    if (!firstName || !surname || !email || !mobile || !address) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'First name, surname, email, mobile, and address are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const formattedDob = dob ? String(dob).split('T')[0] : null;

    const [existingStudent] = await connection.query(
      'SELECT id FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (existingStudent.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const [emailCheck] = await connection.query(
      'SELECT id FROM users WHERE email = ? AND id != ?', [trimmedEmail, studentId]
    );
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'Email already associated with another user' });
    }

    await connection.query(
      `UPDATE users SET
        name = ?, middle_name = ?, surname = ?, email = ?, alternative_email = ?,
        mobile = ?, landline = ?, address = ?, postal_code = ?, country = ?, dob = ?,
        nationality = ?, marital_status = ?, gender = ?,
        city_of_birth = ?, country_of_birth = ?,
        passport_no = ?, passport_issue_date = ?, passport_place_of_issue = ?,
        guardian_name = ?, guardian_relation = ?, guardian_mobile = ?, guardian_email = ?,
        source_inquiry = ?, status = ?, course = ?, program = ?, intake_session = ?, intake_year = ?,
        admission_tests = ?
      WHERE id = ?`,
      [
        firstName.trim(), middleName?.trim() || null, surname.trim(),
        trimmedEmail, alternativeEmail?.trim() || null,
        mobile.trim(), landline?.trim() || null,
        address.trim(), postalCode?.trim() || null,
        country?.trim() || null, formattedDob,
        nationality?.trim() || null, maritalStatus || null, gender || null,
        cityOfBirth?.trim() || null, countryOfBirth?.trim() || null,
        serializePassportNo(passportNo),
        firstPassportIssueDate(passportNo, passportIssueDate),
        firstPassportPlaceOfIssue(passportNo, passportPlaceOfIssue),
        guardianName?.trim() || null, guardianRelation?.trim() || null,
        guardianMobile?.trim() || null, guardianEmail?.trim() || null,
        sourceInquiry || null, status || 'Active', course?.trim() || null, program?.trim() || null,
        intakeSession?.trim() || null, intakeYear ? String(intakeYear).trim() : null,
        serializeAdmissionTests(admissionTests),
        studentId
      ]
    );

    if (emergencyContact) {
      const [existingEC] = await connection.query(
        'SELECT id FROM student_emergency_contact WHERE student_id = ?', [studentId]
      );
      if (existingEC.length > 0) {
        await connection.query(
          `UPDATE student_emergency_contact SET full_name=?, relation=?, contact_no=?, email=?, address=?, postal_code=?
           WHERE student_id=?`,
          [emergencyContact.full_name || null, emergencyContact.relation || null,
           emergencyContact.contact_no || null, emergencyContact.email || null,
           emergencyContact.address || null, emergencyContact.postal_code || null,
           studentId]
        );
      } else {
        await connection.query(
          `INSERT INTO student_emergency_contact (student_id, full_name, relation, contact_no, email, address, postal_code)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [studentId, emergencyContact.full_name || null, emergencyContact.relation || null,
           emergencyContact.contact_no || null, emergencyContact.email || null,
           emergencyContact.address || null, emergencyContact.postal_code || null]
        );
      }
    }

    if (familyDetails && Array.isArray(familyDetails)) {
      await connection.query('DELETE FROM student_family_details WHERE student_id = ?', [studentId]);
      for (const member of familyDetails) {
        if (member.type) {
          await connection.query(
            `INSERT INTO student_family_details (student_id, type, full_name, relation, contact_no, email, profession, address, postal_code, sponsor_note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [studentId, member.type, member.full_name || null, member.relation || null,
             member.contact_no || null, member.email || null, member.profession || null,
             member.address || null, member.postal_code || null, member.sponsor_note || null]
          );
        }
      }
    }

    if (education && Array.isArray(education)) {
      await connection.query('DELETE FROM student_education WHERE student_id = ?', [studentId]);
      const educationValues = education
        .filter(edu => edu.education_level?.trim())
        .map(edu => [studentId, ...mapEducationRow(edu)]);
      if (educationValues.length > 0) {
        await connection.query(
          `INSERT INTO student_education (student_id, education_level, institute_name, start_date, end_date, subjects, result)
           VALUES ?`,
          [educationValues]
        );
      }
    }

    if (activities && Array.isArray(activities)) {
      await connection.query('DELETE FROM student_activities WHERE student_id = ?', [studentId]);
      const activityValues = activities
        .filter(a => a.activity_name)
        .map(a => [studentId, a.activity_name, a.description || null,
          a.grade_levels || null, a.hours_per_week || null, a.weeks_per_year || null]);
      if (activityValues.length > 0) {
        await connection.query(
          `INSERT INTO student_activities (student_id, activity_name, description, grade_levels, hours_per_week, weeks_per_year)
           VALUES ?`,
          [activityValues]
        );
      }
    }

    if (awards && Array.isArray(awards)) {
      await connection.query('DELETE FROM student_awards WHERE student_id = ?', [studentId]);
      const awardValues = awards
        .filter(a => a.award_name)
        .map(a => [studentId, a.award_name, a.recognition_level || null,
          a.award_type || null, a.received_date || null, a.description || null]);
      if (awardValues.length > 0) {
        await connection.query(
          `INSERT INTO student_awards (student_id, award_name, recognition_level, award_type, received_date, description)
           VALUES ?`,
          [awardValues]
        );
      }
    }

    if (workExperience && Array.isArray(workExperience)) {
      await connection.query('DELETE FROM student_work_experience WHERE student_id = ?', [studentId]);
      const workValues = workExperience
        .filter(w => w.company_name?.trim() && w.designation?.trim())
        .map(w => [studentId, ...mapWorkRow(w)]);
      if (workValues.length > 0) {
        await connection.query(
          `INSERT INTO student_work_experience (student_id, company_name, designation, date_from, date_to, employment_type)
           VALUES ?`,
          [workValues]
        );
      }
    }

    await saveIntendedPrograms(connection, studentId, intendedPrograms);
    await saveStudentNotes(connection, studentId, notes);

    if (Array.isArray(counselorIds)) {
      const uniqueIds = [...new Set(counselorIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0))];
      await connection.query('DELETE FROM student_counselors WHERE user_id = ?', [studentId]);
      for (const counselorId of uniqueIds) {
        await connection.query(
          'INSERT INTO student_counselors (user_id, counselor_id) VALUES (?, ?)',
          [studentId, counselorId]
        );
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Student updated successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating student:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the student' });
  } finally {
    connection.release();
  }
});

// Delete student
router.delete('/students/:studentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;

    const [existingStudent] = await connection.query(
      'SELECT id, name FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (existingStudent.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    await connection.query('DELETE FROM users WHERE id = ?', [studentId]);
    await connection.commit();
    res.json({ success: true, message: 'Student deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting student:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the student' });
  } finally {
    connection.release();
  }
});

// ============ MANUAL FORM UPLOAD ============

router.post('/students/:studentId/manual-form', upload.single('manualForm'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;

    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const [student] = await connection.query(
      'SELECT id, manual_form_path FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    if (student[0].manual_form_path) {
      const oldFilePath = absoluteFromPublicPath(student[0].manual_form_path);
      if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
    }

    const filePath = `/uploads/student-documents/${req.file.filename}`;
    await connection.query(
      'UPDATE users SET manual_form_path = ?, manual_form_uploaded_at = NOW() WHERE id = ?',
      [filePath, studentId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Manual form uploaded successfully', filePath });

  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading manual form:', error);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the manual form' });
  } finally {
    connection.release();
  }
});

router.get('/students/:studentId/manual-form', async (req, res) => {
  try {
    const { studentId } = req.params;
    const [result] = await pool.query(
      'SELECT manual_form_path, manual_form_uploaded_at FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    if (result.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    res.json({
      success: true,
      manualForm: result[0].manual_form_path ? {
        filePath: result[0].manual_form_path,
        uploadedAt: result[0].manual_form_uploaded_at
      } : null
    });
  } catch (error) {
    console.error('Error fetching manual form:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch manual form' });
  }
});

router.delete('/students/:studentId/manual-form', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;

    const [student] = await connection.query(
      'SELECT manual_form_path FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    if (!student[0].manual_form_path) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No manual form found' });
    }

    const filePath = absoluteFromPublicPath(student[0].manual_form_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await connection.query(
      'UPDATE users SET manual_form_path = NULL, manual_form_uploaded_at = NULL WHERE id = ?',
      [studentId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Manual form deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting manual form:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the manual form' });
  } finally {
    connection.release();
  }
});

// ============ PROFILE PICTURE ============

router.post('/students/:studentId/profile-picture', profileUpload.single('profilePicture'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureProfilePictureColumn();

    const { studentId } = req.params;
    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please select a profile picture' });
    }

    const [student] = await connection.query(
      'SELECT id, profile_picture FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      const uploaded = path.join(__dirname, '../uploads/student-profiles', req.file.filename);
      if (fs.existsSync(uploaded)) fs.unlinkSync(uploaded);
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const filePath = `/uploads/student-profiles/${req.file.filename}`;
    const oldPath = student[0].profile_picture;

    await connection.query(
      'UPDATE users SET profile_picture = ? WHERE id = ?',
      [filePath, studentId]
    );

    if (oldPath) {
      const absoluteOld = absoluteFromPublicPath(oldPath);
      if (fs.existsSync(absoluteOld)) {
        try { fs.unlinkSync(absoluteOld); } catch { /* ignore */ }
      }
    }

    await connection.commit();
    res.json({
      success: true,
      message: 'Profile picture uploaded successfully',
      profilePicture: filePath
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error uploading profile picture:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to upload profile picture' });
  } finally {
    connection.release();
  }
});

router.delete('/students/:studentId/profile-picture', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const [student] = await connection.query(
      'SELECT id, profile_picture FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const oldPath = student[0].profile_picture;
    await connection.query('UPDATE users SET profile_picture = NULL WHERE id = ?', [studentId]);

    if (oldPath) {
      const absoluteOld = absoluteFromPublicPath(oldPath);
      if (fs.existsSync(absoluteOld)) {
        try { fs.unlinkSync(absoluteOld); } catch { /* ignore */ }
      }
    }

    await connection.commit();
    res.json({ success: true, message: 'Profile picture removed' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting profile picture:', error);
    res.status(500).json({ success: false, message: 'Failed to remove profile picture' });
  } finally {
    connection.release();
  }
});

// ============ DOCUMENT MANAGEMENT ============

router.post('/students/:studentId/documents', upload.single('document'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { documentName, documentType, displayOrder } = req.body;

    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    if (!documentName || !documentType) {
      await connection.rollback();
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Document name and type are required' });
    }

    const filePath = `/uploads/student-documents/${req.file.filename}`;
    const [insertResult] = await connection.query(
      `INSERT INTO student_documents (student_id, document_name, document_type, file_path, display_order)
       VALUES (?, ?, ?, ?, ?)`,
      [studentId, documentName, documentType, filePath, displayOrder || 99]
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'Document uploaded successfully',
      filePath,
      document: {
        id: insertResult.insertId,
        student_id: Number(studentId),
        document_name: documentName,
        document_type: documentType,
        file_path: filePath,
        display_order: Number(displayOrder) || 99,
        verified: 0
      }
    });

  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading document:', error);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the document' });
  } finally {
    connection.release();
  }
});

router.put('/students/:studentId/documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId, documentId } = req.params;
    const { verified } = req.body;

    await connection.query(
      'UPDATE student_documents SET verified = ? WHERE id = ? AND student_id = ?',
      [verified ? 1 : 0, documentId, studentId]
    );

    await connection.commit();
    res.json({ success: true, message: 'Document verification status updated' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating document:', error);
    res.status(500).json({ success: false, message: 'An error occurred while updating the document' });
  } finally {
    connection.release();
  }
});

router.delete('/students/:studentId/documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId, documentId } = req.params;

    const [document] = await connection.query(
      'SELECT file_path FROM student_documents WHERE id = ? AND student_id = ?',
      [documentId, studentId]
    );
    if (document.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    await connection.query(
      'DELETE FROM student_documents WHERE id = ? AND student_id = ?', [documentId, studentId]
    );

    const filePath = absoluteFromPublicPath(document[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await connection.commit();
    res.json({ success: true, message: 'Document deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting document:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the document' });
  } finally {
    connection.release();
  }
});

// ============ COUNSELOR ASSIGNMENT ============

router.post('/students/:studentId/assign-counselor', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { counselorId } = req.body;

    if (!counselorId) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Counselor ID is required' });
    }

    const [existing] = await connection.query(
      'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This counselor is already assigned' });
    }

    await connection.query(
      'INSERT INTO student_counselors (user_id, counselor_id) VALUES (?, ?)', [studentId, counselorId]
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

router.delete('/students/:studentId/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId, counselorId } = req.params;

    const [result] = await connection.query(
      'DELETE FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
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

// ============ MEETINGS ============

router.post('/students/:studentId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { counselorId, meetingDate, meetingTime, durationMinutes, notes } = req.body;

    if (!counselorId || !meetingDate || !meetingTime || !durationMinutes) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }

    const [assignment] = await connection.query(
      'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ?',
      [studentId, counselorId]
    );
    if (assignment.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'This counselor is not assigned to this student' });
    }

    const [student] = await connection.query(
      'SELECT name, student_id FROM users WHERE id = ? AND role = ?', [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
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
        return res.status(409).json({
          success: false,
          message: `Time slot conflicts with an existing meeting at ${meeting.meeting_time}`
        });
      }
    }

    await connection.query(
      `INSERT INTO counselor_meetings 
       (counselor_id, user_id, student_name, student_id, meeting_date, meeting_time, duration_minutes, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, studentId, student[0].name, student[0].student_id,
       meetingDate, meetingTime, durationMinutes, notes || null]
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

// ============ CREATE APPLICATIONS FOR STUDENT ============
// Now accepts universityIds — creates one application per university,
// deriving country from the university's country_id.
// Falls back to countryIds for backward compatibility if universityIds not provided.

router.post('/students/:studentId/create-applications', async (req, res) => {
  const connection = await pool.getConnection();
  const copiedFiles = [];
  try {
    await connection.beginTransaction();
    const { studentId } = req.params;
    const { universityIds, countryIds } = req.body;

    // Determine mode: university-based (new) or country-based (legacy)
    const useUniversityMode = Array.isArray(universityIds) && universityIds.length > 0;
    const useLegacyMode     = !useUniversityMode && Array.isArray(countryIds) && countryIds.length > 0;

    if (!useUniversityMode && !useLegacyMode) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Please provide at least one university ID' });
    }

    const [student] = await connection.query(
      'SELECT id, name, middle_name, surname, student_id FROM users WHERE id = ? AND role = ?',
      [studentId, 'client']
    );
    if (student.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const fullStudentName = [student[0].name, student[0].middle_name, student[0].surname]
      .filter((p) => p && String(p).trim())
      .join(' ')
      .trim();

    let createdCount = 0;
    let transferredDocuments = 0;
    const currentDate = new Date().toISOString().split('T')[0];
    const currentYear = new Date().getFullYear();

    const generateApplicationId = async () => {
      const [result] = await connection.query(
        `SELECT MAX(CAST(SUBSTRING(application_id, 8) AS UNSIGNED)) as max_id 
         FROM applications WHERE application_id LIKE ?`,
        [`APP${currentYear}%`]
      );
      const nextId = (result[0].max_id || 0) + 1;
      return `APP${currentYear}${String(nextId).padStart(3, '0')}`;
    };

    if (useUniversityMode) {
      // University-based: create one application per university
      for (const universityId of universityIds) {
        // Fetch university + country info
        const [uniRows] = await connection.query(
          `SELECT u.id, u.university_name, u.country_id, c.country_name, c.status as country_status
           FROM universities u
           INNER JOIN countries c ON u.country_id = c.id
           WHERE u.id = ?`,
          [universityId]
        );
        if (uniRows.length === 0) continue;

        const uni = uniRows[0];

        // Check if application already exists for this student + university
        const [existingApp] = await connection.query(
          'SELECT id FROM applications WHERE student_id = ? AND university_id = ?',
          [studentId, universityId]
        );
        if (existingApp.length > 0) continue; // skip duplicates silently

        const applicationId = await generateApplicationId();

        const [insertResult] = await connection.query(
          `INSERT INTO applications 
           (application_id, application_date, student_id, student_name, country_id, university_id, application_status, tagging_status)
           VALUES (?, ?, ?, ?, ?, ?, 'Pending', 'Not Tagged')`,
          [applicationId, currentDate, studentId, fullStudentName, uni.country_id, universityId]
        );
        const transferResult = await transferStudentDocsToApplication(
          connection,
          studentId,
          insertResult.insertId
        );
        copiedFiles.push(...transferResult.copiedFiles);
        transferredDocuments += transferResult.transferred;
        createdCount++;
      }
    } else {
      // Legacy country-based mode
      const [existingApps] = await connection.query(
        'SELECT country_id FROM applications WHERE student_id = ? AND country_id IN (?)',
        [studentId, countryIds]
      );
      if (existingApps.length > 0) {
        const existingCountryIds = existingApps.map(app => app.country_id);
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: 'Applications already exist for some selected countries',
          existingCountryIds
        });
      }

      for (const countryId of countryIds) {
        const [country] = await connection.query(
          'SELECT id, country_name FROM countries WHERE id = ? AND status = ?', [countryId, 'Active']
        );
        if (country.length === 0) continue;

        const applicationId = await generateApplicationId();

        const [insertResult] = await connection.query(
          `INSERT INTO applications 
           (application_id, application_date, student_id, student_name, country_id, application_status, tagging_status)
           VALUES (?, ?, ?, ?, ?, 'Pending', 'Not Tagged')`,
          [applicationId, currentDate, studentId, fullStudentName, countryId]
        );
        const transferResult = await transferStudentDocsToApplication(
          connection,
          studentId,
          insertResult.insertId
        );
        copiedFiles.push(...transferResult.copiedFiles);
        transferredDocuments += transferResult.transferred;
        createdCount++;
      }
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: 'Applications created successfully',
      createdCount,
      transferredDocuments,
    });

  } catch (error) {
    await connection.rollback();
    cleanupCopiedFiles(copiedFiles);
    console.error('Error creating applications:', error);
    res.status(500).json({ success: false, message: 'An error occurred while creating applications' });
  } finally {
    connection.release();
  }
});

export default router;