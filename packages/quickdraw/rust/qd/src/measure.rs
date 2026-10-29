//! Display columns. ASCII and box drawing are one column per scalar.
//! U+23CE, U+24AA, and U+24B2 are two columns of ink with a real space mate, not a placeholder.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub fn is_unit_width_run(text: &str) -> bool {
    text.chars().all(|c| {
        let c = c as u32;
        (0x20..=0x7e).contains(&c) || (0x2500..=0x259f).contains(&c)
    })
}

pub fn is_two_column_symbol(cluster: &str) -> bool {
    let mut chars = cluster.chars();
    let Some(c) = chars.next() else {
        return false;
    };
    chars.next().is_none() && matches!(c, '\u{23ce}' | '\u{24aa}' | '\u{24b2}')
}

pub fn display_width(text: &str) -> usize {
    columns(text, false)
}

/// Column width. `None` and `Some(true)` are the narrow default.
/// `Some(false)` counts East Asian Ambiguous as wide.
pub fn display_width_ambiguous(text: &str, ambiguous_is_narrow: Option<bool>) -> usize {
    columns(text, ambiguous_is_narrow == Some(false))
}

fn columns(text: &str, ambiguous_wide: bool) -> usize {
    if is_unit_width_run(text) {
        return text.chars().count();
    }
    let mut width = if ambiguous_wide {
        UnicodeWidthStr::width_cjk(text)
    } else {
        UnicodeWidthStr::width(text)
    };
    for cluster in text.graphemes(true) {
        if is_two_column_symbol(cluster) {
            let native = if ambiguous_wide {
                UnicodeWidthStr::width_cjk(cluster)
            } else {
                UnicodeWidthStr::width(cluster)
            };
            if native < 2 {
                width += 2 - native;
            }
        }
    }
    width
}

pub fn grapheme_width(cluster: &str) -> usize {
    display_width(cluster)
}
