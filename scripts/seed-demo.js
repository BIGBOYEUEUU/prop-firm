/**
 * TRD-WISE Demo Seed Script
 * ─────────────────────────
 * Run once after deploying to populate the DB with demo accounts and data.
 *
 * Usage:
 *   node scripts/seed-demo.js
 *
 * Creates:
 *   - admin@trdwise.co.ke  / Admin1234!   (super_admin)
 *   - trader@trdwise.co.ke / Trader1234!  (trader, with active Ascend evaluation)
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { supabaseAdmin } = require('../src/config/supabase');
const { activateEvaluation } = require('../src/engine/evaluationEngine');

async function seed() {
  console.log('🌱 Seeding demo data...\n');

  // ── 1. Admin account ────────────────────────────────────────────
  const adminHash = await bcrypt.hash('Admin1234!', 12);
  const { data: admin, error: adminErr } = await supabaseAdmin
    .from('users')
    .upsert({
      email:         'admin@trdwise.co.ke',
      password_hash: adminHash,
      full_name:     'Metro Admin',
      phone:         '+254700000001',
      role:          'super_admin'
    }, { onConflict: 'email' })
    .select()
    .single();

  if (adminErr) { console.error('Admin error:', adminErr.message); }
  else console.log(`✓ Admin created: admin@trdwise.co.ke / Admin1234!  (id: ${admin.id})`);

  // ── 2. Trader account ────────────────────────────────────────────
  const traderHash = await bcrypt.hash('Trader1234!', 12);
  const { data: trader, error: traderErr } = await supabaseAdmin
    .from('users')
    .upsert({
      email:                'trader@trdwise.co.ke',
      password_hash:        traderHash,
      full_name:            'Metro Trader',
      phone:                '+254700000002',
      role:                 'trader',
      university_email:     'trader@uonbi.ac.ke',
      university_verified:  true,
      university_domain:    'uonbi.ac.ke'
    }, { onConflict: 'email' })
    .select()
    .single();

  if (traderErr) { console.error('Trader error:', traderErr.message); process.exit(1); }
  console.log(`✓ Trader created: trader@trdwise.co.ke / Trader1234!  (id: ${trader.id})`);

  // ── 3. Active Ascend evaluation for trader ───────────────────────
  const { data: tier } = await supabaseAdmin
    .from('tier_config').select('*').eq('tier_key', 'ascend').single();

  const { data: ev, error: evErr } = await supabaseAdmin
    .from('evaluations')
    .insert({
      user_id:              trader.id,
      tier_key:             'ascend',
      phase:                1,
      status:               'pending_payment',
      initial_balance:      tier.account_size_usd,
      current_balance:      tier.account_size_usd,
      peak_equity:          tier.account_size_usd,
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

  if (evErr) { console.error('Evaluation error:', evErr.message); }
  else {
    // Auto-activate (simulating a demo payment)
    await activateEvaluation(ev.id);
    console.log(`✓ Ascend evaluation created & activated (id: ${ev.id})`);

    // ── 4. Seed some closed trades ─────────────────────────────────
    const trades = [
      { instrument: 'EUR/USD', direction: 'BUY',  lot_size: 1.0,  entry: 1.0820, exit: 1.0895, pnl:  750.00, daysAgo: 12 },
      { instrument: 'GBP/USD', direction: 'SELL', lot_size: 0.5,  entry: 1.2710, exit: 1.2650, pnl:  300.00, daysAgo: 11 },
      { instrument: 'XAU/USD', direction: 'BUY',  lot_size: 0.2,  entry: 2310.0, exit: 2340.0, pnl:  600.00, daysAgo: 10 },
      { instrument: 'USD/JPY', direction: 'SELL', lot_size: 1.0,  entry: 150.80, exit: 151.20, pnl: -400.00, daysAgo: 9  },
      { instrument: 'NAS100',  direction: 'BUY',  lot_size: 0.1,  entry: 18050,  exit: 18210,  pnl:  160.00, daysAgo: 8  },
      { instrument: 'EUR/USD', direction: 'BUY',  lot_size: 1.5,  entry: 1.0855, exit: 1.0910, pnl:  825.00, daysAgo: 7  },
      { instrument: 'GBP/JPY', direction: 'SELL', lot_size: 0.5,  entry: 191.20, exit: 191.80, pnl: -300.00, daysAgo: 6  },
      { instrument: 'XAU/USD', direction: 'BUY',  lot_size: 0.3,  entry: 2330.0, exit: 2365.0, pnl: 1050.00, daysAgo: 5  },
      { instrument: 'EUR/USD', direction: 'SELL', lot_size: 2.0,  entry: 1.0900, exit: 1.0840, pnl: 1200.00, daysAgo: 4  },
      { instrument: 'USD/KES', direction: 'BUY',  lot_size: 1.0,  entry: 129.20, exit: 129.60, pnl:  400.00, daysAgo: 3  },
    ];

    for (const t of trades) {
      const openedAt  = new Date(Date.now() - t.daysAgo * 86400000 - 3600000);
      const closedAt  = new Date(openedAt.getTime() + 2 * 3600000);
      const eatDay    = new Date(openedAt.getTime() + 3 * 3600000).toISOString().split('T')[0];

      await supabaseAdmin.from('trades').insert({
        evaluation_id: ev.id,
        user_id:       trader.id,
        instrument:    t.instrument,
        direction:     t.direction,
        lot_size:      t.lot_size,
        entry_price:   t.entry,
        exit_price:    t.exit,
        pnl:           t.pnl,
        status:        'closed',
        opened_at:     openedAt.toISOString(),
        closed_at:     closedAt.toISOString(),
        trading_day:   eatDay
      });
    }
    console.log(`✓ Seeded ${trades.length} demo trades`);

    // Update balances
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const newBalance = tier.account_size_usd + totalPnL;
    await supabaseAdmin.from('evaluations').update({
      current_balance:      newBalance,
      peak_equity:          newBalance,
      current_profit_pct:   (totalPnL / tier.account_size_usd) * 100,
      trading_days_count:   10,
      current_daily_dd:     1.4,
      current_overall_dd:   2.1
    }).eq('id', ev.id);
    console.log(`✓ Updated evaluation balance: $${newBalance.toLocaleString()} (+$${totalPnL})`);
  }

  // ── 5. Demo competition ──────────────────────────────────────────
  const month = new Date().toISOString().slice(0, 7);
  await supabaseAdmin
    .from('arena_competitions')
    .upsert({
      month,
      title:     `${month} University Trading Championship`,
      starts_at: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      ends_at:   new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
      status:    'active'
    }, { onConflict: 'month' });
  console.log(`✓ Arena competition created for ${month}`);

  // ── 6. Demo seminar ──────────────────────────────────────────────
  const seminarDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000); // 4 days from now
  const { data: existingSem } = await supabaseAdmin
    .from('seminars').select('id').limit(1);
  if (!existingSem?.length) {
    await supabaseAdmin.from('seminars').insert({
      title:        'Risk Management in Practice',
      description:  'A deep dive into drawdown management, position sizing, and the psychology of loss. Certificate on completion.',
      scheduled_at: seminarDate.toISOString(),
      duration_mins: 90,
      level:        'intermediate',
      is_published: true
    });
    console.log(`✓ Demo seminar scheduled for ${seminarDate.toDateString()}`);
  }

  // ── 7. Demo courses ──────────────────────────────────────────────
  const { data: existingCourses } = await supabaseAdmin
    .from('courses').select('id').limit(1);
  if (!existingCourses?.length) {
    await supabaseAdmin.from('courses').insert([
      { title: 'Introduction to Prop Trading',   category: 'foundations',      level: 'beginner',     duration_mins: 45,  is_published: true, display_order: 1 },
      { title: 'Understanding Drawdown',          category: 'risk_management',  level: 'beginner',     duration_mins: 30,  is_published: true, display_order: 2 },
      { title: 'Daily DD Modes Explained',        category: 'risk_management',  level: 'intermediate', duration_mins: 25,  is_published: true, display_order: 3 },
      { title: 'Position Sizing for Evaluation',  category: 'risk_management',  level: 'intermediate', duration_mins: 40,  is_published: true, display_order: 4 },
      { title: 'Reading Market Structure',        category: 'strategy',          level: 'intermediate', duration_mins: 60,  is_published: true, display_order: 5 },
      { title: 'MT5 Platform Mastery',            category: 'platform',          level: 'beginner',     duration_mins: 35,  is_published: true, display_order: 6 },
    ]);
    console.log('✓ Demo courses created');
  }

  console.log('\n✅ Demo seed complete!\n');
  console.log('─────────────────────────────────────────');
  console.log('Login credentials:');
  console.log('  Admin:  admin@trdwise.co.ke  / Admin1234!');
  console.log('  Trader: trader@trdwise.co.ke / Trader1234!');
  console.log('─────────────────────────────────────────\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
