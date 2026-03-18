/**
 * TRD-WISE Evaluation Engine
 * ──────────────────────────
 * Core rule enforcement. Called:
 *  1. After every trade close (triggered by trade route)
 *  2. Every 5 minutes by the cron job (catches open-position breaches)
 *  3. After daily reset
 */

const { supabaseAdmin } = require('../config/supabase');
const logger            = require('../config/logger');

// ─── Main entry point ────────────────────────────────────────────
// Call this after any trade event or on a schedule
const checkEvaluation = async (evaluationId) => {
  try {
    const { data: ev, error } = await supabaseAdmin
      .from('evaluations')
      .select('*')
      .eq('id', evaluationId)
      .single();

    if (error || !ev) throw new Error(`Evaluation ${evaluationId} not found`);
    if (ev.status !== 'active') return { ok: true, status: ev.status };

    // Calculate current metrics from trades
    const metrics = await computeMetrics(ev);

    // Update evaluation with latest metrics
    await supabaseAdmin.from('evaluations').update({
      current_balance:    metrics.currentBalance,
      peak_equity:        Math.max(ev.peak_equity, metrics.currentEquity),
      current_daily_dd:   metrics.dailyDDPct,
      current_overall_dd: metrics.overallDDPct,
      current_profit_pct: metrics.profitPct,
      trading_days_count: metrics.tradingDays,
      updated_at:         new Date().toISOString()
    }).eq('id', evaluationId);

    // ── Check breaches ──────────────────────────────────────────
    const breach = detectBreach(ev, metrics);
    if (breach) {
      await applyBreach(ev, breach, metrics);
      return { ok: false, breached: true, breach };
    }

    // ── Check pass condition ────────────────────────────────────
    const passed = detectPass(ev, metrics);
    if (passed) {
      await applyPass(ev, metrics);
      return { ok: true, passed: true };
    }

    // ── Warning events ──────────────────────────────────────────
    await checkWarnings(ev, metrics);

    return { ok: true, metrics };
  } catch (err) {
    logger.error('checkEvaluation error', { evaluationId, err: err.message });
    throw err;
  }
};

// ─── Compute current metrics from trade data ─────────────────────
const computeMetrics = async (ev) => {
  // All closed trades for this evaluation
  const { data: closedTrades } = await supabaseAdmin
    .from('trades')
    .select('pnl, commission, swap, trading_day, closed_at')
    .eq('evaluation_id', ev.id)
    .eq('status', 'closed');

  // All open trades (floating P&L)
  const { data: openTrades } = await supabaseAdmin
    .from('trades')
    .select('pnl')
    .eq('evaluation_id', ev.id)
    .eq('status', 'open');

  const closedPnL = (closedTrades || []).reduce(
    (sum, t) => sum + Number(t.pnl || 0) + Number(t.commission || 0) + Number(t.swap || 0), 0
  );
  const floatingPnL = (openTrades || []).reduce((sum, t) => sum + Number(t.pnl || 0), 0);

  const currentBalance = ev.initial_balance + closedPnL;
  const currentEquity  = currentBalance + floatingPnL;

  // Profit % based on closed P&L only (balance)
  const profitPct = ((currentBalance - ev.initial_balance) / ev.initial_balance) * 100;

  // ── Daily drawdown ──────────────────────────────────────────
  let dailyDDPct = 0;
  if (ev.daily_dd_mode === 'A') {
    // Mode A: from start-of-day balance
    const basis = ev.start_of_day_bal || ev.initial_balance;
    dailyDDPct = Math.max(0, ((basis - currentEquity) / basis) * 100);
  } else if (ev.daily_dd_mode === 'B') {
    // Mode B: from intraday peak equity (tracked in peak_equity per day)
    const peak = ev.peak_equity;
    dailyDDPct = Math.max(0, ((peak - currentEquity) / peak) * 100);
  } else {
    // Mode C: fixed threshold from initial balance
    dailyDDPct = Math.max(0, ((ev.initial_balance - currentEquity) / ev.initial_balance) * 100);
  }

  // ── Overall drawdown ─────────────────────────────────────────
  let overallDDPct = 0;
  if (ev.drawdown_model === 'static') {
    overallDDPct = Math.max(0, ((ev.initial_balance - currentEquity) / ev.initial_balance) * 100);
  } else if (ev.drawdown_model === 'trailing') {
    overallDDPct = Math.max(0, ((ev.peak_equity - currentEquity) / ev.peak_equity) * 100);
  } else {
    // Hybrid: trail until a threshold (50% of max DD), then static
    const hybridThreshold = ev.initial_balance * (1 + (ev.max_overall_dd * 0.5 / 100));
    if (ev.peak_equity > hybridThreshold) {
      overallDDPct = Math.max(0, ((ev.peak_equity - currentEquity) / ev.peak_equity) * 100);
    } else {
      overallDDPct = Math.max(0, ((ev.initial_balance - currentEquity) / ev.initial_balance) * 100);
    }
  }

  // ── Unique trading days ──────────────────────────────────────
  const uniqueDays = new Set((closedTrades || []).map(t => t.trading_day).filter(Boolean));
  const tradingDays = uniqueDays.size;

  return {
    currentBalance,
    currentEquity,
    closedPnL,
    floatingPnL,
    profitPct,
    dailyDDPct,
    overallDDPct,
    tradingDays
  };
};

// ─── Detect breaches ─────────────────────────────────────────────
const detectBreach = (ev, metrics) => {
  if (metrics.dailyDDPct >= ev.max_daily_dd) {
    return {
      rule:      'max_daily_drawdown',
      message:   `Daily drawdown of ${metrics.dailyDDPct.toFixed(2)}% exceeded limit of ${ev.max_daily_dd}%`,
      value:     metrics.dailyDDPct,
      threshold: ev.max_daily_dd
    };
  }
  if (metrics.overallDDPct >= ev.max_overall_dd) {
    return {
      rule:      'max_overall_drawdown',
      message:   `Overall drawdown of ${metrics.overallDDPct.toFixed(2)}% exceeded limit of ${ev.max_overall_dd}%`,
      value:     metrics.overallDDPct,
      threshold: ev.max_overall_dd
    };
  }
  // Calendar day expiry
  if (ev.max_calendar_days && ev.activated_at) {
    const daysSince = Math.floor(
      (Date.now() - new Date(ev.activated_at)) / (1000 * 60 * 60 * 24)
    );
    if (daysSince > ev.max_calendar_days) {
      return {
        rule:      'max_calendar_days',
        message:   `Evaluation expired after ${daysSince} calendar days (limit: ${ev.max_calendar_days})`,
        value:     daysSince,
        threshold: ev.max_calendar_days
      };
    }
  }
  return null;
};

// ─── Detect pass condition ────────────────────────────────────────
const detectPass = (ev, metrics) => {
  const targetPct = ev.phase === 1 ? ev.phase1_profit_target : ev.phase2_profit_target;
  return (
    metrics.profitPct  >= targetPct          &&
    metrics.tradingDays >= ev.min_trading_days &&
    metrics.dailyDDPct  < ev.max_daily_dd     &&
    metrics.overallDDPct < ev.max_overall_dd
  );
};

// ─── Apply breach ─────────────────────────────────────────────────
const applyBreach = async (ev, breach, metrics) => {
  logger.warn('BREACH', { evaluationId: ev.id, rule: breach.rule });

  await supabaseAdmin.from('evaluations').update({
    status:       'breached',
    breach_rule:  breach.rule,
    breach_value: breach.value,
    breach_at:    new Date().toISOString(),
    updated_at:   new Date().toISOString()
  }).eq('id', ev.id);

  await logRuleEvent(ev.id, 'breach', breach.rule, breach.message, breach.value, breach.threshold);

  // TODO: send breach email/push notification to user
};

// ─── Apply pass ──────────────────────────────────────────────────
const applyPass = async (ev, metrics) => {
  logger.info('PASS', { evaluationId: ev.id, phase: ev.phase });

  if (ev.phase === 1) {
    // Phase 1 passed → set to 'passed', admin will activate Phase 2
    await supabaseAdmin.from('evaluations').update({
      status:    'passed',
      passed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', ev.id);

    await logRuleEvent(ev.id, 'pass', 'phase1_complete',
      `Phase 1 passed with ${metrics.profitPct.toFixed(2)}% profit and ${metrics.tradingDays} trading days`,
      metrics.profitPct, ev.phase1_profit_target
    );

    // Issue Phase 1 certificate
    await issueCertificate(ev.user_id, ev.id, 'phase',
      `Phase 1 Passed — ${ev.tier_key.charAt(0).toUpperCase() + ev.tier_key.slice(1)} Evaluation`
    );
  } else if (ev.phase === 2) {
    // Phase 2 passed → funded
    await supabaseAdmin.from('evaluations').update({
      status:    'funded',
      passed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', ev.id);

    await logRuleEvent(ev.id, 'pass', 'phase2_complete',
      `Phase 2 passed — account funded`,
      metrics.profitPct, ev.phase2_profit_target
    );

    await issueCertificate(ev.user_id, ev.id, 'phase', 'Funded Account Issued');
  }
};

// ─── Warning events ──────────────────────────────────────────────
const checkWarnings = async (ev, metrics) => {
  const dailyWarnThreshold  = ev.max_daily_dd  * 0.80;  // warn at 80% of limit
  const overallWarnThreshold = ev.max_overall_dd * 0.80;

  if (metrics.dailyDDPct >= dailyWarnThreshold) {
    await logRuleEvent(ev.id, 'warning', 'daily_dd_warning',
      `Daily DD at ${metrics.dailyDDPct.toFixed(2)}% — approaching ${ev.max_daily_dd}% limit`,
      metrics.dailyDDPct, ev.max_daily_dd
    );
  }
  if (metrics.overallDDPct >= overallWarnThreshold) {
    await logRuleEvent(ev.id, 'warning', 'overall_dd_warning',
      `Overall DD at ${metrics.overallDDPct.toFixed(2)}% — approaching ${ev.max_overall_dd}% limit`,
      metrics.overallDDPct, ev.max_overall_dd
    );
  }
};

// ─── Daily reset (called by cron at midnight EAT) ────────────────
const dailyReset = async (evaluationId) => {
  const { data: ev } = await supabaseAdmin
    .from('evaluations')
    .select('id, status, current_balance')
    .eq('id', evaluationId)
    .single();

  if (!ev || ev.status !== 'active') return;

  await supabaseAdmin.from('evaluations').update({
    start_of_day_bal: ev.current_balance,
    current_daily_dd: 0,
    updated_at:       new Date().toISOString()
  }).eq('id', evaluationId);

  await logRuleEvent(evaluationId, 'reset', 'daily_reset',
    `Daily drawdown reset. New start-of-day balance: $${ev.current_balance}`,
    null, null
  );
};

// ─── Helpers ─────────────────────────────────────────────────────
const logRuleEvent = async (evaluationId, type, rule, message, value, threshold) => {
  // Deduplicate — don't log same warning twice in same day
  if (type === 'warning') {
    const today = new Date().toISOString().split('T')[0];
    const { data: existing } = await supabaseAdmin
      .from('rule_events')
      .select('id')
      .eq('evaluation_id', evaluationId)
      .eq('rule_name', rule)
      .gte('created_at', today)
      .limit(1);
    if (existing?.length > 0) return;
  }

  await supabaseAdmin.from('rule_events').insert({
    evaluation_id:  evaluationId,
    event_type:     type,
    rule_name:      rule,
    message,
    value_at_event: value,
    threshold
  });
};

const issueCertificate = async (userId, referenceId, type, title) => {
  await supabaseAdmin.from('certificates').insert({
    user_id:      userId,
    type,
    title,
    reference_id: referenceId
  });
};

// ─── Activate a new evaluation after payment ─────────────────────
const activateEvaluation = async (evaluationId) => {
  const { data: ev } = await supabaseAdmin
    .from('evaluations')
    .select('*, tier_config(*)')
    .eq('id', evaluationId)
    .single();

  if (!ev || ev.status !== 'pending_payment') return;

  const now = new Date();
  const expiresAt = ev.max_calendar_days
    ? new Date(now.getTime() + ev.max_calendar_days * 24 * 60 * 60 * 1000)
    : null;

  await supabaseAdmin.from('evaluations').update({
    status:           'active',
    activated_at:     now.toISOString(),
    expires_at:       expiresAt?.toISOString() || null,
    start_of_day_bal: ev.initial_balance,
    peak_equity:      ev.initial_balance,
    updated_at:       now.toISOString()
  }).eq('id', evaluationId);

  await logRuleEvent(evaluationId, 'info', 'activation',
    `Evaluation activated. Initial balance: $${ev.initial_balance}`,
    null, null
  );

  return true;
};

module.exports = {
  checkEvaluation,
  computeMetrics,
  dailyReset,
  activateEvaluation,
  logRuleEvent
};
