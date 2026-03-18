const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin }     = require('../config/supabase');
const { authenticate }      = require('../middleware/auth');
const { checkEvaluation, computeMetrics, activateEvaluation } = require('../engine/evaluationEngine');
const logger = require('../config/logger');

const router = express.Router();

// ─── List my evaluations ─────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = supabaseAdmin
      .from('evaluations')
      .select(`
        id, tier_key, phase, status,
        initial_balance, current_balance, peak_equity,
        current_daily_dd, current_overall_dd, current_profit_pct,
        trading_days_count, min_trading_days,
        phase1_profit_target, phase2_profit_target,
        max_daily_dd, max_overall_dd,
        drawdown_model, daily_dd_mode,
        breach_rule, breach_at,
        activated_at, passed_at, expires_at, created_at
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ─── Get single evaluation with full rule state ──────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { data: ev, error } = await supabaseAdmin
      .from('evaluations')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !ev) return res.status(404).json({ error: 'Evaluation not found' });

    // Get latest metrics and rule events
    const [metrics, { data: events }] = await Promise.all([
      computeMetrics(ev),
      supabaseAdmin
        .from('rule_events')
        .select('*')
        .eq('evaluation_id', ev.id)
        .order('created_at', { ascending: false })
        .limit(50)
    ]);

    // Time remaining
    let daysRemaining = null;
    if (ev.expires_at) {
      daysRemaining = Math.max(0, Math.ceil(
        (new Date(ev.expires_at) - Date.now()) / (1000 * 60 * 60 * 24)
      ));
    }

    res.json({ ...ev, metrics, events, daysRemaining });
  } catch (err) { next(err); }
});

// ─── Create evaluation (pre-payment, status = pending_payment) ───
router.post('/',
  authenticate,
  [body('tier_key').isIn(['seed','sprint','ascend','apex'])],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { tier_key } = req.body;

      // Get tier config
      const { data: tier, error: tierError } = await supabaseAdmin
        .from('tier_config')
        .select('*')
        .eq('tier_key', tier_key)
        .eq('is_active', true)
        .single();

      if (tierError || !tier) return res.status(404).json({ error: 'Tier not found or inactive' });

      // Create evaluation with immutable rule snapshot
      const { data: ev, error } = await supabaseAdmin
        .from('evaluations')
        .insert({
          user_id:              req.user.id,
          tier_key,
          phase:                1,
          status:               'pending_payment',
          initial_balance:      tier.account_size_usd,
          current_balance:      tier.account_size_usd,
          peak_equity:          tier.account_size_usd,
          // Snapshot rules at time of purchase — never changes
          phase1_profit_target: tier.phase1_profit_target,
          phase2_profit_target: tier.phase2_profit_target,
          max_daily_dd:         tier.max_daily_dd,
          max_overall_dd:       tier.max_overall_dd,
          min_trading_days:     tier.min_trading_days,
          max_calendar_days:    tier.max_calendar_days,
          drawdown_model:       tier.drawdown_model,
          daily_dd_mode:        tier.daily_dd_mode
        })
        .select()
        .single();

      if (error) throw error;

      logger.info('Evaluation created', { userId: req.user.id, tier_key, evalId: ev.id });
      res.status(201).json({ evaluation: ev, fee_kes: tier.fee_kes });
    } catch (err) { next(err); }
  }
);

// ─── Get rules monitor data ──────────────────────────────────────
router.get('/:id/rules', authenticate, async (req, res, next) => {
  try {
    const { data: ev } = await supabaseAdmin
      .from('evaluations')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (!ev) return res.status(404).json({ error: 'Evaluation not found' });

    const metrics = await computeMetrics(ev);

    // Daily reset countdown
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);  // next midnight
    const resetSecondsRemaining = Math.floor((midnight - now) / 1000);

    res.json({
      evaluation: {
        id: ev.id, tier_key: ev.tier_key, phase: ev.phase, status: ev.status,
        initial_balance: ev.initial_balance
      },
      rules: {
        phase1_profit_target: ev.phase1_profit_target,
        phase2_profit_target: ev.phase2_profit_target,
        max_daily_dd:         ev.max_daily_dd,
        max_overall_dd:       ev.max_overall_dd,
        min_trading_days:     ev.min_trading_days,
        drawdown_model:       ev.drawdown_model,
        daily_dd_mode:        ev.daily_dd_mode
      },
      metrics,
      resetSecondsRemaining,
      startOfDayBalance: ev.start_of_day_bal
    });
  } catch (err) { next(err); }
});

// ─── Trigger manual rule check (useful after manual trade entry) ─
router.post('/:id/check', authenticate, async (req, res, next) => {
  try {
    const { data: ev } = await supabaseAdmin
      .from('evaluations')
      .select('id, user_id')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (!ev) return res.status(404).json({ error: 'Evaluation not found' });

    const result = await checkEvaluation(ev.id);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
