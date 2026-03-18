const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin } = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_CATEGORIES = [
  'account_access', 'evaluation_rules', 'payment_mpesa',
  'technical_issue', 'education', 'university_arena', 'other'
];

// ─── My tickets ──────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin
      .from('support_tickets')
      .select('id, ticket_number, category, subject, status, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err) { next(err); }
});

// ─── Get ticket + messages ───────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { data: ticket } = await supabaseAdmin
      .from('support_tickets')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { data: messages } = await supabaseAdmin
      .from('ticket_messages')
      .select('*, users(full_name, role)')
      .eq('ticket_id', ticket.id)
      .eq('is_internal', false)
      .order('created_at');

    res.json({ ...ticket, messages });
  } catch (err) { next(err); }
});

// ─── Create ticket ───────────────────────────────────────────────
router.post('/',
  authenticate,
  [
    body('category').isIn(VALID_CATEGORIES),
    body('subject').trim().isLength({ min: 5, max: 200 }),
    body('description').trim().isLength({ min: 10, max: 2000 })
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { category, subject, description } = req.body;

      const { data: ticket } = await supabaseAdmin
        .from('support_tickets')
        .insert({ user_id: req.user.id, category, subject, description })
        .select()
        .single();

      // Create initial message from user
      await supabaseAdmin.from('ticket_messages').insert({
        ticket_id: ticket.id, sender_id: req.user.id, message: description
      });

      res.status(201).json(ticket);
    } catch (err) { next(err); }
  }
);

// ─── Reply to ticket ─────────────────────────────────────────────
router.post('/:id/reply',
  authenticate,
  [body('message').trim().isLength({ min: 1, max: 2000 })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { data: ticket } = await supabaseAdmin
        .from('support_tickets').select('id, status, user_id')
        .eq('id', req.params.id).single();

      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      // Only ticket owner or support staff can reply
      const isOwner = ticket.user_id === req.user.id;
      const isStaff = ['support_admin','super_admin'].includes(req.user.role);
      if (!isOwner && !isStaff) return res.status(403).json({ error: 'Forbidden' });

      if (ticket.status === 'closed') {
        return res.status(400).json({ error: 'Cannot reply to a closed ticket' });
      }

      const { data: msg } = await supabaseAdmin
        .from('ticket_messages')
        .insert({ ticket_id: ticket.id, sender_id: req.user.id, message: req.body.message })
        .select('*, users(full_name, role)')
        .single();

      // Re-open if closed by staff and user replies
      if (ticket.status === 'resolved' && isOwner) {
        await supabaseAdmin.from('support_tickets')
          .update({ status: 'open', updated_at: new Date().toISOString() })
          .eq('id', ticket.id);
      }

      res.status(201).json(msg);
    } catch (err) { next(err); }
  }
);

// ─── Admin: all tickets ──────────────────────────────────────────
router.get('/admin/all', authenticate, requireRole('support_admin'), async (req, res, next) => {
  try {
    const { status, category } = req.query;
    let query = supabaseAdmin
      .from('support_tickets')
      .select('*, users(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (status)   query = query.eq('status', status);
    if (category) query = query.eq('category', category);
    const { data } = await query;
    res.json(data || []);
  } catch (err) { next(err); }
});

// ─── Admin: update ticket status ─────────────────────────────────
router.patch('/admin/:id', authenticate, requireRole('support_admin'),
  [body('status').isIn(['open','in_progress','resolved','closed'])],
  async (req, res, next) => {
    try {
      const updates = {
        status:     req.body.status,
        updated_at: new Date().toISOString()
      };
      if (req.body.status === 'resolved') updates.resolved_at = new Date().toISOString();
      if (req.body.assigned_to) updates.assigned_to = req.body.assigned_to;

      const { data } = await supabaseAdmin
        .from('support_tickets').update(updates)
        .eq('id', req.params.id).select().single();
      res.json(data);
    } catch (err) { next(err); }
  }
);

module.exports = router;
