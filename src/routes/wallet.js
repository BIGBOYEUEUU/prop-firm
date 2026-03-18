const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin }       = require('../config/supabase');
const { authenticate }        = require('../middleware/auth');
const { activateEvaluation }  = require('../engine/evaluationEngine');
const logger = require('../config/logger');

const router = express.Router();

// Demo mode: skip M-PESA entirely, auto-confirm all payments
const DEMO_MODE = process.env.DEMO_MODE === 'true' || !process.env.MPESA_CONSUMER_KEY;

// ─── Initiate payment for an evaluation ─────────────────────────
router.post('/pay',
  authenticate,
  [
    body('evaluation_id').isUUID(),
    body('phone').optional().matches(/^\+254[0-9]{9}$/).withMessage('Phone must be +254XXXXXXXXX')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { evaluation_id, phone } = req.body;

      // Verify evaluation belongs to user and is pending payment
      const { data: ev } = await supabaseAdmin
        .from('evaluations')
        .select('id, tier_key, status')
        .eq('id', evaluation_id)
        .eq('user_id', req.user.id)
        .single();

      if (!ev) return res.status(404).json({ error: 'Evaluation not found' });
      if (ev.status !== 'pending_payment') {
        return res.status(400).json({ error: `Evaluation is already ${ev.status}` });
      }

      // Get fee from tier config
      const { data: tier } = await supabaseAdmin
        .from('tier_config').select('fee_kes, tier_name').eq('tier_key', ev.tier_key).single();

      if (!tier) return res.status(400).json({ error: 'Tier config not found' });

      // ── DEMO MODE: auto-confirm instantly ────────────────────
      if (DEMO_MODE) {
        logger.info('DEMO MODE: auto-confirming payment', { evaluation_id });

        const { data: tx } = await supabaseAdmin
          .from('transactions')
          .insert({
            user_id:           req.user.id,
            evaluation_id:     ev.id,
            type:              'evaluation_fee',
            amount_kes:        tier.fee_kes,
            mpesa_phone:       phone || '+254700000000',
            mpesa_receipt:     `DEMO${Date.now()}`,
            mpesa_result_desc: 'Demo auto-confirmed',
            status:            'confirmed',
            confirmed_at:      new Date().toISOString()
          })
          .select()
          .single();

        await activateEvaluation(ev.id);

        return res.json({
          demo:           true,
          message:        '✅ Demo payment confirmed instantly. Evaluation is now active.',
          transaction_id: tx.id,
          status:         'confirmed',
          amount_kes:     tier.fee_kes
        });
      }

      // ── PRODUCTION: real M-PESA STK Push ─────────────────────
      const { initiateSTKPush } = require('../engine/mpesa');

      const { data: tx } = await supabaseAdmin
        .from('transactions')
        .insert({
          user_id:       req.user.id,
          evaluation_id: ev.id,
          type:          'evaluation_fee',
          amount_kes:    tier.fee_kes,
          mpesa_phone:   phone,
          status:        'pending'
        })
        .select()
        .single();

      const stkResult = await initiateSTKPush({
        phone,
        amountKES:     tier.fee_kes,
        transactionId: tx.id,
        description:   `TRD-WISE ${tier.tier_name} Evaluation Fee`
      });

      if (!stkResult.success) {
        await supabaseAdmin.from('transactions')
          .update({ status: 'failed', mpesa_result_desc: stkResult.responseDesc })
          .eq('id', tx.id);
        return res.status(400).json({ error: 'M-PESA request failed', detail: stkResult.responseDesc });
      }

      await supabaseAdmin.from('transactions')
        .update({ mpesa_checkout_id: stkResult.checkoutId })
        .eq('id', tx.id);

      logger.info('STK push sent', { txId: tx.id, checkoutId: stkResult.checkoutId });

      res.json({
        message:        stkResult.customerMessage,
        transaction_id: tx.id,
        checkout_id:    stkResult.checkoutId,
        amount_kes:     tier.fee_kes,
        phone,
        poll_url:       `/api/wallet/status/${tx.id}`
      });
    } catch (err) { next(err); }
  }
);

// ─── Poll transaction status ─────────────────────────────────────
router.get('/status/:transaction_id', authenticate, async (req, res, next) => {
  try {
    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('id', req.params.transaction_id)
      .eq('user_id', req.user.id)
      .single();

    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    // In demo mode transactions are already confirmed — just return
    if (DEMO_MODE || tx.status !== 'pending' || !tx.mpesa_checkout_id) {
      return res.json(tx);
    }

    // Production: query Daraja directly if pending for >30s
    const { querySTKStatus } = require('../engine/mpesa');
    const ageSeconds = (Date.now() - new Date(tx.created_at)) / 1000;
    if (ageSeconds > 30) {
      try {
        const status = await querySTKStatus(tx.mpesa_checkout_id);
        if (status.resultCode === '0') {
          await confirmTransaction(tx.id, tx.evaluation_id, null, status.resultDesc);
        } else if (status.resultCode !== undefined && status.resultCode !== '0') {
          await supabaseAdmin.from('transactions')
            .update({ status: 'failed', mpesa_result_desc: status.resultDesc })
            .eq('id', tx.id);
        }
      } catch { /* Daraja query failed, keep pending */ }
    }

    const { data: freshTx } = await supabaseAdmin
      .from('transactions').select('*').eq('id', tx.id).single();

    res.json(freshTx);
  } catch (err) { next(err); }
});

// ─── M-PESA callback (called by Safaricom) ───────────────────────
// Skipped entirely in demo mode
router.post('/mpesa/callback', async (req, res, next) => {
  if (DEMO_MODE) {
    return res.json({ ResultCode: 0, ResultDesc: 'Demo mode — callback ignored' });
  }

  try {
    logger.info('M-PESA callback received', { body: req.body });
    const { parseCallback } = require('../engine/mpesa');
    const parsed = parseCallback(req.body);

    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .select('id, evaluation_id, user_id')
      .eq('mpesa_checkout_id', parsed.checkoutId)
      .single();

    if (!tx) {
      logger.warn('M-PESA callback: no matching transaction', { checkoutId: parsed.checkoutId });
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    if (parsed.success) {
      await confirmTransaction(tx.id, tx.evaluation_id, parsed.receipt, parsed.resultDesc);
      logger.info('Payment confirmed', { txId: tx.id, receipt: parsed.receipt });
    } else {
      await supabaseAdmin.from('transactions').update({
        status:             'failed',
        mpesa_result_code:  parsed.resultCode,
        mpesa_result_desc:  parsed.resultDesc,
        updated_at:         new Date().toISOString()
      }).eq('id', tx.id);
      logger.warn('Payment failed', { txId: tx.id, resultCode: parsed.resultCode });
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    logger.error('Callback processing error', { err: err.message });
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// ─── Transaction history ─────────────────────────────────────────
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('id, type, amount_kes, mpesa_phone, mpesa_receipt, status, confirmed_at, created_at, evaluation_id')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ─── Helper: confirm transaction + activate evaluation ───────────
const confirmTransaction = async (txId, evaluationId, receipt, desc) => {
  await supabaseAdmin.from('transactions').update({
    status:            'confirmed',
    mpesa_receipt:     receipt,
    mpesa_result_desc: desc,
    confirmed_at:      new Date().toISOString(),
    updated_at:        new Date().toISOString()
  }).eq('id', txId);

  if (evaluationId) {
    await activateEvaluation(evaluationId);
  }
};

module.exports = router;
