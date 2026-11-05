import express from 'express';
import pool from '../config/db.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { ensureUploadSubdir, absoluteFromPublicPath } from '../config/uploads.js';
import {
  transferStudentDocsToVisa,
  transferVisaDocsToVisa,
  cleanupCopiedFiles,
} from '../utils/transferDocsToVisa.js';
import { optionalAuthenticate } from '../middleware/auth.js';
import { getCounselorProfileId } from '../utils/counselorAccess.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Serve uploaded files
router.get('/uploads/visa-documents/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(ensureUploadSubdir('visa-documents'), filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({
      success: false,
      message: 'As this is a test server, files are automatically deleted after every new deployment to the server due to storage restrictions, please move to live server for permanent storage.',
    });
  }
});

// Configure multer for visa document uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, ensureUploadSubdir('visa-documents'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'visa-' + uniqueSuffix + path.extname(file.originalname));
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

const ensureVisaSchema = async () => {
  const newColumns = [
    ['applicant_name', 'VARCHAR(255) NULL'],
    ['applicant_email', 'VARCHAR(255) NULL'],
    ['applicant_phone', 'VARCHAR(50) NULL'],
    ['country_id', 'INT NULL'],
    ['main_applicant_name', 'VARCHAR(255) NULL'],
    ['main_applicant_relation', 'VARCHAR(100) NULL'],
    ['main_applicant_institute', 'VARCHAR(255) NULL'],
    ['main_applicant_visa_category', 'VARCHAR(255) NULL'],
    ['main_applicant_visa_status', 'VARCHAR(100) NULL'],
    ['visa_category', 'VARCHAR(255) NULL'],
    ['visa_appointment', 'VARCHAR(50) NULL'],
    ['biometrics', 'VARCHAR(50) NULL'],
    ['biometrics_appointment_date', 'DATE NULL'],
    ['medical_test', 'VARCHAR(255) NULL'],
    ['medical_booked', 'VARCHAR(50) NULL'],
    ['medical_appointment_date', 'DATE NULL'],
    ['bank_statement_requirement', 'VARCHAR(50) NULL'],
    ['bank_statement_amount_required', 'VARCHAR(255) NULL'],
    ['accommodation_booked', 'VARCHAR(10) NULL'],
    ['visa_website_id', 'VARCHAR(255) NULL'],
  ];

  for (const [col, def] of newColumns) {
    try {
      await pool.query(`ALTER TABLE visas ADD COLUMN ${col} ${def}`);
    } catch (err) {
      if (!String(err.message).includes('Duplicate column')) {
        console.warn(`visas.${col}:`, err.message);
      }
    }
  }

  try {
    await pool.query('ALTER TABLE visas MODIFY student_id INT NULL');
  } catch (err) {
    console.warn('visas.student_id nullable:', err.message);
  }

  // Expand legacy ENUM columns to VARCHAR so new status/type values are accepted
  try {
    await pool.query(
      "ALTER TABLE visas MODIFY visa_status VARCHAR(50) NOT NULL DEFAULT 'In Progress'"
    );
  } catch (err) {
    console.warn('visas.visa_status:', err.message);
  }

  try {
    await pool.query(
      "ALTER TABLE visas MODIFY visa_type VARCHAR(50) NOT NULL DEFAULT 'Study Visa'"
    );
  } catch (err) {
    console.warn('visas.visa_type:', err.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS visa_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      visa_id INT NOT NULL,
      document_type VARCHAR(100) NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      original_name VARCHAR(255) NULL,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_visa_documents_visa (visa_id)
    )
  `);
};

const visaListSelect = `
  SELECT v.*,
         COALESCE(v.applicant_name, u.name) AS student_name,
         COALESCE(v.applicant_email, u.email) AS student_email,
         COALESCE(v.applicant_phone, u.mobile) AS student_mobile,
         u.student_id,
         c.country_name AS student_country,
         c.country_name AS country_name
  FROM visas v
  LEFT JOIN users u ON v.student_id = u.id
  LEFT JOIN countries c ON v.country_id = c.id
`;

// Generate visa ID
const generateVisaId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(visa_id, 9) AS UNSIGNED)) as max_id 
     FROM visas 
     WHERE visa_id LIKE 'VISA${currentYear}%'`
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `VISA${currentYear}${String(nextId).padStart(3, '0')}`;
};


// ============================================================
// CHANGED METHOD 1: GET /visas
// Added: institute, submission_date, submitted_by to SELECT
// ============================================================
router.get('/visas', optionalAuthenticate, async (req, res) => {
  try {
    await ensureVisaSchema();
    const counselorProfileId = await getCounselorProfileId(req.user);
    const counselorFilter = counselorProfileId
      ? `WHERE EXISTS (
           SELECT 1 FROM student_counselors sc_scope
           WHERE sc_scope.user_id = v.student_id AND sc_scope.counselor_id = ?
         )`
      : '';
    const params = counselorProfileId ? [counselorProfileId] : [];

    const [visas] = await pool.query(
      `${visaListSelect} ${counselorFilter} ORDER BY v.created_at DESC`,
      params
    );

    for (const visa of visas) {
      const [docCount] = await pool.query(
        'SELECT COUNT(*) AS count FROM visa_documents WHERE visa_id = ?',
        [visa.id]
      );
      visa.documents_count = docCount[0].count;
    }

    res.json({ success: true, visas, total: visas.length });

  } catch (error) {
    console.error('Error fetching visas:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch visas',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// ============================================================
// CHANGED METHOD 2: GET /visas/statistics
// Updated to use new status values
// ============================================================
router.get('/visas/statistics', optionalAuthenticate, async (req, res) => {
  try {
    await ensureVisaSchema();
    const counselorProfileId = await getCounselorProfileId(req.user);
    const counselorFilter = counselorProfileId
      ? `WHERE EXISTS (
           SELECT 1 FROM student_counselors sc_scope
           WHERE sc_scope.user_id = visas.student_id AND sc_scope.counselor_id = ?
         )`
      : '';
    const params = counselorProfileId ? [counselorProfileId] : [];

    const [stats] = await pool.query(
      `
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN visa_status IN ('In Progress', 'To be applied') THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN visa_status = 'Applied' THEN 1 ELSE 0 END) AS applied,
        SUM(CASE WHEN visa_status = 'Approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN visa_status = 'Rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN visa_status = 'Reapplied' THEN 1 ELSE 0 END) AS reapplied,
        SUM(CASE WHEN visa_appointment_date >= CURDATE() 
                  AND visa_appointment_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
             THEN 1 ELSE 0 END) AS upcoming_appointments
      FROM visas
      ${counselorFilter}
    `,
      params
    );

    res.json({ success: true, statistics: stats[0] });

  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// ============================================================
// CHANGED METHOD 3: GET /visas/:visaId
// Added: institute, submission_date, submitted_by to SELECT
// ============================================================
router.get('/visas/:visaId', optionalAuthenticate, async (req, res) => {
  try {
    await ensureVisaSchema();
    const { visaId } = req.params;

    const [visas] = await pool.query(
      `${visaListSelect} WHERE v.id = ?`,
      [visaId]
    );

    if (visas.length === 0) {
      return res.status(404).json({ success: false, message: 'Visa not found' });
    }

    const counselorProfileId = await getCounselorProfileId(req.user);
    if (counselorProfileId) {
      const studentId = visas[0].student_id;
      if (!studentId) {
        return res.status(403).json({ success: false, message: 'Access denied for this visa' });
      }
      const [assigned] = await pool.query(
        'SELECT id FROM student_counselors WHERE user_id = ? AND counselor_id = ? LIMIT 1',
        [studentId, counselorProfileId]
      );
      if (!assigned.length) {
        return res.status(403).json({ success: false, message: 'Access denied for this visa' });
      }
    }

    const [documents] = await pool.query(
      'SELECT * FROM visa_documents WHERE visa_id = ? ORDER BY uploaded_at DESC',
      [visaId]
    );

    res.json({
      success: true,
      visa: visas[0],
      documents,
    });

  } catch (error) {
    console.error('Error fetching visa:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch visa',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// ============================================================
// CHANGED METHOD 4: POST /visas  (Create)
// Added: institute, submissionDate, submittedBy to body + INSERT
// ============================================================
router.post('/visas', async (req, res) => {
  const connection = await pool.getConnection();
  let copiedFiles = [];

  try {
    await ensureVisaSchema();
    await connection.beginTransaction();

    const {
      applicantName,
      applicantEmail,
      applicantPhone,
      countryId,
      visaNumber,
      visaType,
      visaStatus,
      mainApplicantName,
      mainApplicantRelation,
      mainApplicantInstitute,
      mainApplicantVisaCategory,
      mainApplicantVisaStatus,
      visaCategory,
      institute,
      submissionDate,
      submittedBy,
      biometrics,
      biometricsAppointmentDate,
      medicalTest,
      medicalBooked,
      medicalAppointmentDate,
      bankStatementRequirement,
      bankStatementAmountRequired,
      accommodationBooked,
      visaLink,
      visaWebsiteId,
      visaPassword,
      visaAppointment,
      visaAppointmentDate,
      studentId,
      transferFromStudentId,
      transferFromVisaId,
    } = req.body;

    if (!applicantName || !countryId || !visaType || !visaStatus) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Student name, country, visa type, and visa status are required',
      });
    }

    let resolvedStudentId = studentId || transferFromStudentId || null;
    if (!resolvedStudentId && transferFromVisaId) {
      const [srcVisa] = await connection.query(
        'SELECT student_id FROM visas WHERE id = ?',
        [transferFromVisaId]
      );
      if (srcVisa.length > 0 && srcVisa[0].student_id) {
        resolvedStudentId = srcVisa[0].student_id;
      }
    }

    const visaIdCode = await generateVisaId(connection);
    const resolvedAppointmentDate = visaAppointment === 'Yes' ? (visaAppointmentDate || null) : null;
    const resolvedBiometricsDate = biometrics === 'Yes' ? (biometricsAppointmentDate || null) : null;
    const resolvedMedicalDate = medicalBooked === 'Yes' ? (medicalAppointmentDate || null) : null;
    const resolvedMedicalTest = medicalBooked === 'Yes' ? (medicalTest || null) : null;
    const resolvedBankAmount = bankStatementRequirement === 'Yes' ? (bankStatementAmountRequired || null) : null;

    const [result] = await connection.query(
      `INSERT INTO visas 
       (visa_id, student_id, applicant_name, applicant_email, applicant_phone, country_id,
        visa_number, visa_type, visa_status, main_applicant_name, main_applicant_relation,
        main_applicant_institute, main_applicant_visa_category, main_applicant_visa_status,
        visa_category, institute, submission_date, submitted_by, biometrics,
        biometrics_appointment_date, medical_test, medical_booked, medical_appointment_date,
        bank_statement_requirement, bank_statement_amount_required,
        accommodation_booked, visa_link, visa_website_id, visa_password,
        visa_appointment, visa_appointment_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        visaIdCode,
        resolvedStudentId || null,
        applicantName,
        applicantEmail || null,
        applicantPhone || null,
        countryId,
        visaNumber || null,
        visaType,
        visaStatus,
        mainApplicantName || null,
        mainApplicantRelation || null,
        mainApplicantInstitute || null,
        mainApplicantVisaCategory || null,
        mainApplicantVisaStatus || null,
        visaCategory || null,
        institute || null,
        submissionDate || null,
        submittedBy || null,
        biometrics || null,
        resolvedBiometricsDate,
        resolvedMedicalTest,
        medicalBooked || null,
        resolvedMedicalDate,
        bankStatementRequirement || null,
        resolvedBankAmount,
        accommodationBooked || null,
        visaLink || null,
        visaWebsiteId || null,
        visaPassword || null,
        visaAppointment || null,
        resolvedAppointmentDate,
      ]
    );

    let transferredDocuments = 0;
    if (transferFromStudentId) {
      const transferResult = await transferStudentDocsToVisa(
        connection,
        transferFromStudentId,
        result.insertId
      );
      copiedFiles = transferResult.copiedFiles;
      transferredDocuments = transferResult.transferred;
    } else if (transferFromVisaId) {
      const transferResult = await transferVisaDocsToVisa(
        connection,
        transferFromVisaId,
        result.insertId
      );
      copiedFiles = transferResult.copiedFiles;
      transferredDocuments = transferResult.transferred;
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Visa created successfully',
      visaId: result.insertId,
      generatedVisaId: visaIdCode,
      transferredDocuments,
    });

  } catch (error) {
    await connection.rollback();
    cleanupCopiedFiles(copiedFiles);
    console.error('Error creating visa:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while creating the visa',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});


// ============================================================
// CHANGED METHOD 5: PUT /visas/:visaId  (Update)
// Added: institute, submissionDate, submittedBy to body + UPDATE SET
// ============================================================
router.put('/visas/:visaId', async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await ensureVisaSchema();
    await connection.beginTransaction();

    const { visaId } = req.params;
    const {
      applicantName,
      applicantEmail,
      applicantPhone,
      countryId,
      visaNumber,
      visaType,
      visaStatus,
      mainApplicantName,
      mainApplicantRelation,
      mainApplicantInstitute,
      mainApplicantVisaCategory,
      mainApplicantVisaStatus,
      visaCategory,
      institute,
      submissionDate,
      submittedBy,
      biometrics,
      biometricsAppointmentDate,
      medicalTest,
      medicalBooked,
      medicalAppointmentDate,
      bankStatementRequirement,
      bankStatementAmountRequired,
      accommodationBooked,
      visaLink,
      visaWebsiteId,
      visaPassword,
      visaAppointment,
      visaAppointmentDate,
    } = req.body;

    const [existing] = await connection.query(
      'SELECT id FROM visas WHERE id = ?',
      [visaId]
    );

    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Visa not found' });
    }

    if (!applicantName || !countryId || !visaType || !visaStatus) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Student name, country, visa type, and visa status are required',
      });
    }

    const resolvedAppointmentDate = visaAppointment === 'Yes' ? (visaAppointmentDate || null) : null;
    const resolvedBiometricsDate = biometrics === 'Yes' ? (biometricsAppointmentDate || null) : null;
    const resolvedMedicalDate = medicalBooked === 'Yes' ? (medicalAppointmentDate || null) : null;
    const resolvedMedicalTest = medicalBooked === 'Yes' ? (medicalTest || null) : null;
    const resolvedBankAmount = bankStatementRequirement === 'Yes' ? (bankStatementAmountRequired || null) : null;

    await connection.query(
      `UPDATE visas SET
         applicant_name = ?, applicant_email = ?, applicant_phone = ?, country_id = ?,
         visa_number = ?, visa_type = ?, visa_status = ?,
         main_applicant_name = ?, main_applicant_relation = ?,
         main_applicant_institute = ?, main_applicant_visa_category = ?,
         main_applicant_visa_status = ?, visa_category = ?,
         institute = ?, submission_date = ?, submitted_by = ?,
         biometrics = ?, biometrics_appointment_date = ?,
         medical_test = ?, medical_booked = ?, medical_appointment_date = ?,
         bank_statement_requirement = ?, bank_statement_amount_required = ?,
         accommodation_booked = ?, visa_link = ?, visa_website_id = ?,
         visa_password = ?, visa_appointment = ?, visa_appointment_date = ?
       WHERE id = ?`,
      [
        applicantName,
        applicantEmail || null,
        applicantPhone || null,
        countryId,
        visaNumber || null,
        visaType,
        visaStatus,
        mainApplicantName || null,
        mainApplicantRelation || null,
        mainApplicantInstitute || null,
        mainApplicantVisaCategory || null,
        mainApplicantVisaStatus || null,
        visaCategory || null,
        institute || null,
        submissionDate || null,
        submittedBy || null,
        biometrics || null,
        resolvedBiometricsDate,
        resolvedMedicalTest,
        medicalBooked || null,
        resolvedMedicalDate,
        bankStatementRequirement || null,
        resolvedBankAmount,
        accommodationBooked || null,
        visaLink || null,
        visaWebsiteId || null,
        visaPassword || null,
        visaAppointment || null,
        resolvedAppointmentDate,
        visaId,
      ]
    );

    await connection.commit();

    res.json({ success: true, message: 'Visa updated successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating visa:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while updating the visa',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});


// ============================================================
// UNCHANGED METHODS BELOW — kept here for completeness
// DELETE /visas/:visaId, all file upload/delete routes
// are unchanged — no need to modify them.
// ============================================================

// Delete visa
router.delete('/visas/:visaId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureVisaSchema();
    await connection.beginTransaction();
    const { visaId } = req.params;

    const [existing] = await connection.query('SELECT id FROM visas WHERE id = ?', [visaId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Visa not found' });
    }

    const [documents] = await connection.query(
      'SELECT file_path FROM visa_documents WHERE visa_id = ?',
      [visaId]
    );

    await connection.query('DELETE FROM visa_documents WHERE visa_id = ?', [visaId]);
    await connection.query('DELETE FROM visas WHERE id = ?', [visaId]);
    await connection.commit();

    const deleteFile = (filePath) => {
      if (filePath) {
        const fullPath = absoluteFromPublicPath(filePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      }
    };

    documents.forEach((d) => deleteFile(d.file_path));

    res.json({ success: true, message: 'Visa deleted successfully' });

  } catch (error) {
    await connection.rollback();
    console.error('Error deleting visa:', error);
    res.status(500).json({ success: false, message: 'An error occurred while deleting the visa' });
  } finally {
    connection.release();
  }
});

router.post('/visas/:visaId/documents', upload.single('document'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureVisaSchema();
    await connection.beginTransaction();
    const { visaId } = req.params;
    const documentType = (req.body.documentType || '').trim();

    if (!req.file) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    if (!documentType) {
      await connection.rollback();
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Document type is required' });
    }

    const [visa] = await connection.query('SELECT id FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) {
      await connection.rollback();
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Visa not found' });
    }

    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    const [result] = await connection.query(
      `INSERT INTO visa_documents (visa_id, document_type, file_path, original_name)
       VALUES (?, ?, ?, ?)`,
      [visaId, documentType, filePath, req.file.originalname]
    );

    await connection.commit();
    res.json({
      success: true,
      message: 'Document uploaded successfully',
      document: {
        id: result.insertId,
        document_type: documentType,
        file_path: filePath,
        original_name: req.file.originalname,
        uploaded_at: new Date(),
      },
    });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading visa document:', error);
    res.status(500).json({ success: false, message: 'Failed to upload document' });
  } finally {
    connection.release();
  }
});

router.get('/visas/:visaId/documents', async (req, res) => {
  try {
    await ensureVisaSchema();
    const { visaId } = req.params;
    const [documents] = await pool.query(
      'SELECT * FROM visa_documents WHERE visa_id = ? ORDER BY uploaded_at DESC',
      [visaId]
    );
    res.json({ success: true, documents });
  } catch (error) {
    console.error('Error fetching visa documents:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch documents' });
  }
});

router.delete('/visas/:visaId/documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId, documentId } = req.params;
    const [docs] = await connection.query(
      'SELECT * FROM visa_documents WHERE id = ? AND visa_id = ?',
      [documentId, visaId]
    );
    if (docs.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Document not found' });
    }
    const full = absoluteFromPublicPath(docs[0].file_path);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    await connection.query('DELETE FROM visa_documents WHERE id = ?', [documentId]);
    await connection.commit();
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting visa document:', error);
    res.status(500).json({ success: false, message: 'Failed to delete document' });
  } finally {
    connection.release();
  }
});

// Legacy upload routes kept for older records
router.post('/visas/:visaId/fee-receipts', upload.single('feeReceipt'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const { receiptName } = req.body;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('INSERT INTO visa_fee_receipts (visa_id, receipt_name, file_path) VALUES (?, ?, ?)', [visaId, receiptName || 'Fee Receipt', filePath]);
    await connection.commit();
    res.json({ success: true, message: 'Fee receipt uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the fee receipt' });
  } finally { connection.release(); }
});

// Delete fee receipt
router.delete('/visas/:visaId/fee-receipts/:receiptId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId, receiptId } = req.params;
    const [receipt] = await connection.query('SELECT file_path FROM visa_fee_receipts WHERE id = ? AND visa_id = ?', [receiptId, visaId]);
    if (receipt.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Fee receipt not found' }); }
    await connection.query('DELETE FROM visa_fee_receipts WHERE id = ? AND visa_id = ?', [receiptId, visaId]);
    const filePath = absoluteFromPublicPath(receipt[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.commit();
    res.json({ success: true, message: 'Fee receipt deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the fee receipt' });
  } finally { connection.release(); }
});

// Upload birth certificate
router.post('/visas/:visaId/birth-certificate', upload.single('birthCertificate'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const [visa] = await connection.query('SELECT birth_certificate_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (visa[0].birth_certificate_path) { const old = absoluteFromPublicPath(visa[0].birth_certificate_path); if (fs.existsSync(old)) fs.unlinkSync(old); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('UPDATE visas SET birth_certificate_path = ? WHERE id = ?', [filePath, visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Birth certificate uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the birth certificate' });
  } finally { connection.release(); }
});

// Delete birth certificate
router.delete('/visas/:visaId/birth-certificate', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const [visa] = await connection.query('SELECT birth_certificate_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (!visa[0].birth_certificate_path) { await connection.rollback(); return res.status(404).json({ success: false, message: 'No birth certificate found' }); }
    const filePath = absoluteFromPublicPath(visa[0].birth_certificate_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.query('UPDATE visas SET birth_certificate_path = NULL WHERE id = ?', [visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Birth certificate deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the birth certificate' });
  } finally { connection.release(); }
});

// Upload financial document
router.post('/visas/:visaId/financial-documents', upload.single('financialDocument'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const { documentName } = req.body;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('INSERT INTO visa_financial_documents (visa_id, document_name, file_path) VALUES (?, ?, ?)', [visaId, documentName || 'Financial Document', filePath]);
    await connection.commit();
    res.json({ success: true, message: 'Financial document uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the financial document' });
  } finally { connection.release(); }
});

// Delete financial document
router.delete('/visas/:visaId/financial-documents/:documentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId, documentId } = req.params;
    const [document] = await connection.query('SELECT file_path FROM visa_financial_documents WHERE id = ? AND visa_id = ?', [documentId, visaId]);
    if (document.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Financial document not found' }); }
    await connection.query('DELETE FROM visa_financial_documents WHERE id = ? AND visa_id = ?', [documentId, visaId]);
    const filePath = absoluteFromPublicPath(document[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.commit();
    res.json({ success: true, message: 'Financial document deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the financial document' });
  } finally { connection.release(); }
});

// Upload travel history
router.post('/visas/:visaId/travel-history', upload.single('travelHistory'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const [visa] = await connection.query('SELECT travel_history_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (visa[0].travel_history_path) { const old = absoluteFromPublicPath(visa[0].travel_history_path); if (fs.existsSync(old)) fs.unlinkSync(old); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('UPDATE visas SET travel_history_path = ? WHERE id = ?', [filePath, visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Travel history uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the travel history' });
  } finally { connection.release(); }
});

// Delete travel history
router.delete('/visas/:visaId/travel-history', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    const [visa] = await connection.query('SELECT travel_history_path FROM visas WHERE id = ?', [visaId]);
    if (visa.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Visa not found' }); }
    if (!visa[0].travel_history_path) { await connection.rollback(); return res.status(404).json({ success: false, message: 'No travel history found' }); }
    const filePath = absoluteFromPublicPath(visa[0].travel_history_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.query('UPDATE visas SET travel_history_path = NULL WHERE id = ?', [visaId]);
    await connection.commit();
    res.json({ success: true, message: 'Travel history deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the travel history' });
  } finally { connection.release(); }
});

// Upload passport photo
router.post('/visas/:visaId/passport-photos', upload.single('passportPhoto'), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId } = req.params;
    if (!req.file) { await connection.rollback(); return res.status(400).json({ success: false, message: 'No file uploaded' }); }
    const filePath = `/uploads/visa-documents/${req.file.filename}`;
    await connection.query('INSERT INTO visa_passport_photos (visa_id, file_path) VALUES (?, ?)', [visaId, filePath]);
    await connection.commit();
    res.json({ success: true, message: 'Passport photo uploaded successfully', filePath });
  } catch (error) {
    await connection.rollback();
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: 'An error occurred while uploading the passport photo' });
  } finally { connection.release(); }
});

// Delete passport photo
router.delete('/visas/:visaId/passport-photos/:photoId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { visaId, photoId } = req.params;
    const [photo] = await connection.query('SELECT file_path FROM visa_passport_photos WHERE id = ? AND visa_id = ?', [photoId, visaId]);
    if (photo.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Passport photo not found' }); }
    await connection.query('DELETE FROM visa_passport_photos WHERE id = ? AND visa_id = ?', [photoId, visaId]);
    const filePath = absoluteFromPublicPath(photo[0].file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await connection.commit();
    res.json({ success: true, message: 'Passport photo deleted successfully' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ success: false, message: 'An error occurred while deleting the passport photo' });
  } finally { connection.release(); }
});

export default router;