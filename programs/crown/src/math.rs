//! Integer-only price math. All fractions are Q32 fixed point (`ONE` = 1.0).
//!
//! `packages/sdk/src/math.ts` mirrors this file line for line with BigInt, so the
//! UI and the tests compute exactly the same numbers. Change both together.

pub const ONE: u128 = 1 << 32;
/// ln(2) in Q32.
pub const LN2: u128 = 2_977_044_472;
pub const BPS: u128 = 10_000;

/// e^(-y) for y >= 0, both in Q32.
pub fn exp_neg(y: u128) -> u128 {
    let halvings = y / LN2;
    if halvings >= 64 {
        return 0;
    }
    // r < ln 2, so the alternating Taylor series converges fast.
    let r = y % LN2;
    let mut sum = ONE as i128;
    let mut term = ONE;
    let mut n: u128 = 1;
    while n <= 24 {
        term = term * r / ONE / n;
        if term == 0 {
            break;
        }
        if n % 2 == 1 {
            sum -= term as i128;
        } else {
            sum += term as i128;
        }
        n += 1;
    }
    (sum.max(0) as u128) >> halvings
}

/// -ln(1 - x) for 0 <= x <= 0.5, both in Q32.
pub fn neg_ln_one_minus(x: u128) -> u128 {
    let x = x.min(ONE / 2);
    let mut sum = 0u128;
    let mut pow = ONE;
    let mut k: u128 = 1;
    while k <= 64 {
        pow = pow * x / ONE;
        if pow == 0 {
            break;
        }
        sum += pow / k;
        k += 1;
    }
    sum
}

/// 2^(-dt / half_life) in Q32.
pub fn pow2_neg(dt_secs: u64, half_life_secs: u64) -> u128 {
    exp_neg(LN2 * dt_secs as u128 / half_life_secs.max(1) as u128)
}

/// (1 - melt_bps/10000)^(secs/60) in Q32: the fraction of the price left after
/// `secs` seconds of melting at `melt_bps` per minute.
pub fn decay(melt_bps: u16, secs: u64) -> u128 {
    let per_min = neg_ln_one_minus(melt_bps as u128 * ONE / BPS);
    // Clamp so the product cannot overflow; e^-y is 0 long before this.
    exp_neg(per_min.saturating_mul(secs.min(1 << 40) as u128) / 60)
}

/// One EMA step toward `inst_rate` after `dt_secs`.
pub fn ema_step(ema: u64, inst_rate: u64, dt_secs: u64, half_life_secs: u64) -> u64 {
    let alpha = ONE - pow2_neg(dt_secs, half_life_secs);
    if inst_rate >= ema {
        ema + ((inst_rate - ema) as u128 * alpha / ONE) as u64
    } else {
        ema - ((ema - inst_rate) as u128 * alpha / ONE) as u64
    }
}

/// Lamports per minute for `lamports` received over `dt_secs`.
pub fn inst_rate(lamports: u64, dt_secs: u64) -> u64 {
    let r = lamports as u128 * 60 / dt_secs.max(1) as u128;
    r.min(u64::MAX as u128) as u64
}

/// Volume-linked melt, bps per minute. Piecewise linear in fast/slow through
/// (0.8, max), (1.0, base), (1.2, min), clamped outside.
pub fn melt_bps(fast_ema: u64, slow_ema: u64, min: u16, base: u16, max: u16) -> u16 {
    let ratio = fast_ema as u128 * BPS / slow_ema.max(1) as u128;
    let (min, base, max) = (min as u128, base as u128, max as u128);
    let m = if ratio <= 8_000 {
        max
    } else if ratio <= 10_000 {
        max - (max - base) * (ratio - 8_000) / 2_000
    } else if ratio < 12_000 {
        base - (base - min) * (ratio - 10_000) / 2_000
    } else {
        min
    };
    m as u16
}

/// Floor: `floor_minutes` of fee income, never below `min_price`.
pub fn floor_price(fast_ema: u64, floor_minutes: u16, min_price: u64) -> u64 {
    let f = fast_ema as u128 * floor_minutes as u128;
    (f.min(u64::MAX as u128) as u64).max(min_price)
}

/// Floor during a reign: `floor_price`, but the fee part may not exceed
/// `cap_bps` of the reign's opening price. A king can pump fee income for free
/// (SOL sent to the vault comes back to them at the next sync), so an uncapped
/// floor would let them hold the price up forever.
pub fn capped_floor(fast_ema: u64, floor_minutes: u16, min_price: u64, reign_price: u64, cap_bps: u16) -> u64 {
    let fee = (fast_ema as u128 * floor_minutes as u128).min(u64::MAX as u128) as u64;
    fee.min(bps_of(reign_price, cap_bps as u32)).max(min_price)
}

/// Current price from a checkpoint.
pub fn price_now(checkpoint_price: u64, melt_bps: u16, secs: u64, floor: u64) -> u64 {
    let melted = (checkpoint_price as u128 * decay(melt_bps, secs) / ONE) as u64;
    melted.max(floor)
}

/// `amount * bps / 10000`, rounded down.
pub fn bps_of(amount: u64, bps: u32) -> u64 {
    (amount as u128 * bps as u128 / BPS).min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: u128, b: f64, tol: f64) -> bool {
        (a as f64 / ONE as f64 - b).abs() < tol
    }

    #[test]
    fn exp_matches_float() {
        for y in [0.0, 0.001, 0.3, 0.6931, 1.0, 2.5, 10.0, 30.0] {
            let q = (y * ONE as f64) as u128;
            assert!(close(exp_neg(q), (-y as f64).exp(), 1e-8), "y={y}");
        }
        assert_eq!(exp_neg(ONE * 100), 0);
    }

    #[test]
    fn ln_matches_float() {
        for x in [0.0, 0.02, 0.04, 0.08, 0.25, 0.5] {
            let q = (x * ONE as f64) as u128;
            assert!(close(neg_ln_one_minus(q), -(1.0 - x as f64).ln(), 1e-8), "x={x}");
        }
    }

    #[test]
    fn decay_is_compound_per_minute() {
        // 4%/min for 5 minutes = 0.96^5
        assert!(close(decay(400, 300), 0.96f64.powi(5), 1e-8));
        // half a minute at 8%/min = sqrt(0.92)
        assert!(close(decay(800, 30), 0.92f64.sqrt(), 1e-8));
        assert_eq!(decay(400, 0), ONE);
        assert_eq!(decay(0, 1_000_000), ONE);
    }

    #[test]
    fn half_life() {
        assert!(close(pow2_neg(180, 180), 0.5, 1e-8));
        assert_eq!(ema_step(0, 1_000_000, 180, 180) / 10, 50_000);
        assert_eq!(ema_step(1_000_000, 0, 180, 180) / 10, 50_000);
    }

    #[test]
    fn melt_curve() {
        let m = |f, s| melt_bps(f, s, 200, 400, 800);
        assert_eq!(m(0, 0), 800);
        assert_eq!(m(79, 100), 800);
        assert_eq!(m(80, 100), 800);
        assert_eq!(m(90, 100), 600);
        assert_eq!(m(100, 100), 400);
        assert_eq!(m(110, 100), 300);
        assert_eq!(m(120, 100), 200);
        assert_eq!(m(500, 100), 200);
    }

    #[test]
    fn price_and_floor() {
        assert_eq!(floor_price(100, 10, 5), 1000);
        assert_eq!(floor_price(0, 10, 5), 5);
        assert_eq!(capped_floor(100, 10, 5, 4_000, 5_000), 1000);
        assert_eq!(capped_floor(1_000, 10, 5, 4_000, 5_000), 2000);
        assert_eq!(capped_floor(1_000, 10, 5, 4, 5_000), 5);
        assert_eq!(capped_floor(u64::MAX, 10, 5, u64::MAX, 10_000), u64::MAX);
        assert_eq!(price_now(1_000_000_000, 400, 0, 0), 1_000_000_000);
        assert_eq!(price_now(1_000_000_000, 400, 100_000, 7), 7);
        let p = price_now(1_000_000_000, 400, 60, 0);
        assert!((p as i64 - 960_000_000).abs() < 10, "{p}");
    }
}
