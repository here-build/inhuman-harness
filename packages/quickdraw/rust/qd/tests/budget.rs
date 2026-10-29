//! Headless stand-in for "first write". A 100×40 frame of unit-width text
//! must emit in well under the startup budget. This is not the process
//! entry yet; it pins the grid so a later wave cannot make paint expensive.

use qd::{create_buffer, emit_ansi_detailed, put, EmitAnsiOpts, Style};
use std::time::Instant;

#[test]
#[ignore = "timing median flakes in the logic cup; run with --ignored"]
fn paint_100x40_stays_under_the_startup_budget() {
    let style = Style::default();
    let mut samples = Vec::with_capacity(7);
    for _ in 0..7 {
        let start = Instant::now();
        let mut buf = create_buffer(100, 40);
        for y in 0..40 {
            put(
                &mut buf,
                0,
                y,
                "the quick brown fox jumps over the lazy dog",
                &style,
            );
        }
        let stats = emit_ansi_detailed(None, &buf, &EmitAnsiOpts::default());
        assert!(stats.bytes > 0);
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples[samples.len() / 2];
    assert!(
        median < 15.0,
        "100×40 paint median {median:.2} ms exceeds the 15 ms startup budget"
    );
}
