'use strict';

/**
 * controllers/technicians.controller.js — Public technician list (v5) NEW
 */

const db                         = require('../db/db');
const { asyncHandler }           = require('../middleware/errorHandler');

const listTechnicians = asyncHandler(async (req, res) => {
  const result = await db.query(
    'SELECT id, name, status, latitude, longitude FROM technicians'
  );
  res.json({ success: true, data: result.rows });
});

module.exports = { listTechnicians };
