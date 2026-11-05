import express from 'express';
import pool from '../config/db.js';
import {
  createOrUpdateCounselorUser,
  ensureCounselorUserLinkSchema,
} from '../utils/counselorAccess.js';

const router = express.Router();

// Validation helper functions
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

// Generate counselor ID
const generateCounselorId = async (connection) => {
  const [result] = await connection.query(
    'SELECT MAX(CAST(SUBSTRING(counselor_id, 5) AS UNSIGNED)) as max_id FROM counselors'
  );
  
  const nextId = (result[0].max_id || 0) + 1;
  return `COUN${String(nextId).padStart(3, '0')}`;
};

// Get all counselors with meeting counts
router.get('/counselors', async (req, res) => {
  try {
    const [counselors] = await pool.query(
      `SELECT c.*, 
              COUNT(DISTINCT sc.user_id) as number_of_students,
              COUNT(DISTINCT CASE WHEN l.is_registered = FALSE OR l.is_registered = 0 THEN lca.lead_id END) as number_of_leads,
              COUNT(DISTINCT cm.id) as total_meetings,
              COUNT(DISTINCT CASE WHEN cm.status = 'Scheduled' THEN cm.id END) as scheduled_meetings,
              COUNT(DISTINCT CASE WHEN cm.status = 'Completed' THEN cm.id END) as completed_meetings
       FROM counselors c
       LEFT JOIN student_counselors sc ON c.id = sc.counselor_id
       LEFT JOIN lead_counselor_assignments lca ON c.id = lca.counselor_id
       LEFT JOIN leads l ON l.id = lca.lead_id
       LEFT JOIN counselor_meetings cm ON c.id = cm.counselor_id
       GROUP BY c.id
       ORDER BY c.created_at DESC`
    );
    
    res.json({
      success: true,
      counselors: counselors,
      total: counselors.length
    });
    
  } catch (error) {
    console.error('Error fetching counselors:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch counselors',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// Get single counselor by ID with meetings
router.get('/counselors/:counselorId', async (req, res) => {
  try {
    const { counselorId } = req.params;
    
    const [counselors] = await pool.query(
      `SELECT c.*, 
              COUNT(DISTINCT cm.id) as total_meetings
       FROM counselors c
       LEFT JOIN counselor_meetings cm ON c.id = cm.counselor_id
       WHERE c.id = ?
       GROUP BY c.id`,
      [counselorId]
    );
    
    if (counselors.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }
    
    // Get meetings for this counselor
    const [meetings] = await pool.query(
      `SELECT cm.*, 
              COALESCE(l.full_name, u.name) as client_name,
              COALESCE(CONCAT('LEAD-', l.id), CONCAT('STU-', u.id)) as client_id,
              CASE WHEN l.id IS NOT NULL THEN 'lead' ELSE 'student' END as client_type
       FROM counselor_meetings cm
       LEFT JOIN leads l ON cm.lead_id = l.id
       LEFT JOIN users u ON cm.user_id = u.id
       WHERE cm.counselor_id = ? 
       ORDER BY cm.meeting_date DESC, cm.meeting_time DESC`,
      [counselorId]
    );
    
    // Get assigned leads
    const [leads] = await pool.query(
      `SELECT l.id, l.full_name, l.email, l.phone, l.interest, l.program,
              l.countries_of_interest, l.countries_other, l.status, l.created_at, lca.assigned_at
       FROM leads l
       INNER JOIN lead_counselor_assignments lca ON l.id = lca.lead_id
       WHERE lca.counselor_id = ? AND (l.is_registered = FALSE OR l.is_registered = 0)
       ORDER BY lca.assigned_at DESC`,
      [counselorId]
    );
    
    // Get assigned students
    const [students] = await pool.query(
      `SELECT u.id, u.student_id, u.name, u.middle_name, u.surname, u.email, u.mobile,
              u.country, u.status, u.created_at, sc.assigned_at
       FROM users u
       INNER JOIN student_counselors sc ON u.id = sc.user_id
       WHERE sc.counselor_id = ?
       ORDER BY sc.assigned_at DESC`,
      [counselorId]
    );
    
    res.json({
      success: true,
      counselor: counselors[0],
      meetings: meetings,
      assignedLeads: leads,
      assignedStudents: students
    });
    
  } catch (error) {
    console.error('Error fetching counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new counselor
router.post('/counselors', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { name, email, phone, experience, expertise, status } = req.body;
    
    // Validate required fields
    if (!name || !email || !phone || !experience || !expertise) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }

    // Validate phone format
    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid phone number (minimum 10 digits)' 
      });
    }

    // Validate name length
    if (trimmedName.length < 3) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Name must be at least 3 characters long' 
      });
    }

    // Check if email already exists
    const [existingCounselor] = await connection.query(
      'SELECT id, name, email FROM counselors WHERE email = ?',
      [trimmedEmail]
    );
    
    if (existingCounselor.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'A counselor with this email address already exists',
        existingCounselor: {
          name: existingCounselor[0].name,
          email: existingCounselor[0].email
        }
      });
    }

    // Generate counselor ID
    const counselorId = await generateCounselorId(connection);
    
    await ensureCounselorUserLinkSchema();

    // Create login account (password = firstName + "123@")
    const { userId: linkedUserId, plain, skippedRoleChange } = await createOrUpdateCounselorUser({
      name: trimmedName,
      email: trimmedEmail,
      connection,
      resetPassword: true,
    });

    // Insert counselor
    let result;
    try {
      [result] = await connection.query(
        `INSERT INTO counselors (counselor_id, name, email, phone, experience, expertise, status, number_of_students, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [counselorId, trimmedName, trimmedEmail, trimmedPhone, experience.trim(), expertise.trim(), status || 'Active', linkedUserId || null]
      );
    } catch (insertErr) {
      if (insertErr.code !== 'ER_BAD_FIELD_ERROR') throw insertErr;
      [result] = await connection.query(
        `INSERT INTO counselors (counselor_id, name, email, phone, experience, expertise, status, number_of_students)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [counselorId, trimmedName, trimmedEmail, trimmedPhone, experience.trim(), expertise.trim(), status || 'Active']
      );
    }
    
    const newCounselorId = result.insertId;
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: skippedRoleChange
        ? 'Counselor added, but login could not be created because this email already belongs to another account type.'
        : 'Counselor added successfully!',
      counselorId: newCounselorId,
      generatedId: counselorId,
      loginEmail: trimmedEmail,
      temporaryPassword: skippedRoleChange ? null : plain,
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error creating counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while adding the counselor. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Update counselor
router.put('/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId } = req.params;
    const { name, email, phone, experience, expertise, status } = req.body;
    
    // Validate required fields
    if (!name || !email || !phone || !experience || !expertise) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Trim inputs
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();

    // Validate email format
    if (!validateEmail(trimmedEmail)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid email address' 
      });
    }

    // Validate phone format
    if (!validatePhone(trimmedPhone)) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide a valid phone number (minimum 10 digits)' 
      });
    }

    // Check if counselor exists
    const [existingCounselor] = await connection.query(
      'SELECT id FROM counselors WHERE id = ?',
      [counselorId]
    );
    
    if (existingCounselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }

    // Check if email is being changed to one that already exists
    const [emailCheck] = await connection.query(
      'SELECT id FROM counselors WHERE email = ? AND id != ?',
      [trimmedEmail, counselorId]
    );
    
    if (emailCheck.length > 0) {
      await connection.rollback();
      return res.status(409).json({ 
        success: false, 
        message: 'This email address is already associated with another counselor' 
      });
    }
    
    await ensureCounselorUserLinkSchema();
    const { userId: linkedUserId } = await createOrUpdateCounselorUser({
      name: trimmedName,
      email: trimmedEmail,
      connection,
    });

    // Update counselor
    try {
      await connection.query(
        `UPDATE counselors 
         SET name = ?, email = ?, phone = ?, experience = ?, expertise = ?, status = ?, user_id = COALESCE(?, user_id)
         WHERE id = ?`,
        [trimmedName, trimmedEmail, trimmedPhone, experience.trim(), expertise.trim(), status || 'Active', linkedUserId || null, counselorId]
      );
    } catch (updateErr) {
      if (updateErr.code !== 'ER_BAD_FIELD_ERROR') throw updateErr;
      await connection.query(
        `UPDATE counselors 
         SET name = ?, email = ?, phone = ?, experience = ?, expertise = ?, status = ?
         WHERE id = ?`,
        [trimmedName, trimmedEmail, trimmedPhone, experience.trim(), expertise.trim(), status || 'Active', counselorId]
      );
    }
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Counselor updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while updating the counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete counselor
router.delete('/counselors/:counselorId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId } = req.params;
    
    // Check if counselor exists
    const [existingCounselor] = await connection.query(
      'SELECT id, name FROM counselors WHERE id = ?',
      [counselorId]
    );
    
    if (existingCounselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }
    
    // Delete counselor (meetings will be deleted automatically due to CASCADE)
    await connection.query('DELETE FROM counselors WHERE id = ?', [counselorId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Counselor deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting counselor:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the counselor',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Add meeting to counselor
router.post('/counselors/:counselorId/meetings', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId } = req.params;
    const { studentName, studentId, meetingDate, meetingTime, notes } = req.body;
    
    // Validate required fields
    if (!studentName || !studentId || !meetingDate || !meetingTime) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'All required fields must be provided' 
      });
    }

    // Check if counselor exists
    const [existingCounselor] = await connection.query(
      'SELECT id FROM counselors WHERE id = ?',
      [counselorId]
    );
    
    if (existingCounselor.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Counselor not found' 
      });
    }
    
    // Insert meeting
    await connection.query(
      `INSERT INTO counselor_meetings (counselor_id, student_name, student_id, meeting_date, meeting_time, status, notes)
       VALUES (?, ?, ?, ?, ?, 'Scheduled', ?)`,
      [counselorId, studentName.trim(), studentId.trim(), meetingDate, meetingTime, notes?.trim() || null]
    );
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Meeting scheduled successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error adding meeting:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while scheduling the meeting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});

// Delete meeting
router.delete('/counselors/:counselorId/meetings/:meetingId', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { counselorId, meetingId } = req.params;
    
    // Check if meeting exists
    const [existingMeeting] = await connection.query(
      'SELECT id FROM counselor_meetings WHERE id = ? AND counselor_id = ?',
      [meetingId, counselorId]
    );
    
    if (existingMeeting.length === 0) {
      await connection.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Meeting not found' 
      });
    }
    
    // Delete meeting
    await connection.query('DELETE FROM counselor_meetings WHERE id = ?', [meetingId]);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Meeting deleted successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting meeting:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while deleting the meeting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
});


// Get leads assigned to a counselor
router.get('/counselors/:counselorId/leads', async (req, res) => {
  try {
    const { counselorId } = req.params;
    
    const [leads] = await pool.query(
      `SELECT l.*, lca.assigned_at
       FROM leads l
       INNER JOIN lead_counselor_assignments lca ON l.id = lca.lead_id
       WHERE lca.counselor_id = ? AND l.is_registered = FALSE
       ORDER BY lca.assigned_at DESC`,
      [counselorId]
    );
    
    res.json({
      success: true,
      leads: leads
    });
    
  } catch (error) {
    console.error('Error fetching counselor leads:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch assigned leads',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get students assigned to a counselor (converted from leads)
router.get('/counselors/:counselorId/students', async (req, res) => {
  try {
    const { counselorId } = req.params;
    
    const [students] = await pool.query(
      `SELECT u.id, u.name, u.email, sc.assigned_at, sc.transferred_from_lead_id
       FROM users u
       INNER JOIN student_counselors sc ON u.id = sc.user_id
       WHERE sc.counselor_id = ?
       ORDER BY sc.assigned_at DESC`,
      [counselorId]
    );
    
    res.json({
      success: true,
      students: students
    });
    
  } catch (error) {
    console.error('Error fetching counselor students:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch assigned students',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});




export default router;