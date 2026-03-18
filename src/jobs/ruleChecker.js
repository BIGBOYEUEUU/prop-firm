const { supabaseAdmin }  = require('../config/supabase');
const { checkEvaluation, dailyReset } = require('../engine/evaluationEngine');
const logger = require('../config/logger');

// ─── Daily DD reset (runs at midnight EAT) ───────────────────────
const runDailyReset = async () => {
  logger.info('Running daily reset for all active evaluations');
  try {
    const { data: activeEvals, error } = await supabaseAdmin
      .from('evaluations')
      .select('id')
      .eq('status', 'active');

    if (error) throw error;
    if (!activeEvals?.length) return;

    await Promise.all(activeEvals.map(ev => dailyReset(ev.id)));
    logger.info(`Daily reset complete for ${activeEvals.length} evaluations`);
  } catch (err) {
    logger.error('Daily reset failed', { error: err.message });
  }
};

// ─── Rule checks (runs every 5 minutes) ─────────────────────────
// Catches breaches on open positions / calendar expiry
const runRuleChecks = async () => {
  try {
    const { data: activeEvals } = await supabaseAdmin
      .from('evaluations')
      .select('id')
      .eq('status', 'active');

    if (!activeEvals?.length) return;

    // Process in batches of 10 to avoid overwhelming the DB
    const batchSize = 10;
    for (let i = 0; i < activeEvals.length; i += batchSize) {
      const batch = activeEvals.slice(i, i + batchSize);
      await Promise.all(batch.map(ev => checkEvaluation(ev.id).catch(err =>
        logger.error('Rule check failed for eval', { evalId: ev.id, err: err.message })
      )));
    }
  } catch (err) {
    logger.error('Rule checks failed', { error: err.message });
  }
};

module.exports = { runDailyReset, runRuleChecks };
