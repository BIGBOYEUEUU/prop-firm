const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin } = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');
const { activateEvaluation } = require('../engine/evaluationEngine');

const router = express.Router();

// All admin routes require at minimum risk_admin role
router.use(authenticate);

// ─── Platform dashboard stats ─────────────────────────────────────
router.get('/stats', requireRole('risk_admin','payments_admin'), async (req, res, next) => {
  try {
    const [
      { count: totalUsers },
      { count: activeEvals },
      { count: breachedEvals },
      { count: fundedEvals },
      { data: revenueData }
    ] = await Promise.all([
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('evaluations').select('*', { count: 'exact', head: true }).eq('status','active'),
      supabaseAdmin.from('evaluations').select('*', { count: 'exact', head: true }).eq('status','breached'),
      supabaseAdmin.from('evaluations').select('*', { count: 'exact', head: true }).eq('status','funded'),
      supabaseAdmin.from('transactions')
        .select('amount_kes').eq('status','confirmed').eq('type','evaluation_fee')
    ]);

    const totalRevenueKES = (revenueData || []).reduce((s, t) => s + Number(t.amount_kes), 0);

    // Tier breakdown
    const { data: tierBreakdown } = await supabaseAdmin
      .from('evaluations')
      .select('tier_key, status')
      .neq('status', 'pending_payment');

    const byTier = {};
    (tierBreakdown || []).forEach(e => {
      if (!byTier[e.tier_key]) byTier[e.tier_key] = { active:0, breached:0, funded:0, passed:0 };
      if (byTier[e.tier_key][e.status] !== undefined) byTier[e.tier_key][e.status]++;
    });

    res.json({
      users:            totalUsers,
      activeEvals:      activeEvals,
      breachedEvals:    breachedEvals,
      fundedEvals:      fundedEvals,
      totalRevenueKES,
      passRate:         activeEvals + breachedEvals > 0
        ? ((fundedEvals / (fundedEvals + breachedEvals)) * 100).toFixed(1)
        : 0,
      byTier
    });
  } catch (err) { next(err); }
});

// ─── User management ──────────────────────────────────────────────
router.get('/users', requireRole('risk_admin'), async (req, res, next) => {
  try {
    const { search, role, limit = 50, offset = 0 } = req.query;
    let query = supabaseAdmin
      .from('users')
      .select('id, email, full_name, phone, role, is_active, kyc_status, university_verified, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
    if (role)   query = query.eq('role', role);

    const { data, count } = await query;
    res.json({ users: data, total: count });
  } catch (err) { next(err); }
});

router.patch('/users/:id', requireRole('risk_admin'), async (req, res, next) => {
  try {
    const allowed = ['role', 'is_active', 'kyc_status'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    updates.updated_at = new Date().toISOString();

    const { data } = await supabaseAdmin
      .from('users').update(updates).eq('id', req.params.id).select().single();

    // Audit log
    await supabaseAdmin.from('audit_log').insert({
      actor_id:    req.user.id,
      actor_email: req.user.email,
      action:      'update_user',
      table_name:  'users',
      record_id:   req.params.id,
      after_value: updates
    });

    res.json(data);
  } catch (err) { next(err); }
});

// ─── Evaluation management ────────────────────────────────────────
router.get('/evaluations', requireRole('risk_admin'), async (req, res, next) => {
  try {
    const { status, tier_key, limit = 50, offset = 0 } = req.query;
    let query = supabaseAdmin
      .from('evaluations')
      .select('*, users(full_name, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status)   query = query.eq('status', status);
    if (tier_key) query = query.eq('tier_key', tier_key);

    const { data, count } = await query;
    res.json({ evaluations: data, total: count });
  } catch (err) { next(err); }
});

// Admin advance Phase 1 → Phase 2
router.post('/evaluations/:id/advance', requireRole('risk_admin'), async (req, res, next) => {
  try {
    const { data: ev } = await supabaseAdmin
      .from('evaluations').select('*').eq('id', req.params.id).single();

    if (!ev) return res.status(404).json({ error: 'Evaluation not found' });
    if (ev.status !== 'passed' || ev.phase !== 1) {
      return res.status(400).json({ error: 'Evaluation must be Phase 1 passed to advance' });
    }

    // Create Phase 2 evaluation inheriting same rules
    const { data: phase2 } = await supabaseAdmin
      .from('evaluations')
      .insert({
        user_id:              ev.user_id,
        tier_key:             ev.tier_key,
        phase:                2,
        status:               'active',
        initial_balance:      ev.initial_balance,
        current_balance:      ev.initial_balance,
        peak_equity:          ev.initial_balance,
        start_of_day_bal:     ev.initial_balance,
        phase1_profit_target: ev.phase1_profit_target,
        phase2_profit_target: ev.phase2_profit_target,
        max_daily_dd:         ev.max_daily_dd,
        max_overall_dd:       ev.max_overall_dd,
        min_trading_days:     ev.min_trading_days,
        max_calendar_days:    ev.max_calendar_days,
        drawdown_model:       ev.drawdown_model,
        daily_dd_mode:        ev.daily_dd_mode,
        activated_at:         new Date().toISOString()
      })
      .select().single();

    await supabaseAdmin.from('audit_log').insert({
      actor_id:    req.user.id,
      actor_email: req.user.email,
      action:      'advance_to_phase2',
      table_name:  'evaluations',
      record_id:   ev.id,
      after_value: { phase2_id: phase2.id }
    });

    res.json({ phase1: ev.id, phase2: phase2.id });
  } catch (err) { next(err); }
});

// ─── Tier configuration ───────────────────────────────────────────
router.get('/tiers', async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin
      .from('tier_config').select('*').order('display_order');
    res.json(data);
  } catch (err) { next(err); }
});

router.patch('/tiers/:tier_key', requireRole('risk_admin'),
  [
    body('fee_kes').optional().isFloat({ min: 0 }),
    body('phase1_profit_target').optional().isFloat({ min: 1, max: 100 }),
    body('max_daily_dd').optional().isFloat({ min: 0.5, max: 20 }),
    body('max_overall_dd').optional().isFloat({ min: 1, max: 30 })
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const allowed = [
        'fee_kes','phase1_profit_target','phase2_profit_target',
        'max_daily_dd','max_overall_dd','min_trading_days',
        'max_calendar_days','drawdown_model','daily_dd_mode','is_active'
      ];
      const updates = {};
      allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      updates.updated_at = new Date().toISOString();

      const { data } = await supabaseAdmin
        .from('tier_config').update(updates)
        .eq('tier_key', req.params.tier_key).select().single();

      await supabaseAdmin.from('audit_log').insert({
        actor_id:    req.user.id,
        actor_email: req.user.email,
        action:      'update_tier',
        table_name:  'tier_config',
        record_id:   req.params.tier_key,
        after_value: updates
      });

      res.json(data);
    } catch (err) { next(err); }
  }
);

// ─── University domains ───────────────────────────────────────────
router.get('/university-domains', requireRole('university_admin'), async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin.from('university_domains').select('*').order('institution');
    res.json(data);
  } catch (err) { next(err); }
});

router.post('/university-domains', requireRole('university_admin'),
  [body('domain').trim().notEmpty(), body('institution').trim().notEmpty()],
  async (req, res, next) => {
    try {
      const { data } = await supabaseAdmin
        .from('university_domains')
        .insert({ domain: req.body.domain.toLowerCase(), institution: req.body.institution })
        .select().single();
      res.status(201).json(data);
    } catch (err) { next(err); }
  }
);

// ─── Audit log ────────────────────────────────────────────────────
router.get('/audit', requireRole('risk_admin'), async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin
      .from('audit_log').select('*').order('created_at', { ascending: false }).limit(200);
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
