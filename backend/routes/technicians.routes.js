'use strict';

/**
 * routes/technicians.routes.js — Public technician list (v5) NEW
 *
 * Mounted at: app.use('/technicians', techniciansRouter)
 * No authentication — used by dispatch and frontend map view.
 */

const express = require('express');
const { listTechnicians } = require('../controllers/technicians.controller');

const router = express.Router();

router.get('/', listTechnicians);

module.exports = router;
