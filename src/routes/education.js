const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabaseAdmin } = require('../config/supabase');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Courses ─────────────────────────────────────────────────────
router.get('/courses', authenticate, async (req, res, next) => {
  try {
    const { category, level } = req.query;
    let query = supabaseAdmin
      .from('courses').select('*').eq('is_published', true).order('display_order');
    if (category) query = query.eq('category', category);
    if (level)    query = query.eq('level', level);
    const { data } = await query;

    // Get user progress
    const { data: progress } = await supabaseAdmin
      .from('course_progress')
      .select('course_id, completed')
      .eq('user_id', req.user.id);

    const progressMap = {};
    (progress || []).forEach(p => { progressMap[p.course_id] = p.completed; });

    const enriched = (data || []).map(c => ({
      ...c,
      completed: progressMap[c.id] || false
    }));

    res.json(enriched);
  } catch (err) { next(err); }
});

router.post('/courses/:id/complete', authenticate, async (req, res, next) => {
  try {
    const { data: course } = await supabaseAdmin
      .from('courses').select('id, title').eq('id', req.params.id).single();
    if (!course) return res.status(404).json({ error: 'Course not found' });

    await supabaseAdmin.from('course_progress').upsert({
      user_id:      req.user.id,
      course_id:    req.params.id,
      completed:    true,
      completed_at: new Date().toISOString()
    }, { onConflict: 'user_id,course_id' });

    // Check if Risk Mastery certificate should be issued
    const { data: allCourses } = await supabaseAdmin
      .from('courses').select('id').eq('category', 'risk_management').eq('is_published', true);
    const { data: userProgress } = await supabaseAdmin
      .from('course_progress').select('course_id').eq('user_id', req.user.id).eq('completed', true);

    const completedIds = new Set((userProgress || []).map(p => p.course_id));
    const allRiskDone  = (allCourses || []).every(c => completedIds.has(c.id));

    if (allRiskDone) {
      const { data: existing } = await supabaseAdmin
        .from('certificates').select('id')
        .eq('user_id', req.user.id).eq('type', 'risk_mastery').limit(1);
      if (!existing?.length) {
        await supabaseAdmin.from('certificates').insert({
          user_id: req.user.id, type: 'risk_mastery',
          title: 'Risk Management Mastery Certificate'
        });
      }
    }

    res.json({ completed: true, risk_mastery_earned: allRiskDone });
  } catch (err) { next(err); }
});

// ─── Seminars ─────────────────────────────────────────────────────
router.get('/seminars', authenticate, async (req, res, next) => {
  try {
    const { upcoming } = req.query;
    let query = supabaseAdmin
      .from('seminars')
      .select('id, title, description, scheduled_at, duration_mins, level, stream_url, replay_url')
      .eq('is_published', true)
      .order('scheduled_at');
    if (upcoming === 'true') query = query.gte('scheduled_at', new Date().toISOString());

    const { data: seminars } = await query;

    // Mark which ones user is registered for
    const { data: regs } = await supabaseAdmin
      .from('seminar_registrations')
      .select('seminar_id, attended')
      .eq('user_id', req.user.id);

    const regMap = {};
    (regs || []).forEach(r => { regMap[r.seminar_id] = r.attended; });

    res.json((seminars || []).map(s => ({
      ...s,
      registered: s.id in regMap,
      attended:   regMap[s.id] || false
    })));
  } catch (err) { next(err); }
});

router.post('/seminars/:id/register', authenticate, async (req, res, next) => {
  try {
    const { data: seminar } = await supabaseAdmin
      .from('seminars').select('id, title, scheduled_at').eq('id', req.params.id).single();
    if (!seminar) return res.status(404).json({ error: 'Seminar not found' });

    await supabaseAdmin.from('seminar_registrations')
      .upsert({ seminar_id: req.params.id, user_id: req.user.id },
               { onConflict: 'seminar_id,user_id' });

    res.json({ registered: true, seminar });
  } catch (err) { next(err); }
});

// ─── Certificates ─────────────────────────────────────────────────
router.get('/certificates', authenticate, async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin
      .from('certificates')
      .select('*')
      .eq('user_id', req.user.id)
      .order('issued_at', { ascending: false });
    res.json(data || []);
  } catch (err) { next(err); }
});

// ─── Verify a certificate (public endpoint) ───────────────────────
router.get('/verify/:code', async (req, res, next) => {
  try {
    const { data } = await supabaseAdmin
      .from('certificates')
      .select('*, users(full_name)')
      .eq('verification_code', req.params.code.toUpperCase())
      .single();

    if (!data) return res.status(404).json({ valid: false, error: 'Certificate not found' });

    res.json({
      valid: true,
      holder:    data.users?.full_name,
      title:     data.title,
      type:      data.type,
      issued_at: data.issued_at
    });
  } catch (err) { next(err); }
});

// ─── Admin: create course ────────────────────────────────────────
router.post('/courses', authenticate, requireRole('education_admin'),
  [
    body('title').trim().notEmpty(),
    body('category').trim().notEmpty(),
    body('level').isIn(['beginner','intermediate','advanced'])
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { data } = await supabaseAdmin.from('courses')
        .insert({ ...req.body }).select().single();
      res.status(201).json(data);
    } catch (err) { next(err); }
  }
);

// ─── Admin: create seminar ────────────────────────────────────────
router.post('/seminars', authenticate, requireRole('education_admin'),
  [body('title').trim().notEmpty(), body('scheduled_at').isISO8601()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { data } = await supabaseAdmin.from('seminars')
        .insert({ ...req.body }).select().single();
      res.status(201).json(data);
    } catch (err) { next(err); }
  }
);

module.exports = router;
