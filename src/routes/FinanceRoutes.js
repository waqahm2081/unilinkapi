import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// ============================================================
// HELPER: Generate Invoice ID
// ============================================================
const generateInvoiceId = async (connection) => {
  const currentYear = new Date().getFullYear();
  const [result] = await connection.query(
    `SELECT MAX(CAST(SUBSTRING(invoice_id, 8) AS UNSIGNED)) as max_id
     FROM invoices
     WHERE invoice_id LIKE 'INV${currentYear}%'`
  );
  const nextId = (result[0].max_id || 0) + 1;
  return `INV${currentYear}${String(nextId).padStart(3, '0')}`;
};

// ============================================================
// MIGRATION — run GET /finance/migrate to apply safely
// ============================================================
router.get('/finance/migrate', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // payment_method column
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS payment_method ENUM('bank','cash') NOT NULL DEFAULT 'bank'
    `).catch(() => {});

    // show_converted_currency flag
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS show_converted_currency TINYINT(1) NOT NULL DEFAULT 1
    `).catch(() => {});

    // manual student columns on invoices
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS is_manual_student TINYINT(1) NOT NULL DEFAULT 0
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_name VARCHAR(255) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_email VARCHAR(255) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_mobile VARCHAR(50) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS manual_student_country VARCHAR(100) NULL
    `).catch(() => {});

    await connection.query(`
      ALTER TABLE invoice_country_services
      ADD COLUMN IF NOT EXISTS country_id INT NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoice_country_services
      ADD COLUMN IF NOT EXISTS country_name VARCHAR(255) NULL
    `).catch(() => {});

    // per-invoice selected default services
    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_selected_default_services (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id  INT NOT NULL,
        service_id  INT,
        service_name VARCHAR(255) NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `).catch(() => {});

    // multi-student university commission table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_commission_students (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id          INT NOT NULL,
        student_id          INT NULL,
        student_name        VARCHAR(255) NOT NULL,
        student_ref_id      VARCHAR(100) NULL,
        student_email       VARCHAR(255) NULL,
        student_mobile      VARCHAR(50) NULL,
        is_manual           TINYINT(1) NOT NULL DEFAULT 0,
        commission_amount   DECIMAL(15,2) NOT NULL DEFAULT 0,
        university_name     VARCHAR(255) NULL,
        commission_reference VARCHAR(255) NULL,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `).catch(() => {});

    // manual student columns on invoice_agent_students
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS is_manual TINYINT(1) NOT NULL DEFAULT 0
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS student_email VARCHAR(255) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS student_mobile VARCHAR(50) NULL
    `).catch(() => {});
    await connection.query(`
      ALTER TABLE invoice_agent_students
      ADD COLUMN IF NOT EXISTS student_country VARCHAR(100) NULL
    `).catch(() => {});

    // Payment installment history
    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id   INT NOT NULL,
        amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
        payment_date DATE NOT NULL,
        notes        TEXT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invoice_payments_invoice (invoice_id),
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `).catch(() => {});

    // Backfill one history row for invoices that already have a paid total
    await connection.query(`
      INSERT INTO invoice_payments (invoice_id, amount, payment_date, notes)
      SELECT i.id, i.paid_amount, COALESCE(i.payment_date, i.invoice_date, CURDATE()), 'Migrated existing payment'
      FROM invoices i
      LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.paid_amount IS NOT NULL AND i.paid_amount > 0 AND p.id IS NULL
    `).catch(() => {});

    await ensureInvoiceInstallmentSchema(connection);

    await ensureFinanceLedgerSchema(connection);

    res.json({ success: true, message: 'Migration applied successfully' });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
});

// ============================================================
// HELPERS — invoice payment history
// ============================================================
const syncLeadPaymentStatus = async (connection, invoiceId, paymentStatus) => {
  const leadPaymentStatus = paymentStatus === 'Paid'
    ? 'Paid'
    : paymentStatus === 'Partially Paid'
      ? 'Partially Paid'
      : 'Unpaid';
  await connection.query(
    'UPDATE leads SET payment_status = ? WHERE invoice_id = ?',
    [leadPaymentStatus, invoiceId]
  ).catch(() => {});
};

const columnExists = async (db, tableName, columnName) => {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return (rows[0]?.cnt || 0) > 0;
};

const tableExists = async (db, tableName) => {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );
  return (rows[0]?.cnt || 0) > 0;
};

const ensureInvoiceInstallmentSchema = async (connection) => {
  // Use pool for DDL so we never ALTER inside an open invoice transaction
  // (MySQL auto-commits DDL and can leave creates half-applied).
  const db = pool;

  if (!(await columnExists(db, 'invoices', 'has_installment_plan'))) {
    try {
      await db.query(
        `ALTER TABLE invoices
         ADD COLUMN has_installment_plan TINYINT(1) NOT NULL DEFAULT 0`
      );
    } catch (err) {
      if (!/Duplicate column/i.test(err.message || '')) {
        console.warn('ensure has_installment_plan:', err.message);
      }
    }
  }

  if (!(await columnExists(db, 'invoices', 'advance_amount'))) {
    try {
      await db.query(
        `ALTER TABLE invoices
         ADD COLUMN advance_amount DECIMAL(15,2) NOT NULL DEFAULT 0`
      );
    } catch (err) {
      if (!/Duplicate column/i.test(err.message || '')) {
        console.warn('ensure advance_amount:', err.message);
      }
    }
  }

  if (!(await tableExists(db, 'invoice_installments'))) {
    try {
      await db.query(`
        CREATE TABLE invoice_installments (
          id                  INT AUTO_INCREMENT PRIMARY KEY,
          invoice_id          INT NOT NULL,
          installment_number  INT NOT NULL,
          amount              DECIMAL(15,2) NOT NULL DEFAULT 0,
          due_date            DATE NOT NULL,
          status              ENUM('Pending','Paid','Partial') NOT NULL DEFAULT 'Pending',
          paid_amount         DECIMAL(15,2) NOT NULL DEFAULT 0,
          created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_invoice_installments_invoice (invoice_id)
        )
      `);
    } catch (err) {
      if (!/already exists/i.test(err.message || '')) {
        console.warn('ensure invoice_installments:', err.message);
      }
    }
  }

  // Keep signature compatible; connection arg unused for DDL
  void connection;
};

const fetchInvoiceInstallments = async (db, invoiceId) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM invoice_installments
       WHERE invoice_id = ?
       ORDER BY installment_number ASC, id ASC`,
      [invoiceId]
    );
    return rows;
  } catch {
    return [];
  }
};

const saveInvoiceInstallmentPlan = async (connection, invoiceId, {
  hasInstallmentPlan = false,
  advanceAmount = 0,
  installments = [],
}) => {
  await ensureInvoiceInstallmentSchema(connection);
  const enabled = !!hasInstallmentPlan;
  const advance = Math.max(0, parseFloat(advanceAmount) || 0);

  await connection.query(
    `UPDATE invoices SET has_installment_plan = ?, advance_amount = ? WHERE id = ?`,
    [enabled ? 1 : 0, advance, invoiceId]
  );

  await connection.query('DELETE FROM invoice_installments WHERE invoice_id = ?', [invoiceId]);

  if (!enabled || !Array.isArray(installments) || installments.length === 0) return;

  let number = 1;
  for (const row of installments) {
    const amount = parseFloat(row.amount ?? row.installment_amount) || 0;
    const dueDate = row.dueDate || row.due_date;
    if (!dueDate || amount <= 0) continue;
    await connection.query(
      `INSERT INTO invoice_installments
         (invoice_id, installment_number, amount, due_date, status, paid_amount)
       VALUES (?, ?, ?, ?, 'Pending', 0)`,
      [invoiceId, number, amount, dueDate]
    );
    number += 1;
  }
};

/** Allocate payments beyond the advance toward planned installments (in order). */
const allocatePaymentsToInstallments = async (connection, invoiceId) => {
  try {
    await ensureInvoiceInstallmentSchema(connection);
    const [invRows] = await connection.query(
      'SELECT advance_amount, has_installment_plan FROM invoices WHERE id = ?',
      [invoiceId]
    );
    if (!invRows.length || !invRows[0].has_installment_plan) return;

    const advance = parseFloat(invRows[0].advance_amount) || 0;
    const payments = await fetchInvoicePayments(connection, invoiceId);
    const totalPaid = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    let remaining = Math.max(0, Math.round((totalPaid - advance) * 100) / 100);

    const installments = await fetchInvoiceInstallments(connection, invoiceId);
    for (const inst of installments) {
      const due = parseFloat(inst.amount) || 0;
      const paidToward = Math.min(due, remaining);
      remaining = Math.round((remaining - paidToward) * 100) / 100;
      let status = 'Pending';
      if (paidToward + 0.001 >= due && due > 0) status = 'Paid';
      else if (paidToward > 0) status = 'Partial';
      await connection.query(
        `UPDATE invoice_installments SET paid_amount = ?, status = ? WHERE id = ?`,
        [paidToward, status, inst.id]
      );
    }
  } catch (err) {
    console.warn('allocatePaymentsToInstallments:', err.message);
  }
};

const recomputeInvoicePaymentTotals = async (connection, invoiceId, statusOverride = null) => {
  const [invRows] = await connection.query(
    'SELECT final_amount FROM invoices WHERE id = ?',
    [invoiceId]
  );
  if (invRows.length === 0) return null;

  const [sumRows] = await connection.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_paid, MAX(payment_date) AS last_payment_date
     FROM invoice_payments WHERE invoice_id = ?`,
    [invoiceId]
  );

  const totalPaid = parseFloat(sumRows[0]?.total_paid) || 0;
  const lastDate = sumRows[0]?.last_payment_date || null;
  const finalAmount = parseFloat(invRows[0].final_amount) || 0;

  let paymentStatus;
  if (statusOverride === 'Cancelled') {
    paymentStatus = 'Cancelled';
  } else if (totalPaid <= 0) {
    paymentStatus = 'Pending';
  } else if (totalPaid + 0.001 >= finalAmount) {
    paymentStatus = 'Paid';
  } else {
    paymentStatus = 'Partially Paid';
  }

  await connection.query(
    `UPDATE invoices SET paid_amount = ?, payment_date = ?, payment_status = ? WHERE id = ?`,
    [totalPaid, lastDate, paymentStatus, invoiceId]
  );
  await syncLeadPaymentStatus(connection, invoiceId, paymentStatus);
  await allocatePaymentsToInstallments(connection, invoiceId);

  return { totalPaid, lastDate, paymentStatus };
};

const toYMD = (value) => {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const raw = String(value);
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return '';
};

const inDateRange = (ymd, from, to) => {
  if (!ymd) return false;
  if (from && ymd < from) return false;
  if (to && ymd > to) return false;
  return true;
};

const beforeDateRange = (ymd, from) => {
  if (!ymd) return false;
  if (!from) return false;
  return ymd < from;
};

const addLedgerAmount = (bucket, amount, ymd, from, to) => {
  const n = parseFloat(amount) || 0;
  if (n <= 0) return;
  bucket.lifetime += n;
  if (inDateRange(ymd, from, to)) bucket.period += n;
  if (beforeDateRange(ymd, from)) bucket.before += n;
};

const ensureFinanceLedgerSchema = async (connection) => {
  const db = connection || pool;
  await db.query(`
    ALTER TABLE bank_accounts
    ADD COLUMN IF NOT EXISTS opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0
  `).catch(async () => {
    try {
      await db.query(`ALTER TABLE bank_accounts ADD COLUMN opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0`);
    } catch { /* already exists */ }
  });

  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_settings (
      id INT PRIMARY KEY,
      cash_opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `).catch(() => {});

  await db.query(`
    INSERT IGNORE INTO finance_settings (id, cash_opening_balance) VALUES (1, 0)
  `).catch(() => {});

  await db.query(`
    ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS payment_source ENUM('bank','cash') NOT NULL DEFAULT 'cash'
  `).catch(async () => {
    try {
      await db.query(`ALTER TABLE expenses ADD COLUMN payment_source ENUM('bank','cash') NOT NULL DEFAULT 'cash'`);
    } catch { /* already exists */ }
  });

  await db.query(`
    ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS bank_account_id INT NULL
  `).catch(async () => {
    try {
      await db.query(`ALTER TABLE expenses ADD COLUMN bank_account_id INT NULL`);
    } catch { /* already exists */ }
  });
};

const getCashOpeningBalance = async (db) => {
  try {
    const [rows] = await db.query('SELECT cash_opening_balance FROM finance_settings WHERE id = 1');
    return parseFloat(rows[0]?.cash_opening_balance) || 0;
  } catch {
    return 0;
  }
};

const loadInvoiceLedgerRows = async (db) => {
  try {
    const [rows] = await db.query(`
      SELECT p.amount, DATE_FORMAT(p.payment_date, '%Y-%m-%d') AS payment_date,
             i.bank_account_id, i.payment_method, i.invoice_type, i.payment_status
      FROM invoice_payments p
      INNER JOIN invoices i ON i.id = p.invoice_id
      WHERE i.payment_status IN ('Paid', 'Partially Paid')
    `);
    if (rows.length > 0) return rows;

    const [fallback] = await db.query(`
      SELECT COALESCE(paid_amount, 0) AS amount,
             DATE_FORMAT(COALESCE(payment_date, invoice_date), '%Y-%m-%d') AS payment_date,
             bank_account_id, payment_method, invoice_type, payment_status
      FROM invoices
      WHERE payment_status IN ('Paid', 'Partially Paid')
        AND COALESCE(paid_amount, 0) > 0
    `);
    return fallback;
  } catch {
    const [fallback] = await db.query(`
      SELECT COALESCE(paid_amount, 0) AS amount,
             DATE_FORMAT(COALESCE(payment_date, invoice_date), '%Y-%m-%d') AS payment_date,
             bank_account_id, payment_method, invoice_type, payment_status
      FROM invoices
      WHERE payment_status IN ('Paid', 'Partially Paid')
        AND COALESCE(paid_amount, 0) > 0
    `);
    return fallback;
  }
};

const buildFinanceOverview = async (db, dateFrom, dateTo) => {
  const [accounts] = await db.query(
    `SELECT id, account_name, bank_name, account_number, currency, status, opening_balance
     FROM bank_accounts
     ORDER BY status ASC, account_name ASC`
  );
  const cashOpening = await getCashOpeningBalance(db);
  const invoiceRows = await loadInvoiceLedgerRows(db);

  let expenseRows = [];
  try {
    const [rows] = await db.query(`
      SELECT amount, DATE_FORMAT(expense_date, '%Y-%m-%d') AS expense_date, bank_account_id, payment_source, payment_mode
      FROM expenses
    `);
    expenseRows = rows;
  } catch {
    expenseRows = [];
  }

  const cashCredit = { lifetime: 0, period: 0, before: 0 };
  const cashDebit = { lifetime: 0, period: 0, before: 0 };
  const bankMap = {};
  accounts.forEach((acc) => {
    bankMap[acc.id] = {
      credit: { lifetime: 0, period: 0, before: 0 },
      debit: { lifetime: 0, period: 0, before: 0 },
    };
  });

  invoiceRows.forEach((row) => {
    const amount = parseFloat(row.amount) || 0;
    if (amount <= 0) return;
    const ymd = toYMD(row.payment_date);
    const isCash = row.payment_method === 'cash';
    const isPayout = row.invoice_type === 'Agent Commission';
    const target = isCash
      ? (isPayout ? cashDebit : cashCredit)
      : bankMap[row.bank_account_id]
        ? (isPayout ? bankMap[row.bank_account_id].debit : bankMap[row.bank_account_id].credit)
        : null;
    if (!target) return;
    addLedgerAmount(target, amount, ymd, dateFrom, dateTo);
  });

  expenseRows.forEach((row) => {
    const amount = parseFloat(row.amount) || 0;
    if (amount <= 0) return;
    const ymd = toYMD(row.expense_date);
    const isBank = row.payment_source === 'bank' && row.bank_account_id && bankMap[row.bank_account_id];
    const target = isBank ? bankMap[row.bank_account_id].debit : cashDebit;
    addLedgerAmount(target, amount, ymd, dateFrom, dateTo);
  });

  const finalize = (opening, credit, debit) => {
    const currentBalance = opening + credit.lifetime - debit.lifetime;
    const periodOpening = opening + credit.before - debit.before;
    const net = credit.period - debit.period;
    return {
      openingBalance: opening,
      periodOpening,
      periodCredit: credit.period,
      periodDebit: debit.period,
      periodNet: net,
      currentBalance,
    };
  };

  const bankAccounts = accounts.map((acc) => {
    const ledger = bankMap[acc.id];
    const opening = parseFloat(acc.opening_balance) || 0;
    return {
      id: acc.id,
      accountName: acc.account_name,
      bankName: acc.bank_name,
      accountNumber: acc.account_number,
      currency: acc.currency,
      status: acc.status,
      ...finalize(opening, ledger.credit, ledger.debit),
    };
  });

  const cash = {
    label: 'Cash',
    ...finalize(cashOpening, cashCredit, cashDebit),
  };

  const totals = bankAccounts.reduce((acc, bank) => {
    acc.periodOpening += bank.periodOpening;
    acc.periodCredit += bank.periodCredit;
    acc.periodDebit += bank.periodDebit;
    acc.currentBalance += bank.currentBalance;
    return acc;
  }, {
    periodOpening: cash.periodOpening,
    periodCredit: cash.periodCredit,
    periodDebit: cash.periodDebit,
    currentBalance: cash.currentBalance,
  });
  totals.periodNet = totals.periodCredit - totals.periodDebit;

  return { bankAccounts, cash, totals };
};

const loadBankAccountTransactions = async (db, accountId, dateFrom, dateTo) => {
  const transactions = [];
  const accountKey = Number(accountId);

  try {
    const [paymentRows] = await db.query(`
      SELECT p.amount,
             DATE_FORMAT(p.payment_date, '%Y-%m-%d') AS txn_date,
             i.invoice_id, i.invoice_type, i.payment_method, i.payment_status,
             i.student_name, i.manual_student_name, i.university_name,
             a.agent_name
      FROM invoice_payments p
      INNER JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN agents a ON a.id = i.agent_id
      WHERE i.bank_account_id = ?
        AND (i.payment_method IS NULL OR i.payment_method != 'cash')
        AND i.payment_status IN ('Paid', 'Partially Paid')
      ORDER BY p.payment_date DESC, p.id DESC
    `, [accountKey]);

    if (paymentRows.length === 0) {
      const [fallback] = await db.query(`
        SELECT COALESCE(paid_amount, 0) AS amount,
               DATE_FORMAT(COALESCE(payment_date, invoice_date), '%Y-%m-%d') AS txn_date,
               invoice_id, invoice_type, payment_method, payment_status,
               student_name, manual_student_name, university_name
        FROM invoices
        WHERE bank_account_id = ?
          AND (payment_method IS NULL OR payment_method != 'cash')
          AND payment_status IN ('Paid', 'Partially Paid')
          AND COALESCE(paid_amount, 0) > 0
      `, [accountKey]);

      fallback.forEach((row) => {
        const amount = parseFloat(row.amount) || 0;
        if (amount <= 0) return;
        const ymd = toYMD(row.txn_date);
        if ((dateFrom || dateTo) && !inDateRange(ymd, dateFrom, dateTo)) return;
        const isPayout = row.invoice_type === 'Agent Commission';
        const party = row.manual_student_name || row.student_name || row.university_name || 'Invoice';
        transactions.push({
          date: ymd,
          type: isPayout ? 'debit' : 'credit',
          amount,
          description: `${isPayout ? 'Agent payout' : 'Invoice payment'} — ${row.invoice_id} (${party})`,
          reference: row.invoice_id,
          source: isPayout ? 'Agent Commission' : 'Invoice Payment',
        });
      });
    } else {
      paymentRows.forEach((row) => {
        const amount = parseFloat(row.amount) || 0;
        if (amount <= 0) return;
        const ymd = toYMD(row.txn_date);
        if ((dateFrom || dateTo) && !inDateRange(ymd, dateFrom, dateTo)) return;

        const isPayout = row.invoice_type === 'Agent Commission';
        const party = isPayout
          ? (row.agent_name || 'Agent')
          : (row.manual_student_name || row.student_name || row.university_name || 'Invoice');
        const label = isPayout
          ? `Agent payout — ${row.invoice_id} (${party})`
          : `Invoice payment — ${row.invoice_id} (${party})`;

        transactions.push({
          date: ymd,
          type: isPayout ? 'debit' : 'credit',
          amount,
          description: label,
          reference: row.invoice_id,
          source: isPayout ? 'Agent Commission' : 'Invoice Payment',
        });
      });
    }
  } catch {
    const [fallback] = await db.query(`
      SELECT COALESCE(paid_amount, 0) AS amount,
             DATE_FORMAT(COALESCE(payment_date, invoice_date), '%Y-%m-%d') AS txn_date,
             invoice_id, invoice_type, payment_method, payment_status,
             student_name, manual_student_name, university_name
      FROM invoices
      WHERE bank_account_id = ?
        AND (payment_method IS NULL OR payment_method != 'cash')
        AND payment_status IN ('Paid', 'Partially Paid')
        AND COALESCE(paid_amount, 0) > 0
    `, [accountKey]);

    fallback.forEach((row) => {
      const amount = parseFloat(row.amount) || 0;
      if (amount <= 0) return;
      const ymd = toYMD(row.txn_date);
      if ((dateFrom || dateTo) && !inDateRange(ymd, dateFrom, dateTo)) return;
      const isPayout = row.invoice_type === 'Agent Commission';
      const party = row.manual_student_name || row.student_name || row.university_name || 'Invoice';
      transactions.push({
        date: ymd,
        type: isPayout ? 'debit' : 'credit',
        amount,
        description: `${isPayout ? 'Agent payout' : 'Invoice payment'} — ${row.invoice_id} (${party})`,
        reference: row.invoice_id,
        source: isPayout ? 'Agent Commission' : 'Invoice Payment',
      });
    });
  }

  try {
    const [expenseRows] = await db.query(`
      SELECT amount, DATE_FORMAT(expense_date, '%Y-%m-%d') AS txn_date,
             expense_id, name, category, description, payment_mode
      FROM expenses
      WHERE payment_source = 'bank' AND bank_account_id = ?
      ORDER BY expense_date DESC, id DESC
    `, [accountKey]);

    expenseRows.forEach((row) => {
      const amount = parseFloat(row.amount) || 0;
      if (amount <= 0) return;
      const ymd = toYMD(row.txn_date);
      if ((dateFrom || dateTo) && !inDateRange(ymd, dateFrom, dateTo)) return;
      transactions.push({
        date: ymd,
        type: 'debit',
        amount,
        description: `${row.category || 'Expense'} — ${row.name}${row.description ? ` (${row.description})` : ''}`,
        reference: row.expense_id,
        source: 'Expense',
      });
    });
  } catch { /* expenses table or columns may not exist yet */ }

  transactions.sort((a, b) => {
    if (a.date === b.date) return 0;
    return a.date < b.date ? 1 : -1;
  });

  const totals = transactions.reduce((acc, txn) => {
    if (txn.type === 'credit') acc.credit += txn.amount;
    else acc.debit += txn.amount;
    return acc;
  }, { credit: 0, debit: 0 });
  totals.net = totals.credit - totals.debit;

  return { transactions, totals };
};

const fetchInvoicePayments = async (db, invoiceId) => {
  try {
    const [payments] = await db.query(
      `SELECT id, invoice_id, amount, payment_date, notes, created_at
       FROM invoice_payments
       WHERE invoice_id = ?
       ORDER BY payment_date ASC, id ASC`,
      [invoiceId]
    );
    return payments;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return [];
    throw err;
  }
};

// ============================================================
// FINANCE OVERVIEW
// ============================================================

router.get('/finance/overview', async (req, res) => {
  try {
    await ensureFinanceLedgerSchema(pool);
    const { dateFrom, dateTo } = req.query;
    const overview = await buildFinanceOverview(pool, dateFrom || '', dateTo || '');
    res.json({ success: true, ...overview, dateFrom: dateFrom || null, dateTo: dateTo || null });
  } catch (error) {
    console.error('Error fetching finance overview:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch finance overview' });
  }
});

router.put('/finance/cash-opening', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureFinanceLedgerSchema(connection);
    const amount = parseFloat(req.body.cashOpeningBalance);
    if (!isFinite(amount) || amount < 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'A valid cash opening balance is required' });
    }
    await connection.query(
      `INSERT INTO finance_settings (id, cash_opening_balance) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE cash_opening_balance = VALUES(cash_opening_balance)`,
      [amount]
    );
    await connection.commit();
    res.json({ success: true, message: 'Cash opening balance updated', cashOpeningBalance: amount });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating cash opening:', error);
    res.status(500).json({ success: false, message: 'Failed to update cash opening balance' });
  } finally {
    connection.release();
  }
});

// ============================================================
// BANK ACCOUNTS
// ============================================================

router.get('/finance/bank-accounts', async (req, res) => {
  try {
    await ensureFinanceLedgerSchema(pool);
    const [accounts] = await pool.query(
      `SELECT ba.*,
        (SELECT COALESCE(SUM(i.final_amount),0) 
         FROM invoices i 
         WHERE i.bank_account_id = ba.id 
           AND i.payment_status = 'Paid'
           AND MONTH(i.invoice_date) = MONTH(CURDATE())
           AND YEAR(i.invoice_date) = YEAR(CURDATE())) as monthly_credit,
        (SELECT COALESCE(SUM(i.final_amount),0)
         FROM invoices i
         WHERE i.bank_account_id = ba.id
           AND i.payment_status IN ('Pending','Partially Paid')
           AND MONTH(i.invoice_date) = MONTH(CURDATE())
           AND YEAR(i.invoice_date) = YEAR(CURDATE())) as monthly_pending,
        (SELECT COUNT(*) FROM invoices i WHERE i.bank_account_id = ba.id) as total_invoices
       FROM bank_accounts ba
       ORDER BY ba.created_at DESC`
    );
    res.json({ success: true, accounts, total: accounts.length });
  } catch (error) {
    console.error('Error fetching bank accounts:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bank accounts' });
  }
});

router.get('/finance/bank-accounts/:accountId/transactions', async (req, res) => {
  try {
    await ensureFinanceLedgerSchema(pool);
    const { accountId } = req.params;
    const { dateFrom, dateTo } = req.query;

    const [accounts] = await pool.query(
      'SELECT id, account_name, bank_name, account_number, currency, opening_balance FROM bank_accounts WHERE id = ?',
      [accountId]
    );
    if (accounts.length === 0) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }

    const { transactions, totals } = await loadBankAccountTransactions(
      pool,
      accountId,
      dateFrom || '',
      dateTo || ''
    );

    res.json({
      success: true,
      account: accounts[0],
      transactions,
      totals,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
    });
  } catch (error) {
    console.error('Error fetching bank transactions:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bank transactions' });
  }
});

router.get('/finance/bank-accounts/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const [accounts] = await pool.query('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
    if (accounts.length === 0) return res.status(404).json({ success: false, message: 'Bank account not found' });
    res.json({ success: true, account: accounts[0] });
  } catch (error) {
    console.error('Error fetching bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bank account' });
  }
});

router.post('/finance/bank-accounts', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { accountName, bankName, accountNumber, iban, branchName, branchCode, currency, status, openingBalance } = req.body;
    if (!accountName || !bankName || !accountNumber) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Account name, bank name, and account number are required' });
    }
    await ensureFinanceLedgerSchema(connection);
    const [result] = await connection.query(
      `INSERT INTO bank_accounts (account_name, bank_name, account_number, iban, branch_name, branch_code, currency, status, opening_balance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountName.trim(), bankName.trim(), accountNumber.trim(), iban?.trim() || null,
        branchName?.trim() || null, branchCode?.trim() || null, currency || 'PKR', status || 'Active',
        parseFloat(openingBalance) || 0
      ]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Bank account created successfully', accountId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to create bank account' });
  } finally {
    connection.release();
  }
});

router.put('/finance/bank-accounts/:accountId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { accountId } = req.params;
    const { accountName, bankName, accountNumber, iban, branchName, branchCode, currency, status, openingBalance } = req.body;
    if (!accountName || !bankName || !accountNumber) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Account name, bank name, and account number are required' });
    }
    const [existing] = await connection.query('SELECT id FROM bank_accounts WHERE id = ?', [accountId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    await ensureFinanceLedgerSchema(connection);
    await connection.query(
      `UPDATE bank_accounts SET account_name=?, bank_name=?, account_number=?, iban=?,
       branch_name=?, branch_code=?, currency=?, status=?, opening_balance=? WHERE id=?`,
      [
        accountName.trim(), bankName.trim(), accountNumber.trim(), iban?.trim() || null,
        branchName?.trim() || null, branchCode?.trim() || null, currency || 'PKR', status || 'Active',
        parseFloat(openingBalance) || 0, accountId
      ]
    );
    await connection.commit();
    res.json({ success: true, message: 'Bank account updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to update bank account' });
  } finally {
    connection.release();
  }
});

router.delete('/finance/bank-accounts/:accountId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { accountId } = req.params;
    const [existing] = await connection.query('SELECT id FROM bank_accounts WHERE id = ?', [accountId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    await connection.query('DELETE FROM bank_accounts WHERE id = ?', [accountId]);
    await connection.commit();
    res.json({ success: true, message: 'Bank account deleted successfully' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ success: false, message: 'Cannot delete bank account as it is linked to invoices' });
    }
    console.error('Error deleting bank account:', error);
    res.status(500).json({ success: false, message: 'Failed to delete bank account' });
  } finally {
    connection.release();
  }
});

// ============================================================
// DEFAULT SERVICES
// ============================================================

router.get('/finance/default-services', async (req, res) => {
  try {
    const [services] = await pool.query(
      'SELECT * FROM invoice_default_services WHERE is_active = 1 ORDER BY display_order ASC, id ASC'
    );
    res.json({ success: true, services });
  } catch (error) {
    console.error('Error fetching default services:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch default services' });
  }
});

router.post('/finance/default-services', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { serviceName, displayOrder } = req.body;
    if (!serviceName || !serviceName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Service name is required' });
    }
    const [result] = await connection.query(
      'INSERT INTO invoice_default_services (service_name, display_order) VALUES (?, ?)',
      [serviceName.trim(), displayOrder || 99]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Default service added', serviceId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error adding default service:', error);
    res.status(500).json({ success: false, message: 'Failed to add default service' });
  } finally {
    connection.release();
  }
});

router.put('/finance/default-services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { serviceId } = req.params;
    const { serviceName, displayOrder } = req.body;
    if (!serviceName || !serviceName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Service name is required' });
    }
    const [existing] = await connection.query('SELECT id FROM invoice_default_services WHERE id = ?', [serviceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Service not found' });
    }
    await connection.query(
      'UPDATE invoice_default_services SET service_name=?, display_order=? WHERE id=?',
      [serviceName.trim(), displayOrder || 99, serviceId]
    );
    await connection.commit();
    res.json({ success: true, message: 'Default service updated' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating default service:', error);
    res.status(500).json({ success: false, message: 'Failed to update default service' });
  } finally {
    connection.release();
  }
});

router.delete('/finance/default-services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { serviceId } = req.params;
    const [existing] = await connection.query('SELECT id FROM invoice_default_services WHERE id = ?', [serviceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Service not found' });
    }
    await connection.query('DELETE FROM invoice_default_services WHERE id = ?', [serviceId]);
    await connection.commit();
    res.json({ success: true, message: 'Default service deleted' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting default service:', error);
    res.status(500).json({ success: false, message: 'Failed to delete default service' });
  } finally {
    connection.release();
  }
});

// ============================================================
// AGENTS
// ============================================================

router.get('/finance/agents', async (req, res) => {
  try {
    const [agents] = await pool.query(
      `SELECT a.*,
        (SELECT COUNT(*) FROM invoices i WHERE i.agent_id = a.id) as total_invoices
       FROM agents a
       ORDER BY a.agent_name ASC`
    );
    res.json({ success: true, agents });
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch agents' });
  }
});

router.post('/finance/agents', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { agentName, companyName, email, phone, address, status, notes } = req.body;
    if (!agentName || !agentName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Agent name is required' });
    }
    const [result] = await connection.query(
      `INSERT INTO agents (agent_name, company_name, email, phone, address, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [agentName.trim(), companyName?.trim() || null, email?.trim() || null, phone?.trim() || null, address?.trim() || null, status || 'Active', notes?.trim() || null]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Agent created', agentId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating agent:', error);
    res.status(500).json({ success: false, message: 'Failed to create agent' });
  } finally {
    connection.release();
  }
});

router.put('/finance/agents/:agentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { agentId } = req.params;
    const { agentName, companyName, email, phone, address, status, notes } = req.body;
    if (!agentName || !agentName.trim()) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Agent name is required' });
    }
    const [existing] = await connection.query('SELECT id FROM agents WHERE id = ?', [agentId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }
    await connection.query(
      `UPDATE agents SET agent_name=?, company_name=?, email=?, phone=?, address=?, status=?, notes=? WHERE id=?`,
      [agentName.trim(), companyName?.trim() || null, email?.trim() || null, phone?.trim() || null, address?.trim() || null, status || 'Active', notes?.trim() || null, agentId]
    );
    await connection.commit();
    res.json({ success: true, message: 'Agent updated' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating agent:', error);
    res.status(500).json({ success: false, message: 'Failed to update agent' });
  } finally {
    connection.release();
  }
});

router.delete('/finance/agents/:agentId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { agentId } = req.params;
    const [existing] = await connection.query('SELECT id FROM agents WHERE id = ?', [agentId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }
    await connection.query('DELETE FROM agents WHERE id = ?', [agentId]);
    await connection.commit();
    res.json({ success: true, message: 'Agent deleted' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ success: false, message: 'Cannot delete agent as they have invoices linked' });
    }
    console.error('Error deleting agent:', error);
    res.status(500).json({ success: false, message: 'Failed to delete agent' });
  } finally {
    connection.release();
  }
});

// ============================================================
// FINANCE STATISTICS
// ============================================================
router.get('/finance/statistics', async (req, res) => {
  try {
    const { month, year, dateFrom, dateTo } = req.query;
    let dateClause = '';
    const dateParams = [];

    if (dateFrom) {
      dateClause += ' AND DATE(invoice_date) >= ?';
      dateParams.push(dateFrom);
    }
    if (dateTo) {
      dateClause += ' AND DATE(invoice_date) <= ?';
      dateParams.push(dateTo);
    }
    if (!dateFrom && !dateTo && month && year) {
      dateClause += ' AND MONTH(invoice_date) = ? AND YEAR(invoice_date) = ?';
      dateParams.push(month, year);
    }

    const [stats] = await pool.query(
      `SELECT
        COUNT(*) as total_invoices,
        COALESCE(SUM(CASE WHEN payment_status = 'Paid' AND invoice_type != 'Agent Commission' THEN final_amount ELSE 0 END), 0) as total_credit,
        COALESCE(SUM(CASE WHEN payment_status IN ('Pending','Partially Paid') AND invoice_type != 'Agent Commission' THEN final_amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE WHEN payment_status IN ('Pending','Partially Paid') AND invoice_type != 'Agent Commission' THEN final_amount - COALESCE(paid_amount,0) ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN invoice_type = 'Agent Commission' THEN final_amount ELSE 0 END), 0) as total_agent_payout,
        COUNT(CASE WHEN payment_status = 'Pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN payment_status = 'Paid'    THEN 1 END) as paid_count
       FROM invoices
       WHERE 1=1${dateClause}`,
      dateParams
    );

    let bankJoin = '';
    const bankParams = [];
    if (dateFrom) {
      bankJoin += ' AND DATE(i.invoice_date) >= ?';
      bankParams.push(dateFrom);
    }
    if (dateTo) {
      bankJoin += ' AND DATE(i.invoice_date) <= ?';
      bankParams.push(dateTo);
    }
    if (!dateFrom && !dateTo && month && year) {
      bankJoin += ' AND MONTH(i.invoice_date) = ? AND YEAR(i.invoice_date) = ?';
      bankParams.push(month, year);
    }

    const [bankStats] = await pool.query(
      `SELECT ba.id, ba.account_name, ba.bank_name, ba.currency,
        COALESCE(SUM(CASE WHEN i.payment_status = 'Paid' AND i.invoice_type != 'Agent Commission' THEN i.final_amount ELSE 0 END), 0) as credit,
        COALESCE(SUM(CASE WHEN i.payment_status IN ('Pending','Partially Paid') AND i.invoice_type != 'Agent Commission' THEN i.final_amount - COALESCE(i.paid_amount,0) ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN i.invoice_type = 'Agent Commission' THEN i.final_amount ELSE 0 END), 0) as agent_payout,
        COUNT(i.id) as invoice_count
       FROM bank_accounts ba
       LEFT JOIN invoices i ON ba.id = i.bank_account_id${bankJoin}
       WHERE ba.status = 'Active'
       GROUP BY ba.id`,
      bankParams
    );

    res.json({ success: true, statistics: stats[0], bankStats });
  } catch (error) {
    console.error('Error fetching finance statistics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch statistics' });
  }
});

// ============================================================
// INVOICES — GET LIST
// ============================================================

router.get('/finance/invoices', async (req, res) => {
  try {
    const { type, status, month, year, bankAccountId, dateFrom, dateTo } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (type)          { whereClause += ' AND i.invoice_type = ?';       params.push(type); }
    if (status)        { whereClause += ' AND i.payment_status = ?';      params.push(status); }
    if (dateFrom)      { whereClause += ' AND DATE(i.invoice_date) >= ?'; params.push(dateFrom); }
    if (dateTo)        { whereClause += ' AND DATE(i.invoice_date) <= ?'; params.push(dateTo); }
    if (!dateFrom && !dateTo) {
      if (month)         { whereClause += ' AND MONTH(i.invoice_date) = ?'; params.push(month); }
      if (year)          { whereClause += ' AND YEAR(i.invoice_date) = ?';  params.push(year); }
    }
    if (bankAccountId) { whereClause += ' AND i.bank_account_id = ?';     params.push(bankAccountId); }

    const [invoices] = await pool.query(
      `SELECT i.*,
              ba.account_name, ba.bank_name, ba.currency,
              a.agent_name, a.email as agent_email, a.phone as agent_phone
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       LEFT JOIN agents a ON i.agent_id = a.id
       ${whereClause}
       ORDER BY i.created_at DESC`,
      params
    );

    for (const inv of invoices) {
      const [extras] = await pool.query('SELECT * FROM invoice_extra_services WHERE invoice_id = ?', [inv.id]);
      inv.extra_services = extras;
      if (inv.invoice_type === 'Agent Commission') {
        const [agentStudents] = await pool.query('SELECT * FROM invoice_agent_students WHERE invoice_id = ?', [inv.id]);
        inv.agent_students = agentStudents;
      }
      if (inv.invoice_type === 'University Commission') {
        const [commStudents] = await pool.query('SELECT * FROM invoice_commission_students WHERE invoice_id = ?', [inv.id]).catch(() => [[]]);
        inv.commission_students = commStudents;
      }
      inv.payments = await fetchInvoicePayments(pool, inv.id);
      inv.payment_count = inv.payments.length;
    }

    res.json({ success: true, invoices, total: invoices.length });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
  }
});

// ============================================================
// INVOICES — GET SINGLE
// ============================================================

router.get('/finance/invoices/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;

    const [invoices] = await pool.query(
      `SELECT i.*, ba.account_name, ba.bank_name, ba.account_number, ba.iban, ba.branch_name, ba.currency,
              a.agent_name, a.company_name as agent_company, a.email as agent_email, a.phone as agent_phone
       FROM invoices i
       LEFT JOIN bank_accounts ba ON i.bank_account_id = ba.id
       LEFT JOIN agents a ON i.agent_id = a.id
       WHERE i.id = ?`,
      [invoiceId]
    );

    if (invoices.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const [extraServices]       = await pool.query('SELECT * FROM invoice_extra_services   WHERE invoice_id = ?', [invoiceId]);
    const [countryServices]     = await pool.query(
      'SELECT * FROM invoice_country_services WHERE invoice_id = ? ORDER BY country_name ASC, id ASC',
      [invoiceId]
    );
    const [agentStudents]       = await pool.query('SELECT * FROM invoice_agent_students   WHERE invoice_id = ?', [invoiceId]);
    const [commissionStudents]  = await pool.query('SELECT * FROM invoice_commission_students WHERE invoice_id = ? ORDER BY id ASC', [invoiceId]).catch(() => [[]]);

    // Per-invoice selected default services
    let defaultServices = [];
    if (invoices[0].invoice_type === 'Student') {
      let [perInvoice] = await pool.query(
        'SELECT * FROM invoice_selected_default_services WHERE invoice_id = ? ORDER BY id ASC',
        [invoiceId]
      ).catch(() => [[]]);

      if (perInvoice.length > 0) {
        defaultServices = perInvoice;
      } else {
        const [ds] = await pool.query(
          'SELECT * FROM invoice_default_services WHERE is_active = 1 ORDER BY display_order ASC'
        );
        defaultServices = ds;
      }
    }

    const payments = await fetchInvoicePayments(pool, invoiceId);
    const installments = await fetchInvoiceInstallments(pool, invoiceId);

    res.json({
      success: true,
      invoice: invoices[0],
      extraServices,
      countryServices,
      agentStudents,
      commissionStudents,
      defaultServices,
      payments,
      installments
    });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch invoice' });
  }
});

// ============================================================
// INVOICES — RECORD PAYMENT (installment)
// ============================================================

router.post('/finance/invoices/:invoiceId/payments', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { invoiceId } = req.params;
    const { amount, paymentDate, notes, paymentStatus } = req.body;

    const [existing] = await connection.query(
      'SELECT id, final_amount, paid_amount FROM invoices WHERE id = ?',
      [invoiceId]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const paymentAmount = parseFloat(amount);
    if (!isFinite(paymentAmount) || paymentAmount <= 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Payment amount must be greater than 0' });
    }

    if (!paymentDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Payment date is required' });
    }

    // Ensure table exists (safe for first use before migrate)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id   INT NOT NULL,
        amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
        payment_date DATE NOT NULL,
        notes        TEXT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invoice_payments_invoice (invoice_id),
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `).catch(() => {});

    const [insertResult] = await connection.query(
      `INSERT INTO invoice_payments (invoice_id, amount, payment_date, notes)
       VALUES (?, ?, ?, ?)`,
      [invoiceId, paymentAmount, paymentDate, notes?.trim() || null]
    );

    const totals = await recomputeInvoicePaymentTotals(
      connection,
      invoiceId,
      paymentStatus === 'Cancelled' ? 'Cancelled' : null
    );

    const payments = await fetchInvoicePayments(connection, invoiceId);
    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      paymentId: insertResult.insertId,
      paymentStatus: totals?.paymentStatus,
      paidAmount: totals?.totalPaid,
      payments
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error recording payment:', error);
    res.status(500).json({ success: false, message: 'Failed to record payment' });
  } finally {
    connection.release();
  }
});

router.get('/finance/invoices/:invoiceId/payments', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const [existing] = await pool.query('SELECT id FROM invoices WHERE id = ?', [invoiceId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    const payments = await fetchInvoicePayments(pool, invoiceId);
    res.json({ success: true, payments });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch payments' });
  }
});

// ============================================================
// INVOICES — CREATE
// ============================================================

router.post('/finance/invoices', async (req, res) => {
  // Ensure schema before opening a transaction (DDL auto-commits on MySQL)
  try {
    await ensureInvoiceInstallmentSchema();
  } catch (err) {
    console.warn('Installment schema ensure failed:', err.message);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      invoiceType, invoiceDate, dueDate,
      paymentMethod, bankAccountId,
      // Student invoice — DB or manual
      studentId,
      isManualStudent,
      manualStudentName, manualStudentEmail, manualStudentMobile, manualStudentCountry,
      selectedCountries,
      // University Commission — now multi-student
      commissionStudents,          // array: [{ isManual, studentId, studentName, studentRefId, studentEmail, studentMobile, universityName, commissionReference, commissionAmount }]
      universityName,              // kept for backward compat / single-student fallback
      commissionReference,
      // Agent Commission
      agentId, agentCommissionPercent, agentStudents,
      baseAmount, discount, extraServices, selectedCountryServices,
      selectedDefaultServices,
      finalAmount, gstPercent, gstAmount,
      notes,
      selectedCurrency, exchangeRate, convertedAmount,
      showConvertedCurrency,       // boolean — whether to show foreign currency on PDF
      // Advance + optional installment plan
      advanceAmount,
      advanceDate,
      hasInstallmentPlan,
      installments,
    } = req.body;

    if (!invoiceType || !invoiceDate) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Invoice type and date are required' });
    }

    const resolvedPaymentMethod = paymentMethod === 'cash' ? 'cash' : 'bank';

    if (resolvedPaymentMethod === 'bank') {
      if (!bankAccountId) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'Bank account is required for bank transfers' });
      }
      const [bank] = await connection.query('SELECT id FROM bank_accounts WHERE id = ? AND status = ?', [bankAccountId, 'Active']);
      if (bank.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Bank account not found or inactive' });
      }
    }

    // ── Resolve student info ──
    let studentName = null, studentRefId = null, studentEmail = null, studentMobile = null, studentCountry = null;
    const resolvedIsManual = isManualStudent ? 1 : 0;
    const selectedCountryNames = Array.isArray(selectedCountries)
      ? selectedCountries.map(c => c.country_name).filter(Boolean)
      : [];
    const invoiceCountriesLabel = selectedCountryNames.length > 0
      ? selectedCountryNames.join(', ')
      : null;

    if (isManualStudent) {
      // Manual entry — store provided details
      studentName    = manualStudentName?.trim() || null;
      studentEmail   = manualStudentEmail?.trim() || null;
      studentMobile  = manualStudentMobile?.trim() || null;
      studentCountry = invoiceCountriesLabel || manualStudentCountry?.trim() || null;
    } else if (studentId && invoiceType !== 'Agent Commission') {
      const [students] = await connection.query(
        'SELECT name, middle_name, surname, student_id, email, mobile, country FROM users WHERE id = ?',
        [studentId]
      );
      if (students.length > 0) {
        const s = students[0];
        studentName    = [s.name, s.middle_name, s.surname].filter(Boolean).join(' ');
        studentRefId   = s.student_id;
        studentEmail   = s.email;
        studentMobile  = s.mobile;
        studentCountry = invoiceCountriesLabel || s.country;
      }
    }

    // ── Visa (legacy — no longer required for new student invoices) ──
    let visaRefId = null, visaType = null, visaCountry = null;

    // ── Amount calculation ──
    const extrasTotal      = Array.isArray(extraServices)
      ? extraServices.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0) : 0;
    const commissionPercent = parseFloat(agentCommissionPercent) || 0;
    const totalBase         = parseFloat(baseAmount) || 0;

    // For University Commission, total = sum of commissionStudents amounts
    let resolvedFinalAmount = parseFloat(finalAmount) || 0;
    let uniName             = universityName || null;
    let uniRef              = commissionReference || null;

    if (invoiceType === 'University Commission' && Array.isArray(commissionStudents) && commissionStudents.length > 0) {
      resolvedFinalAmount = commissionStudents.reduce((sum, s) => sum + (parseFloat(s.commissionAmount) || 0), 0);
      // For the main invoice record, use first student's uni info or keep provided
      if (!uniName && commissionStudents[0]?.universityName) uniName = commissionStudents[0].universityName;
      if (!uniRef  && commissionStudents[0]?.commissionReference) uniRef = commissionStudents[0].commissionReference;
    }

    const agentCommissionAmount = invoiceType === 'Agent Commission'
      ? (totalBase * commissionPercent / 100) : null;

    const resolvedGstPercent      = parseFloat(gstPercent) || 0;
    const resolvedGstAmount       = parseFloat(gstAmount)  || 0;
    const resolvedCurrency        = selectedCurrency || 'PKR';
    const resolvedExchangeRate    = resolvedCurrency === 'PKR' ? 1 : (parseFloat(exchangeRate) || 1);
    const resolvedConvertedAmount = resolvedCurrency === 'PKR' ? null : (parseFloat(convertedAmount) || null);
    const resolvedShowConverted   = showConvertedCurrency === false ? 0 : 1; // default show

    const invoiceId = await generateInvoiceId(connection);

    const [result] = await connection.query(
      `INSERT INTO invoices
       (invoice_id, invoice_type, invoice_date, due_date,
        payment_method, bank_account_id,
        student_id, student_name, student_ref_id, student_email, student_mobile, student_country,
        is_manual_student, manual_student_name, manual_student_email, manual_student_mobile, manual_student_country,
        visa_id, visa_ref_id, visa_type, visa_country,
        university_name, commission_reference,
        agent_id, agent_commission_percent, agent_commission_amount,
        base_amount, discount, extra_services_total, final_amount,
        gst_percent, gst_amount,
        selected_currency, exchange_rate, converted_amount,
        show_converted_currency,
        payment_status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
      [
        invoiceId, invoiceType, invoiceDate, dueDate || null,
        resolvedPaymentMethod, resolvedPaymentMethod === 'bank' ? (bankAccountId || null) : null,
        isManualStudent ? null : (studentId || null),
        isManualStudent ? (manualStudentName?.trim() || null) : studentName,
        isManualStudent ? null : studentRefId,
        isManualStudent ? (manualStudentEmail?.trim() || null) : studentEmail,
        isManualStudent ? (manualStudentMobile?.trim() || null) : studentMobile,
        isManualStudent ? (manualStudentCountry?.trim() || null) : studentCountry,
        resolvedIsManual,
        isManualStudent ? (manualStudentName?.trim() || null) : null,
        isManualStudent ? (manualStudentEmail?.trim() || null) : null,
        isManualStudent ? (manualStudentMobile?.trim() || null) : null,
        isManualStudent ? (invoiceCountriesLabel || manualStudentCountry?.trim() || null) : null,
        null, visaRefId, visaType, visaCountry,
        uniName, uniRef,
        agentId || null, commissionPercent || null,
        invoiceType === 'Agent Commission' ? agentCommissionAmount : null,
        totalBase, parseFloat(discount) || 0, extrasTotal,
        invoiceType === 'University Commission' ? resolvedFinalAmount : (parseFloat(finalAmount) || 0),
        resolvedGstPercent, resolvedGstAmount,
        resolvedCurrency, resolvedExchangeRate, resolvedConvertedAmount,
        resolvedShowConverted,
        notes || null
      ]
    );

    const newInvoiceId = result.insertId;

    // ── Extra services ──
    if (Array.isArray(extraServices) && extraServices.length > 0) {
      for (const svc of extraServices) {
        if (svc.name) {
          await connection.query(
            'INSERT INTO invoice_extra_services (invoice_id, service_name, price) VALUES (?, ?, ?)',
            [newInvoiceId, svc.name, parseFloat(svc.price) || 0]
          );
        }
      }
    }

    // ── Country services ──
    if (Array.isArray(selectedCountryServices) && selectedCountryServices.length > 0) {
      for (const cs of selectedCountryServices) {
        try {
          await connection.query(
            'INSERT INTO invoice_country_services (invoice_id, country_service_id, service_name, country_id, country_name) VALUES (?, ?, ?, ?, ?)',
            [newInvoiceId, cs.id, cs.service_name, cs.country_id || null, cs.country_name || null]
          );
        } catch {
          await connection.query(
            'INSERT INTO invoice_country_services (invoice_id, country_service_id, service_name) VALUES (?, ?, ?)',
            [newInvoiceId, cs.id, cs.service_name]
          );
        }
      }
    }

    // ── Selected default services (Student only) ──
    if (invoiceType === 'Student' && Array.isArray(selectedDefaultServices) && selectedDefaultServices.length > 0) {
      for (const ds of selectedDefaultServices) {
        await connection.query(
          'INSERT INTO invoice_selected_default_services (invoice_id, service_id, service_name) VALUES (?, ?, ?)',
          [newInvoiceId, ds.id || null, ds.service_name]
        ).catch(() => {
          console.warn('invoice_selected_default_services table missing — run GET /finance/migrate');
        });
      }
    }

    // ── Agent students ──
    if (invoiceType === 'Agent Commission' && Array.isArray(agentStudents) && agentStudents.length > 0) {
      for (const s of agentStudents) {
        await connection.query(
          `INSERT INTO invoice_agent_students
           (invoice_id, student_id, student_name, student_ref_id, is_manual, student_email, student_mobile, student_country)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newInvoiceId,
            s.isManual ? null : (s.id || null),
            s.student_name,
            s.student_ref_id || null,
            s.isManual ? 1 : 0,
            s.student_email || null,
            s.student_mobile || null,
            s.student_country || null
          ]
        ).catch(async () => {
          // Fallback if extra columns don't exist yet
          await connection.query(
            'INSERT INTO invoice_agent_students (invoice_id, student_id, student_name, student_ref_id) VALUES (?, ?, ?, ?)',
            [newInvoiceId, s.isManual ? null : (s.id || null), s.student_name, s.student_ref_id || null]
          );
        });
      }
    }

    // ── University Commission students (multi-student) ──
    if (invoiceType === 'University Commission' && Array.isArray(commissionStudents) && commissionStudents.length > 0) {
      for (const s of commissionStudents) {
        await connection.query(
          `INSERT INTO invoice_commission_students
           (invoice_id, student_id, student_name, student_ref_id, student_email, student_mobile,
            is_manual, commission_amount, university_name, commission_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newInvoiceId,
            s.isManual ? null : (s.studentId || null),
            s.studentName || '',
            s.isManual ? null : (s.studentRefId || null),
            s.studentEmail || null,
            s.studentMobile || null,
            s.isManual ? 1 : 0,
            parseFloat(s.commissionAmount) || 0,
            s.universityName || null,
            s.commissionReference || null
          ]
        ).catch(err => {
          console.warn('invoice_commission_students insert error — run GET /finance/migrate:', err.message);
        });
      }
    }

    // ── Advance + optional installment plan ──
    const resolvedAdvance = Math.max(0, parseFloat(advanceAmount) || 0);
    try {
      await saveInvoiceInstallmentPlan(connection, newInvoiceId, {
        hasInstallmentPlan: !!hasInstallmentPlan,
        advanceAmount: resolvedAdvance,
        installments: Array.isArray(installments) ? installments : [],
      });
    } catch (planErr) {
      console.error('Failed saving installment plan:', planErr);
      await connection.rollback();
      return res.status(500).json({
        success: false,
        message: 'Invoice amounts saved structure failed for advance/installments. Please open /finance/migrate once, then try again.',
        detail: planErr.message 
      });
    }

    if (resolvedAdvance > 0) {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS invoice_payments (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          invoice_id   INT NOT NULL,
          amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
          payment_date DATE NOT NULL,
          notes        TEXT NULL,
          created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_invoice_payments_invoice (invoice_id)
        )
      `).catch(() => {});

      await connection.query(
        `INSERT INTO invoice_payments (invoice_id, amount, payment_date, notes)
         VALUES (?, ?, ?, ?)`,
        [
          newInvoiceId,
          resolvedAdvance,
          advanceDate || invoiceDate,
          'Advance'
        ]
      );
      await recomputeInvoicePaymentTotals(connection, newInvoiceId);
    }

    await connection.commit();
    res.status(201).json({
      success: true, message: 'Invoice created successfully',
      invoiceId: newInvoiceId, generatedInvoiceId: invoiceId,
      hasInstallmentPlan: !!hasInstallmentPlan,
      advanceAmount: resolvedAdvance
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating invoice:', error);
    res.status(500).json({
      success: false,
      message: error.message?.includes('Unknown column')
        ? 'Database is missing advance/installment columns. Open /finance/migrate once, then create the invoice again.'
        : 'Failed to create invoice',
      detail: error.message
    });
  } finally {
    connection.release();
  }
});

// ============================================================
// INVOICES — UPDATE
// ============================================================

router.put('/finance/invoices/:invoiceId', async (req, res) => {
  try {
    await ensureInvoiceInstallmentSchema();
  } catch (err) {
    console.warn('Installment schema ensure failed:', err.message);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { invoiceId } = req.params;
    const {
      fullEdit,
      paymentStatus, paidAmount, paymentDate, installmentAmount,
      bankAccountId, baseAmount, discount, gstPercent, gstAmount, finalAmount,
      invoiceDate, dueDate, universityName, commissionReference,
      agentId, agentCommissionPercent, agentCommissionAmount,
      notes,
      showConvertedCurrency,
      studentName, studentEmail, studentMobile,
      agentName, agentEmail, agentPhone,
      // Full-edit (create-form replica) fields
      paymentMethod,
      studentId, isManualStudent,
      manualStudentName, manualStudentEmail, manualStudentMobile, manualStudentCountry,
      selectedCountries,
      commissionStudents, agentStudents,
      extraServices, selectedCountryServices, selectedDefaultServices,
      selectedCurrency, exchangeRate, convertedAmount,
      advanceAmount, advanceDate, hasInstallmentPlan, installments,
    } = req.body;

    const [existing] = await connection.query(
      'SELECT id, paid_amount, final_amount, invoice_type, is_manual_student, agent_id, student_id, advance_amount FROM invoices WHERE id = ?',
      [invoiceId]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const invoiceType = existing[0].invoice_type;
    const safeFloat = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const resolvedShowConverted = showConvertedCurrency === false || showConvertedCurrency === 0 ? 0 : 1;

    // ── Full edit: replace invoice fields + related service/student rows ──
    if (fullEdit) {
      const resolvedPaymentMethod = paymentMethod === 'cash' ? 'cash' : 'bank';
      if (resolvedPaymentMethod === 'bank') {
        if (!bankAccountId) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: 'Bank account is required for bank transfers' });
        }
        const [bank] = await connection.query('SELECT id FROM bank_accounts WHERE id = ? AND status = ?', [bankAccountId, 'Active']);
        if (bank.length === 0) {
          await connection.rollback();
          return res.status(404).json({ success: false, message: 'Bank account not found or inactive' });
        }
      }

      let resolvedStudentName = null, resolvedStudentRefId = null, resolvedStudentEmail = null, resolvedStudentMobile = null, resolvedStudentCountry = null;
      const resolvedIsManual = isManualStudent ? 1 : 0;
      const selectedCountryNames = Array.isArray(selectedCountries)
        ? selectedCountries.map(c => c.country_name).filter(Boolean)
        : [];
      const invoiceCountriesLabel = selectedCountryNames.length > 0 ? selectedCountryNames.join(', ') : null;

      if (invoiceType === 'Student') {
        if (isManualStudent) {
          resolvedStudentName = manualStudentName?.trim() || null;
          resolvedStudentEmail = manualStudentEmail?.trim() || null;
          resolvedStudentMobile = manualStudentMobile?.trim() || null;
          resolvedStudentCountry = invoiceCountriesLabel || manualStudentCountry?.trim() || null;
        } else if (studentId) {
          const [students] = await connection.query(
            'SELECT name, middle_name, surname, student_id, email, mobile, country FROM users WHERE id = ?',
            [studentId]
          );
          if (students.length > 0) {
            const s = students[0];
            resolvedStudentName = [s.name, s.middle_name, s.surname].filter(Boolean).join(' ');
            resolvedStudentRefId = s.student_id;
            resolvedStudentEmail = s.email;
            resolvedStudentMobile = s.mobile;
            resolvedStudentCountry = invoiceCountriesLabel || s.country;
          }
        }
      }

      const extrasTotal = Array.isArray(extraServices)
        ? extraServices.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0) : 0;
      const commissionPercent = parseFloat(agentCommissionPercent) || 0;
      const totalBase = parseFloat(baseAmount) || 0;

      let resolvedFinalAmount = parseFloat(finalAmount) || 0;
      let uniName = universityName || null;
      let uniRef = commissionReference || null;

      if (invoiceType === 'University Commission' && Array.isArray(commissionStudents) && commissionStudents.length > 0) {
        resolvedFinalAmount = commissionStudents.reduce((sum, s) => sum + (parseFloat(s.commissionAmount) || 0), 0);
        if (!uniName && commissionStudents[0]?.universityName) uniName = commissionStudents[0].universityName;
        if (!uniRef && commissionStudents[0]?.commissionReference) uniRef = commissionStudents[0].commissionReference;
      }

      const resolvedAgentCommissionAmount = invoiceType === 'Agent Commission'
        ? (totalBase * commissionPercent / 100) : null;

      const resolvedGstPercent = invoiceType === 'Agent Commission' ? 0 : (parseFloat(gstPercent) || 0);
      const resolvedGstAmount = invoiceType === 'Agent Commission' ? 0 : (parseFloat(gstAmount) || 0);
      const resolvedCurrency = selectedCurrency || 'PKR';
      const resolvedExchangeRate = resolvedCurrency === 'PKR' ? 1 : (parseFloat(exchangeRate) || 1);
      const resolvedConvertedAmount = resolvedCurrency === 'PKR' ? null : (parseFloat(convertedAmount) || null);

      await connection.query(
        `UPDATE invoices SET
          invoice_date=?, due_date=?,
          payment_method=?, bank_account_id=?,
          student_id=?, student_name=?, student_ref_id=?, student_email=?, student_mobile=?, student_country=?,
          is_manual_student=?, manual_student_name=?, manual_student_email=?, manual_student_mobile=?, manual_student_country=?,
          university_name=?, commission_reference=?,
          agent_id=?, agent_commission_percent=?, agent_commission_amount=?,
          base_amount=?, discount=?, extra_services_total=?, final_amount=?,
          gst_percent=?, gst_amount=?,
          selected_currency=?, exchange_rate=?, converted_amount=?,
          show_converted_currency=?,
          notes=?
         WHERE id=?`,
        [
          invoiceDate || null,
          dueDate || null,
          resolvedPaymentMethod,
          resolvedPaymentMethod === 'bank' ? (bankAccountId || null) : null,
          invoiceType === 'Student'
            ? (isManualStudent ? null : (studentId || null))
            : existing[0].student_id,
          invoiceType === 'Student'
            ? (isManualStudent ? (manualStudentName?.trim() || null) : resolvedStudentName)
            : null,
          invoiceType === 'Student' ? (isManualStudent ? null : resolvedStudentRefId) : null,
          invoiceType === 'Student'
            ? (isManualStudent ? (manualStudentEmail?.trim() || null) : resolvedStudentEmail)
            : null,
          invoiceType === 'Student'
            ? (isManualStudent ? (manualStudentMobile?.trim() || null) : resolvedStudentMobile)
            : null,
          invoiceType === 'Student'
            ? (isManualStudent
              ? (invoiceCountriesLabel || manualStudentCountry?.trim() || null)
              : resolvedStudentCountry)
            : null,
          invoiceType === 'Student' ? resolvedIsManual : 0,
          invoiceType === 'Student' && isManualStudent ? (manualStudentName?.trim() || null) : null,
          invoiceType === 'Student' && isManualStudent ? (manualStudentEmail?.trim() || null) : null,
          invoiceType === 'Student' && isManualStudent ? (manualStudentMobile?.trim() || null) : null,
          invoiceType === 'Student' && isManualStudent
            ? (invoiceCountriesLabel || manualStudentCountry?.trim() || null)
            : null,
          uniName,
          uniRef,
          invoiceType === 'Agent Commission' ? (agentId || null) : null,
          invoiceType === 'Agent Commission' ? commissionPercent : null,
          resolvedAgentCommissionAmount,
          totalBase,
          parseFloat(discount) || 0,
          extrasTotal,
          invoiceType === 'University Commission' ? resolvedFinalAmount : (parseFloat(finalAmount) || 0),
          resolvedGstPercent,
          resolvedGstAmount,
          resolvedCurrency,
          resolvedExchangeRate,
          resolvedConvertedAmount,
          resolvedShowConverted,
          notes || null,
          invoiceId
        ]
      );

      // Replace related rows
      await connection.query('DELETE FROM invoice_extra_services WHERE invoice_id = ?', [invoiceId]);
      await connection.query('DELETE FROM invoice_country_services WHERE invoice_id = ?', [invoiceId]);
      await connection.query('DELETE FROM invoice_selected_default_services WHERE invoice_id = ?', [invoiceId]).catch(() => {});
      await connection.query('DELETE FROM invoice_agent_students WHERE invoice_id = ?', [invoiceId]).catch(() => {});
      await connection.query('DELETE FROM invoice_commission_students WHERE invoice_id = ?', [invoiceId]).catch(() => {});

      if (Array.isArray(extraServices) && extraServices.length > 0) {
        for (const svc of extraServices) {
          if (svc.name) {
            await connection.query(
              'INSERT INTO invoice_extra_services (invoice_id, service_name, price) VALUES (?, ?, ?)',
              [invoiceId, svc.name, parseFloat(svc.price) || 0]
            );
          }
        }
      }

      if (Array.isArray(selectedCountryServices) && selectedCountryServices.length > 0) {
        for (const cs of selectedCountryServices) {
          try {
            await connection.query(
              'INSERT INTO invoice_country_services (invoice_id, country_service_id, service_name, country_id, country_name) VALUES (?, ?, ?, ?, ?)',
              [invoiceId, cs.id, cs.service_name, cs.country_id || null, cs.country_name || null]
            );
          } catch {
            await connection.query(
              'INSERT INTO invoice_country_services (invoice_id, country_service_id, service_name) VALUES (?, ?, ?)',
              [invoiceId, cs.id, cs.service_name]
            );
          }
        }
      }

      if (invoiceType === 'Student' && Array.isArray(selectedDefaultServices) && selectedDefaultServices.length > 0) {
        for (const ds of selectedDefaultServices) {
          await connection.query(
            'INSERT INTO invoice_selected_default_services (invoice_id, service_id, service_name) VALUES (?, ?, ?)',
            [invoiceId, ds.id || null, ds.service_name]
          ).catch(() => {});
        }
      }

      if (invoiceType === 'Agent Commission' && Array.isArray(agentStudents) && agentStudents.length > 0) {
        for (const s of agentStudents) {
          await connection.query(
            `INSERT INTO invoice_agent_students
             (invoice_id, student_id, student_name, student_ref_id, is_manual, student_email, student_mobile, student_country)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              invoiceId,
              s.isManual ? null : (s.id || null),
              s.student_name,
              s.student_ref_id || null,
              s.isManual ? 1 : 0,
              s.student_email || null,
              s.student_mobile || null,
              s.student_country || null
            ]
          ).catch(async () => {
            await connection.query(
              'INSERT INTO invoice_agent_students (invoice_id, student_id, student_name, student_ref_id) VALUES (?, ?, ?, ?)',
              [invoiceId, s.isManual ? null : (s.id || null), s.student_name, s.student_ref_id || null]
            );
          });
        }
      }

      if (invoiceType === 'University Commission' && Array.isArray(commissionStudents) && commissionStudents.length > 0) {
        for (const s of commissionStudents) {
          await connection.query(
            `INSERT INTO invoice_commission_students
             (invoice_id, student_id, student_name, student_ref_id, student_email, student_mobile,
              is_manual, commission_amount, university_name, commission_reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              invoiceId,
              s.isManual ? null : (s.studentId || null),
              s.studentName || '',
              s.isManual ? null : (s.studentRefId || null),
              s.studentEmail || null,
              s.studentMobile || null,
              s.isManual ? 1 : 0,
              parseFloat(s.commissionAmount) || 0,
              s.universityName || null,
              s.commissionReference || null
            ]
          ).catch(err => {
            console.warn('invoice_commission_students update insert error:', err.message);
          });
        }
      }

      // Advance + optional installment plan
      const resolvedAdvance = Math.max(0, parseFloat(advanceAmount) || 0);
      await saveInvoiceInstallmentPlan(connection, invoiceId, {
        hasInstallmentPlan: !!hasInstallmentPlan,
        advanceAmount: resolvedAdvance,
        installments: Array.isArray(installments) ? installments : [],
      });

      // Sync the Advance payment row (create / update / remove)
      await connection.query(`
        CREATE TABLE IF NOT EXISTS invoice_payments (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          invoice_id   INT NOT NULL,
          amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
          payment_date DATE NOT NULL,
          notes        TEXT NULL,
          created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_invoice_payments_invoice (invoice_id),
          FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        )
      `).catch(() => {});

      const [advanceRows] = await connection.query(
        `SELECT id FROM invoice_payments WHERE invoice_id = ? AND notes = 'Advance' ORDER BY id ASC LIMIT 1`,
        [invoiceId]
      );
      if (resolvedAdvance > 0) {
        if (advanceRows.length > 0) {
          await connection.query(
            `UPDATE invoice_payments SET amount = ?, payment_date = ? WHERE id = ?`,
            [resolvedAdvance, advanceDate || invoiceDate || toYMD(new Date()), advanceRows[0].id]
          );
        } else {
          await connection.query(
            `INSERT INTO invoice_payments (invoice_id, amount, payment_date, notes) VALUES (?, ?, ?, 'Advance')`,
            [invoiceId, resolvedAdvance, advanceDate || invoiceDate || toYMD(new Date())]
          );
        }
      } else if (advanceRows.length > 0) {
        await connection.query('DELETE FROM invoice_payments WHERE id = ?', [advanceRows[0].id]);
      }

      // Recompute payment status against possibly new final amount
      const totals = await recomputeInvoicePaymentTotals(connection, invoiceId, null);

      await connection.commit();
      return res.json({
        success: true,
        message: 'Invoice updated successfully',
        paymentStatus: totals?.paymentStatus,
        payments: await fetchInvoicePayments(pool, invoiceId),
        installments: await fetchInvoiceInstallments(pool, invoiceId)
      });
    }

    // Ensure payments table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS invoice_payments (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id   INT NOT NULL,
        amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
        payment_date DATE NOT NULL,
        notes        TEXT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invoice_payments_invoice (invoice_id),
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `).catch(() => {});

    // Record a new installment when provided (preferred path)
    const installment = safeFloat(installmentAmount);
    if (installment && installment > 0) {
      if (!paymentDate) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'Payment date is required for a new installment' });
      }
      await connection.query(
        `INSERT INTO invoice_payments (invoice_id, amount, payment_date, notes)
         VALUES (?, ?, ?, ?)`,
        [invoiceId, installment, paymentDate, null]
      );
    } else if (paidAmount !== undefined && paidAmount !== null && paidAmount !== '') {
      // Legacy: client sent cumulative paidAmount — seed history or store only the delta
      const existingPayments = await fetchInvoicePayments(connection, invoiceId);
      const historyTotal = existingPayments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      const newTotal = safeFloat(paidAmount) ?? 0;
      const payDate = paymentDate || new Date().toISOString().slice(0, 10);

      if (existingPayments.length === 0) {
        if (newTotal > 0) {
          await connection.query(
            `INSERT INTO invoice_payments (invoice_id, amount, payment_date, notes)
             VALUES (?, ?, ?, ?)`,
            [invoiceId, newTotal, payDate, null]
          );
        }
      } else {
        const delta = Math.round((newTotal - historyTotal) * 100) / 100;
        if (delta > 0) {
          await connection.query(
            `INSERT INTO invoice_payments (invoice_id, amount, payment_date, notes)
             VALUES (?, ?, ?, ?)`,
            [invoiceId, delta, payDate, 'Payment update']
          );
        }
      }
    }

    // Update non-payment invoice fields first (payment totals recomputed below)
    await connection.query(
      `UPDATE invoices SET
        bank_account_id=COALESCE(?,bank_account_id),
        base_amount=COALESCE(?,base_amount),
        discount=COALESCE(?,discount),
        gst_percent=COALESCE(?,gst_percent),
        gst_amount=COALESCE(?,gst_amount),
        final_amount=COALESCE(?,final_amount),
        invoice_date=COALESCE(?,invoice_date),
        due_date=?,
        university_name=COALESCE(?,university_name),
        commission_reference=COALESCE(?,commission_reference),
        agent_id=COALESCE(?,agent_id),
        agent_commission_percent=COALESCE(?,agent_commission_percent),
        agent_commission_amount=COALESCE(?,agent_commission_amount),
        show_converted_currency=?,
        notes=?
       WHERE id=?`,
      [
        safeFloat(bankAccountId),
        safeFloat(baseAmount),
        safeFloat(discount),
        safeFloat(gstPercent),
        safeFloat(gstAmount),
        safeFloat(finalAmount),
        invoiceDate || null,
        dueDate || null,
        universityName || null,
        commissionReference || null,
        agentId || null,
        safeFloat(agentCommissionPercent),
        safeFloat(agentCommissionAmount),
        resolvedShowConverted,
        notes || null,
        invoiceId
      ]
    );

    if (existing[0].invoice_type === 'Student' && (studentName !== undefined || studentEmail !== undefined || studentMobile !== undefined)) {
      await connection.query(
        `UPDATE invoices SET
          student_name=?,
          student_email=?,
          student_mobile=?,
          manual_student_name=CASE WHEN is_manual_student=1 THEN ? ELSE manual_student_name END,
          manual_student_email=CASE WHEN is_manual_student=1 THEN ? ELSE manual_student_email END,
          manual_student_mobile=CASE WHEN is_manual_student=1 THEN ? ELSE manual_student_mobile END
         WHERE id=?`,
        [
          studentName?.trim() || null,
          studentEmail?.trim() || null,
          studentMobile?.trim() || null,
          studentName?.trim() || null,
          studentEmail?.trim() || null,
          studentMobile?.trim() || null,
          invoiceId
        ]
      );
    }

    if (existing[0].invoice_type === 'Agent Commission' && existing[0].agent_id && (agentName !== undefined || agentEmail !== undefined || agentPhone !== undefined)) {
      await connection.query(
        `UPDATE agents SET
          agent_name=COALESCE(?, agent_name),
          email=?,
          phone=?
         WHERE id=?`,
        [
          agentName?.trim() || null,
          agentEmail?.trim() || null,
          agentPhone?.trim() || null,
          existing[0].agent_id
        ]
      );
    }

    const payments = await fetchInvoicePayments(connection, invoiceId);
    let resolvedStatus;

    if (payments.length > 0 || installment || (paidAmount !== undefined && paidAmount !== null && paidAmount !== '')) {
      const totals = await recomputeInvoicePaymentTotals(
        connection,
        invoiceId,
        paymentStatus === 'Cancelled' ? 'Cancelled' : null
      );
      resolvedStatus = totals?.paymentStatus;
    } else if (paymentStatus) {
      // Status-only update (e.g. Cancelled / Pending) with no payment history
      resolvedStatus = paymentStatus;
      await connection.query(
        `UPDATE invoices SET payment_status = ?, paid_amount = COALESCE(?, paid_amount), payment_date = COALESCE(?, payment_date) WHERE id = ?`,
        [resolvedStatus, safeFloat(paidAmount), paymentDate || null, invoiceId]
      );
      await syncLeadPaymentStatus(connection, invoiceId, resolvedStatus);
    }

    await connection.commit();
    res.json({
      success: true,
      message: 'Invoice updated successfully',
      paymentStatus: resolvedStatus,
      payments: await fetchInvoicePayments(pool, invoiceId)
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to update invoice' });
  } finally {
    connection.release();
  }
});

// ============================================================
// INVOICES — DELETE
// ============================================================

router.delete('/finance/invoices/:invoiceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { invoiceId } = req.params;
    const [existing] = await connection.query('SELECT id FROM invoices WHERE id = ?', [invoiceId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    await connection.query('DELETE FROM invoices WHERE id = ?', [invoiceId]);
    await connection.commit();
    res.json({ success: true, message: 'Invoice deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting invoice:', error);
    res.status(500).json({ success: false, message: 'Failed to delete invoice' });
  } finally {
    connection.release();
  }
});

// ============================================================
// COUNTRY SERVICES
// ============================================================

router.get('/countries/:countryId/services', async (req, res) => {
  try {
    const { countryId } = req.params;
    const [services] = await pool.query(
      'SELECT * FROM country_services WHERE country_id = ? ORDER BY display_order ASC, id ASC', [countryId]
    );
    res.json({ success: true, services, total: services.length });
  } catch (error) {
    console.error('Error fetching country services:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch services' });
  }
});

router.post('/countries/:countryId/services', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId } = req.params;
    const { serviceName, description, displayOrder } = req.body;
    if (!serviceName) { await connection.rollback(); return res.status(400).json({ success: false, message: 'Service name is required' }); }
    const [country] = await connection.query('SELECT id FROM countries WHERE id = ?', [countryId]);
    if (country.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Country not found' }); }
    const [result] = await connection.query(
      'INSERT INTO country_services (country_id, service_name, description, display_order) VALUES (?, ?, ?, ?)',
      [countryId, serviceName.trim(), description?.trim() || null, displayOrder || 99]
    );
    await connection.commit();
    res.status(201).json({ success: true, message: 'Service added successfully', serviceId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('Error adding service:', error);
    res.status(500).json({ success: false, message: 'Failed to add service' });
  } finally {
    connection.release();
  }
});

router.put('/countries/:countryId/services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId, serviceId } = req.params;
    const { serviceName, description, displayOrder } = req.body;
    if (!serviceName) { await connection.rollback(); return res.status(400).json({ success: false, message: 'Service name is required' }); }
    const [existing] = await connection.query('SELECT id FROM country_services WHERE id = ? AND country_id = ?', [serviceId, countryId]);
    if (existing.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Service not found' }); }
    await connection.query(
      'UPDATE country_services SET service_name=?, description=?, display_order=? WHERE id=?',
      [serviceName.trim(), description?.trim() || null, displayOrder || 99, serviceId]
    );
    await connection.commit();
    res.json({ success: true, message: 'Service updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating service:', error);
    res.status(500).json({ success: false, message: 'Failed to update service' });
  } finally {
    connection.release();
  }
});

router.delete('/countries/:countryId/services/:serviceId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { countryId, serviceId } = req.params;
    const [existing] = await connection.query('SELECT id FROM country_services WHERE id = ? AND country_id = ?', [serviceId, countryId]);
    if (existing.length === 0) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Service not found' }); }
    await connection.query('DELETE FROM country_services WHERE id = ?', [serviceId]);
    await connection.commit();
    res.json({ success: true, message: 'Service deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error deleting service:', error);
    res.status(500).json({ success: false, message: 'Failed to delete service' });
  } finally {
    connection.release();
  }
});

// ── Student visas ──
router.get('/finance/student-visas/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const [visas] = await pool.query(
      `SELECT v.id, v.visa_id, v.visa_type, v.visa_status, v.institute
       FROM visas v WHERE v.student_id = ? ORDER BY v.created_at DESC`,
      [studentId]
    );
    res.json({ success: true, visas });
  } catch (error) {
    console.error('Error fetching student visas:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch visas' });
  }
});

export default router;