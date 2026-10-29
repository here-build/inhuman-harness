//! Same fixtures as `scripts/text-hot-bench.mjs`. ASCII uses a unit-width
//! scan, matching quickdraw's `isUnitWidthRun` fast path. Anything else sums
//! `unicode-width` and forces U+23CE to two columns.

use std::time::Instant;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const WIDTH: usize = 98;

fn is_unit_width_run(text: &str) -> bool {
    text.chars().all(|c| {
        let c = c as u32;
        (0x20..=0x7e).contains(&c) || (0x2500..=0x259f).contains(&c)
    })
}

fn display_width(text: &str) -> usize {
    if is_unit_width_run(text) {
        return text.chars().count();
    }
    let mut width = UnicodeWidthStr::width(text);
    for cluster in text.graphemes(true) {
        if cluster == "\u{23ce}" {
            let native = UnicodeWidthStr::width(cluster);
            if native < 2 {
                width += 2 - native;
            }
        }
    }
    width
}

fn wrap_pre(content: &str, width: usize) -> Vec<String> {
    let mut out = Vec::new();
    for hard in content.split('\n') {
        if hard.is_empty() {
            out.push(String::new());
            continue;
        }
        if is_unit_width_run(hard) {
            let chars: Vec<char> = hard.chars().collect();
            if chars.len() <= width {
                out.push(hard.to_string());
                continue;
            }
            let mut start = 0;
            while start < chars.len() {
                let end = (start + width).min(chars.len());
                let mut cut = end;
                if end < chars.len() {
                    if let Some(rel) = chars[start..end].iter().rposition(|c| *c == ' ') {
                        if rel > 0 {
                            cut = start + rel;
                        }
                    }
                }
                out.push(chars[start..cut].iter().collect());
                start = if cut < chars.len() && chars[cut] == ' ' {
                    cut + 1
                } else {
                    cut
                };
            }
            continue;
        }
        let mut rest = hard;
        while !rest.is_empty() {
            if display_width(rest) <= width {
                out.push(rest.to_string());
                break;
            }
            let mut used = 0;
            let mut end = 0;
            let mut last_space = None;
            for (byte, cluster) in rest.grapheme_indices(true) {
                let w = display_width(cluster);
                if used + w > width {
                    break;
                }
                used += w;
                end = byte + cluster.len();
                if cluster == " " {
                    last_space = Some(end);
                }
            }
            if end == 0 {
                let cluster = rest.graphemes(true).next().unwrap_or("");
                out.push(cluster.to_string());
                rest = &rest[cluster.len()..];
                continue;
            }
            let cut = last_space.filter(|at| *at > 0 && *at < end).unwrap_or(end);
            out.push(rest[..cut].trim_end_matches(' ').to_string());
            rest = rest[cut..].trim_start_matches(' ');
        }
    }
    out
}

fn shell_blob() -> String {
    (0..4000)
        .map(|i| format!("line {i} {}", "x".repeat(70)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn wide_blob() -> String {
    let line = "测量宽度😀⏎ and a CJK run 宽".repeat(40);
    (0..200).map(|_| line.clone()).collect::<Vec<_>>().join("\n")
}

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    samples[samples.len() / 2]
}

fn time<T: std::fmt::Display>(label: &str, mut body: impl FnMut() -> T) {
    let mut samples = Vec::with_capacity(7);
    let mut keep = None;
    for _ in 0..7 {
        let start = Instant::now();
        keep = Some(body());
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let first = samples[0];
    let steady = median(samples[1..].to_vec());
    let n = match &keep {
        Some(v) => format!("{v}"),
        None => "-".to_string(),
    };
    println!("{label:<28} first {first:7.2}ms  steady {steady:7.2}ms  {n}");
}

fn main() {
    let shell = shell_blob();
    let wide = wide_blob();
    println!("rust text-hot  width {WIDTH}");
    time("shell width", || {
        let w: usize = shell.split('\n').map(display_width).sum();
        format!("cols {w}")
    });
    time("shell wrap", || {
        let lines = wrap_pre(&shell, WIDTH);
        format!("lines {}", lines.len())
    });
    time("wide width", || {
        let w: usize = wide.split('\n').map(display_width).sum();
        format!("cols {w}")
    });
    time("wide wrap", || {
        let lines = wrap_pre(&wide, WIDTH);
        format!("lines {}", lines.len())
    });
}
