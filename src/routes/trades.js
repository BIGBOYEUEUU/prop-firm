const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin }     = require('../config/supabase');
const { authenticate }      = require('../middleware/auth');
const { checkEvaluation }   = require('../engine/evaluationEngine');

const router = express.Router();

// ─── List trades for an evaluation ──────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { evaluation_id, status, instrument, limit = 50, offset = 0 } = req.query;

    let query = supabaseAdmin
      .from('trades')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('opened_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (evaluation_id) query = query.eq('evaluation_id', evaluation_id);
    if (status)        query = query.eq('status', status);
    if (instrument)    query = query.ilike('instrument', `%${instrument}%`);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ trades: data, total: count });
  } catch (err) { next(err); }
});

// ─── Submit a new trade (open) ───────────────────────────────────
// In production this would be pushed by the MT5 bridge, not called by frontend
router.post('/',
  authenticate,
  [
    body('evaluation_id').isUUID(),
    body('instrument').trim().notEmpty(),
    body('direction').isIn(['BUY','SELL']),
    body('lot_size').isFloat({ min: 0.01 }),
    body('entry_price').isFloat({ min: 0 }),
    body('opened_at').isISO8601()
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { evaluation_id, instrument, direction, lot_size,
              entry_price, stop_loss, take_profit, opened_at,
              mt5_ticket, strategy_tag, notes } = req.body;

      // Verify evaluation belongs to user and is active
      const { data: ev } = await supabaseAdmin
        .from('evaluations')
        .select('id, status')
        .eq('id', evaluation_id)
        .eq('user_id', req.user.id)
        .single();

      if (!ev) return res.status(404).json({ error: 'Evaluation not found' });
      if (ev.status !== 'active') {
        return res.status(400).json({ error: `Cannot add trade to ${ev.status} evaluation` });
      }

      const openedDate = new Date(opened_at);
      // trading_day in EAT (UTC+3)
      const eatDate = new Date(openedDate.getTime() + 3 * 60 * 60 * 1000);
      const trading_day = eatDate.toISOString().split('T')[0];

      const { data: trade, error } = await supabaseAdmin
        .from('trades')
        .insert({
          evaluation_id, user_id: req.user.id,
          instrument, direction, lot_size, entry_price,
          stop_loss, take_profit, opened_at, trading_day,
          mt5_ticket, strategy_tag, notes,
          status: 'open'
        })
        .select()
        .single();

      if (error) throw error;
      res.status(201).json(trade);
    } catch (err) { next(err); }
  }
);

// ─── Close a trade ───────────────────────────────────────────────
router.patch('/:id/close',
  authenticate,
  [
    body('exit_price').isFloat({ min: 0 }),
    body('pnl').isFloat(),
    body('closed_at').isISO8601()
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { exit_price, pnl, closed_at, commission = 0, swap = 0 } = req.body;

      const { data: trade } = await supabaseAdmin
        .from('trades')
        .select('*, evaluations(status, user_id)')
        .eq('id', req.params.id)
        .single();

      if (!trade || trade.evaluations?.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Trade not found' });
      }
      if (trade.status !== 'open') {
        return res.status(400).json({ error: 'Trade already closed' });
      }

      const closedDate = new Date(closed_at);
      const eatDate    = new Date(closedDate.getTime() + 3 * 60 * 60 * 1000);
      const trading_day = eatDate.toISOString().split('T')[0];

      const { data: updated } = await supabaseAdmin
        .from('trades')
        .update({ exit_price, pnl, commission, swap, closed_at, trading_day, status: 'closed' })
        .eq('id', req.params.id)
        .select()
        .single();

      // Trigger rule check after each close
      await checkEvaluation(trade.evaluation_id);

      res.json(updated);
    } catch (err) { next(err); }
  }
);

// ─── Analytics for an evaluation ────────────────────────────────
router.get('/analytics/:evaluation_id', authenticate, async (req, res, next) => {
  try {
    const { evaluation_id } = req.params;

    const { data: trades } = await supabaseAdmin
      .from('trades')
      .select('*')
      .eq('evaluation_id', evaluation_id)
      .eq('user_id', req.user.id)
      .eq('status', 'closed');

    if (!trades?.length) return res.json({ message: 'No closed trades yet' });

    const winners = trades.filter(t => t.pnl > 0);
    const losers  = trades.filter(t => t.pnl <= 0);

    const grossProfit = winners.reduce((s, t) => s + Number(t.pnl), 0);
    const grossLoss   = Math.abs(losers.reduce((s, t) => s + Number(t.pnl), 0));

    // Time-of-day breakdown (EAT)
    const byHour = {};
    trades.forEach(t => {
      if (!t.opened_at) return;
      const h = new Date(new Date(t.opened_at).getTime() + 3 * 60 * 60 * 1000).getHours();
      if (!byHour[h]) byHour[h] = { trades: 0, pnl: 0 };
      byHour[h].trades++;
      byHour[h].pnl += Number(t.pnl || 0);
    });

    // Instrument breakdown
    const byInstrument = {};
    trades.forEach(t => {
      if (!byInstrument[t.instrument]) byInstrument[t.instrument] = { trades: 0, pnl: 0 };
      byInstrument[t.instrument].trades++;
      byInstrument[t.instrument].pnl += Number(t.pnl || 0);
    });

    // Avg hold time
    const holdTimes = trades
      .filter(t => t.opened_at && t.closed_at)
      .map(t => new Date(t.closed_at) - new Date(t.opened_at));
    const avgHoldMs = holdTimes.reduce((s, h) => s + h, 0) / (holdTimes.length || 1);

    res.json({
      summary: {
        totalTrades:  trades.length,
        winRate:      trades.length ? ((winners.length / trades.length) * 100).toFixed(1) : 0,
        profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞',
        avgRR:        grossLoss > 0 && winners.length > 0 && losers.length > 0
          ? (grossProfit / winners.length / (grossLoss / losers.length)).toFixed(2)
          : 'N/A',
        bestTrade:    Math.max(...trades.map(t => Number(t.pnl || 0))),
        worstTrade:   Math.min(...trades.map(t => Number(t.pnl || 0))),
        avgHoldMins:  Math.round(avgHoldMs / 60000)
      },
      byHour,
      byInstrument
    });
  } catch (err) { next(err); }
});

// ─── MT5 bridge webhook (called by your MT5 bridge service) ──────
// Protected by a shared secret header, not user JWT
router.post('/mt5-sync', async (req, res, next) => {
  try {
    const secret = req.headers['x-mt5-secret'];
    if (secret !== process.env.MT5_BRIDGE_SECRET) {
      return res.status(401).json({ error: 'Invalid bridge secret' });
    }

    const { action, trade } = req.body;
    // action: 'open' | 'update' | 'close'

    if (action === 'open') {
      // Find the evaluation matching this MT5 account login
      const { data: ev } = await supabaseAdmin
        .from('evaluations')
        .select('id, user_id, status')
        .eq('mt5_login', trade.account_login)
        .eq('status', 'active')
        .single();

      if (!ev) return res.status(404).json({ error: 'No active evaluation for this MT5 account' });

      await supabaseAdmin.from('trades').insert({
        evaluation_id: ev.id, user_id: ev.user_id,
        mt5_ticket:    trade.ticket,
        instrument:    trade.symbol,
        direction:     trade.type === 0 ? 'BUY' : 'SELL',
        lot_size:      trade.volume,
        entry_price:   trade.price_open,
        stop_loss:     trade.sl,
        take_profit:   trade.tp,
        opened_at:     new Date(trade.time_open * 1000).toISOString(),
        trading_day:   new Date(trade.time_open * 1000 + 3 * 3600000).toISOString().split('T')[0],
        status:        'open'
      });
    }

    if (action === 'close') {
      const { data: t } = await supabaseAdmin
        .from('trades').select('id, evaluation_id').eq('mt5_ticket', trade.ticket).single();

      if (t) {
        const closedAt = new Date(trade.time_close * 1000);
        await supabaseAdmin.from('trades').update({
          exit_price: trade.price_close,
          pnl:        trade.profit,
          commission: trade.commission,
          swap:       trade.swap,
          closed_at:  closedAt.toISOString(),
          trading_day: new Date(closedAt.getTime() + 3 * 3600000).toISOString().split('T')[0],
          status:     'closed'
        }).eq('id', t.id);

        await checkEvaluation(t.evaluation_id);
      }
    }

    if (action === 'update') {
      // Update floating P&L on open trade
      await supabaseAdmin.from('trades')
        .update({ pnl: trade.profit })
        .eq('mt5_ticket', trade.ticket)
        .eq('status', 'open');
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
