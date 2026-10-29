//! Terminal ground lightness. OSC 11 byte parsing stays in capabilities.

use super::salience::rgb_to_oklch;

pub fn ground_from_rgb(r: f64, g: f64, b: f64) -> f64 {
    rgb_to_oklch(r, g, b).l
}
