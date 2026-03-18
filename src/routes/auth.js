const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin } = require('../config/supabase');
const { authenticate }  = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

// ─── Register ────────────────────────────────────────────────────
router.post('/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('full_name').trim().notEmpty(),
    body('phone').optional().matches(/^\+254[0-9]{9}$/).withMessage('Phone must be +254XXXXXXXXX')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password, full_name, phone } = req.body;

      // Check existing
      const { data: existing } = await supabaseAdmin
        .from('users').select('id').eq('email', email).single();
      if (existing) return res.status(409).json({ error: 'Email already registered' });

      const passwordHash = await bcrypt.hash(password, 12);

      const { data: user, error } = await supabaseAdmin
        .from('users')
        .insert({ email, password_hash: passwordHash, full_name, phone })
        .select('id, email, full_name, role')
        .single();

      if (error) throw error;

      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d'
      });

      logger.info('New user registered', { userId: user.id, email });
      res.status(201).json({ token, user });
    } catch (err) { next(err); }
  }
);

// ─── Login ───────────────────────────────────────────────────────
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password } = req.body;

      const { data: user } = await supabaseAdmin
        .from('users')
        .select('id, email, full_name, role, is_active, password_hash, university_verified')
        .eq('email', email)
        .single();

      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      if (!user.is_active) return res.status(403).json({ error: 'Account suspended' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d'
      });

      const { password_hash, ...safeUser } = user;
      res.json({ token, user: safeUser });
    } catch (err) { next(err); }
  }
);

// ─── Get current user ────────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, phone, role, university_email, university_verified, kyc_status, created_at')
      .eq('id', req.user.id)
      .single();
    res.json(user);
  } catch (err) { next(err); }
});

// ─── Update profile ──────────────────────────────────────────────
router.patch('/me', authenticate,
  [
    body('full_name').optional().trim().notEmpty(),
    body('phone').optional().matches(/^\+254[0-9]{9}$/)
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const allowed = ['full_name', 'phone'];
      const updates = {};
      allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      updates.updated_at = new Date().toISOString();

      const { data: user } = await supabaseAdmin
        .from('users').update(updates).eq('id', req.user.id)
        .select('id, email, full_name, phone').single();

      res.json(user);
    } catch (err) { next(err); }
  }
);

// ─── Verify university email ─────────────────────────────────────
router.post('/verify-university', authenticate,
  [body('university_email').isEmail()],
  async (req, res, next) => {
    try {
      const { university_email } = req.body;
      const domain = university_email.split('@')[1]?.toLowerCase();

      const { data: allowedDomain } = await supabaseAdmin
        .from('university_domains')
        .select('institution')
        .eq('domain', domain)
        .eq('is_active', true)
        .single();

      if (!allowedDomain) {
        return res.status(400).json({
          error: 'Email domain not on approved university list',
          hint: 'Contact support if your institution is not listed'
        });
      }

      // In production: send verification email with OTP
      // For MVP: auto-verify if domain matches
      await supabaseAdmin.from('users').update({
        university_email,
        university_domain:   domain,
        university_verified: true,
        updated_at:          new Date().toISOString()
      }).eq('id', req.user.id);

      res.json({
        verified: true,
        institution: allowedDomain.institution,
        message: 'University access unlocked'
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
