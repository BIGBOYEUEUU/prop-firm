require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');

const logger        = require('./src/config/logger');
const { runDailyReset, runRuleChecks } = require('./src/jobs/ruleChecker');

// ─── Routes ─────────────────────────────────────────────────────
const authRoutes        = require('./src/routes/auth');
const evaluationRoutes  = require('./src/routes/evaluations');
const tradeRoutes       = require('./src/routes/trades');
const walletRoutes      = require('./src/routes/wallet');
const educationRoutes   = require('./src/routes/education');
const arenaRoutes       = require('./src/routes/arena');
const adminRoutes       = require('./src/routes/admin');
const supportRoutes     = require('./src/routes/support');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security middleware ─────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Global rate limiting ────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

// ─── Tighter limit on auth routes ───────────────────────────────
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 20,
  message: { error: 'Too many auth attempts, please try again later.' }
});
app.use('/api/auth', authLimiter);

// ─── Request logging ─────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// ─── Routes ─────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/trades',      tradeRoutes);
app.use('/api/wallet',      walletRoutes);
app.use('/api/education',   educationRoutes);
app.use('/api/arena',       arenaRoutes);
app.use('/api/admin',       adminRoutes);
app.use('/api/support',     supportRoutes);

// ─── Health check ────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), demo: process.env.DEMO_MODE === 'true' });
});

// ─── 404 ─────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global error handler ────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

// ─── Scheduled jobs ──────────────────────────────────────────────
// Daily reset at midnight EAT (UTC+3 = 21:00 UTC)
cron.schedule('0 21 * * *', async () => {
  logger.info('Running daily DD reset...');
  await runDailyReset();
}, { timezone: 'UTC' });

// Rule check every 5 minutes (catches open-position breaches)
cron.schedule('*/5 * * * *', async () => {
  await runRuleChecks();
});

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`TRD-WISE API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

module.exports = app;
