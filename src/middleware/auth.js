const jwt             = require('jsonwebtoken');
const { supabaseAdmin } = require('../config/supabase');

// ─── Verify JWT and attach user ──────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Fetch fresh user from DB
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role, is_active, university_verified')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) return res.status(401).json({ error: 'User not found' });
    if (!user.is_active) return res.status(403).json({ error: 'Account suspended' });

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

// ─── Role-based access ───────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  const allowed = ['super_admin', ...roles];
  if (!allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

const requireAdmin = requireRole(
  'risk_admin','education_admin','payments_admin',
  'university_admin','support_admin'
);

module.exports = { authenticate, requireRole, requireAdmin };
