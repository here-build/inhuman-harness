//! xterm 256 nearest match. Cube and gray only — system 0–15 are not candidates.

use super::ansi16::ansi16_to_rgb;
use super::lexicon::Rgb;

#[derive(Clone, Copy)]
struct Entry {
    index: u8,
    r: u8,
    g: u8,
    b: u8,
}

const fn build_palette() -> [Entry; 240] {
    let mut out = [Entry {
        index: 0,
        r: 0,
        g: 0,
        b: 0,
    }; 240];
    let levels: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let mut n = 0;
    let mut ri = 0;
    while ri < 6 {
        let mut gi = 0;
        while gi < 6 {
            let mut bi = 0;
            while bi < 6 {
                out[n] = Entry {
                    index: (16 + 36 * ri + 6 * gi + bi) as u8,
                    r: levels[ri],
                    g: levels[gi],
                    b: levels[bi],
                };
                n += 1;
                bi += 1;
            }
            gi += 1;
        }
        ri += 1;
    }
    let mut i = 0;
    while i < 24 {
        let v = (8 + i * 10) as u8;
        out[n] = Entry {
            index: (232 + i) as u8,
            r: v,
            g: v,
            b: v,
        };
        n += 1;
        i += 1;
    }
    assert!(n == 240);
    out
}

const PALETTE: [Entry; 240] = build_palette();

pub fn nearest_ansi256(r: u8, g: u8, b: u8) -> u8 {
    let mut best = 16u8;
    let mut best_d = i32::MAX;
    for p in PALETTE {
        let dr = i32::from(r) - i32::from(p.r);
        let dg = i32::from(g) - i32::from(p.g);
        let db = i32::from(b) - i32::from(p.b);
        let d = dr * dr + dg * dg + db * db;
        if d < best_d {
            best_d = d;
            best = p.index;
            if d == 0 {
                return best;
            }
        }
    }
    best
}

pub fn nearest_ansi256_from_rgb(rgb: Rgb) -> u8 {
    nearest_ansi256(rgb.r, rgb.g, rgb.b)
}

pub fn ansi256_to_rgb(index: u16) -> Rgb {
    let index = u8::try_from(index).expect("ansi256 index cannot overflow");
    if index < 16 {
        return ansi16_to_rgb(index);
    }
    if index < 232 {
        let n = index - 16;
        let levels = [0u8, 95, 135, 175, 215, 255];
        let ri = usize::from(n / 36);
        let gi = usize::from((n % 36) / 6);
        let bi = usize::from(n % 6);
        return Rgb {
            r: levels[ri],
            g: levels[gi],
            b: levels[bi],
        };
    }
    let v = 8 + (index - 232) * 10;
    Rgb { r: v, g: v, b: v }
}
