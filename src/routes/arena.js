const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Current/upcoming competition ───────────────────────────────
router.get('/current', authenticate, async (req, res, next) => {
  try {
    const { data: comp } = await supabaseAdmin
      .from('arena_competitions')
      .select('*')
      .in('status', ['active', 'upcoming'])
      .order('starts_at')
      .limit(1)
      .single();

    if (!comp) return res.json({ message: 'No active competition' });

    // User's entry if any
    const { data: myEntry } = await supabaseAdmin
      .from('arena_entries')
      .select('*, evaluations(current_balance, initial_balance, status)')
      .eq('competition_id', comp.id)
      .eq('user_id', req.user.id)
      .single();

    res.json({ competition: comp, myEntry: myEntry || null });
  } catch (err) { next(err); }
});

// ─── Leaderboard ─────────────────────────────────────────────────
router.get('/:competition_id/leaderboard', authenticate, async (req, res, next) => {
  try {
    const { data: entries } = await supabaseAdmin
      .from('arena_entries')
      .select('rank, score, profit_pct, users(full_name, university_domain)')
      .eq('competition_id', req.params.competition_id)
      .order('rank')
      .limit(50);

    // Anonymise — only show first name + last initial
    const masked = (entries || []).map((e, i) => {
      const name = e.users?.full_name || 'Trader';
      const parts = name.split(' ');
      const display = parts.length > 1
        ? `${parts[0]} ${parts[parts.length-1][0]}.`
        : parts[0];
      return {
        rank:        e.rank || i + 1,
        display_name: display,
        university:  e.users?.university_domain?.replace('.ac.ke','').replace('.edu','').toUpperCase() || '—',
        profit_pct:  Number(e.profit_pct).toFixed(2),
        score:       Number(e.score).toFixed(2)
      };
    });

    res.json(masked);
  } catch (err) { next(err); }
});

// ─── Enter competition ────────────────────────────────────────────
router.post('/:competition_id/enter', authenticate, async (req, res, next) => {
  try {
    // Must be university verified
    if (!req.user.university_verified) {
      return res.status(403).json({
        error: 'University verification required',
        hint: 'Verify your university email at /api/auth/verify-university'
      });
    }

    const { data: comp } = await supabaseAdmin
      .from('arena_competitions')
      .select('*')
      .eq('id', req.params.competition_id)
      .in('status', ['active', 'upcoming'])
      .single();

    if (!comp) return res.status(404).json({ error: 'Competition not found or not active' });

    // Check not already entered
    const { data: existing } = await supabaseAdmin
      .from('arena_entries')
      .select('id')
      .eq('competition_id', comp.id)
      .eq('user_id', req.user.id)
      .single();

    if (existing) return res.status(409).json({ error: 'Already entered this competition' });

    // Arena entry uses a free $10,000 simulated evaluation
    const { data: evaluation } = await supabaseAdmin
      .from('evaluations')
      .insert({
        user_id:              req.user.id,
        tier_key:             'seed',
        phase:                1,
        status:               'active',
        initial_balance:      10000,
        current_balance:      10000,
        peak_equity:          10000,
        start_of_day_bal:     10000,
        phase1_profit_target: 10,
        phase2_profit_target: 5,
        max_daily_dd:         5,
        max_overall_dd:       10,
        min_trading_days:     1,
        max_calendar_days:    comp.ends_at
          ? Math.ceil((new Date(comp.ends_at) - Date.now()) / 86400000)
          : 30,
        drawdown_model:  'static',
        daily_dd_mode:   'A',
        activated_at:    new Date().toISOString()
      })
      .select()
      .single();

    const { data: entry } = await supabaseAdmin
      .from('arena_entries')
      .insert({
        competition_id: comp.id,
        user_id:        req.user.id,
        evaluation_id:  evaluation.id
      })
      .select()
      .single();

    res.status(201).json({ entry, evaluation });
  } catch (err) { next(err); }
});

// ─── Refresh leaderboard scores (admin or cron) ──────────────────
router.post('/:competition_id/refresh-scores', authenticate,
  requireRole('university_admin'),
  async (req, res, next) => {
    try {
      const { data: entries } = await supabaseAdmin
        .from('arena_entries')
        .select('id, evaluation_id')
        .eq('competition_id', req.params.competition_id);

      for (const entry of entries || []) {
        if (!entry.evaluation_id) continue;
        const { data: ev } = await supabaseAdmin
          .from('evaluations')
          .select('current_balance, initial_balance')
          .eq('id', entry.evaluation_id)
          .single();
        if (!ev) continue;
        const profitPct = ((ev.current_balance - ev.initial_balance) / ev.initial_balance) * 100;
        await supabaseAdmin.from('arena_entries')
          .update({ profit_pct: profitPct, score: profitPct })
          .eq('id', entry.id);
      }

      // Re-rank
      const { data: ranked } = await supabaseAdmin
        .from('arena_entries')
        .select('id')
        .eq('competition_id', req.params.competition_id)
        .order('score', { ascending: false });

      for (let i = 0; i < (ranked || []).length; i++) {
        await supabaseAdmin.from('arena_entries')
          .update({ rank: i + 1 }).eq('id', ranked[i].id);
      }

      res.json({ updated: entries?.length || 0 });
    } catch (err) { next(err); }
  }
);

module.exports = router;
