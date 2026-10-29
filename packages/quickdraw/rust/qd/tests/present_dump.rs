use qd::dump;

fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn speech_mark(dump: &qd::Dump) -> (bool, bool, bool) {
    let mut secret_bright = false;
    let mut older_dim = false;
    let mut placeholder = false;
    for run in &dump.runs {
        if run.text.contains("SECRET-RECAP") && !run.dim && run.text.chars().count() > 1 {
            secret_bright = true;
        }
        if run.text.contains("OLDER") && !run.text.contains("SECRET-RECAP") && run.dim {
            older_dim = true;
        }
        if is_placeholder_run(&run.text) {
            placeholder = true;
        }
    }
    (secret_bright, older_dim, placeholder)
}

fn is_placeholder_run(text: &str) -> bool {
    if text.is_empty() || text == " " {
        return true;
    }
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) => qd::display_width(text) == 0 || ch == '\u{FFFD}',
        _ => false,
    }
}

#[test]
fn off_tip_recap_stays_bright_and_older_speech_dims() {
    let paint = r#"{"kind":"paint_init","epoch":"e","snapshot":{"kind":"root","children":[{"kind":"turn","children":[{"kind":"speech","voice":"user","text":"OLDER"}]},{"kind":"turn","children":[{"kind":"speech","voice":"user","text":"SECRET-RECAP","recap":true}]},{"kind":"rewind","atTip":false,"seatRim":false,"past":[{"key":"older","text":"OLDER"}]}]}}"#;
    let raw = format!(
        r#"{{"cols":80,"rows":24,"nowMs":1700000000000,"paint":{}}}"#,
        quote(paint)
    );
    let dump = dump(&raw).expect("dump");
    assert_eq!(speech_mark(&dump), (true, true, false));
}

#[test]
fn off_tip_recap_parks_above_the_tip() {
    let mut children = String::from(
        r#"{"kind":"turn","children":[{"kind":"speech","voice":"user","text":"PARK-RECAP","recap":true}]}"#,
    );
    for i in 0..8 {
        children.push(',');
        children.push_str(&format!(
            r#"{{"kind":"turn","children":[{{"kind":"speech","voice":"user","text":"FILL-{i}"}}]}}"#
        ));
    }
    children.push_str(
        r#",{"kind":"turn","children":[{"kind":"speech","voice":"user","text":"TIP-MARK"}]},{"kind":"rewind","atTip":false,"seatRim":false}"#,
    );
    let paint = format!(
        r#"{{"kind":"paint_init","epoch":"e","snapshot":{{"kind":"root","children":[{children}]}}}}"#
    );
    let raw = format!(
        r#"{{"cols":80,"rows":16,"nowMs":1700000000000,"paint":{}}}"#,
        quote(&paint)
    );
    let dump = dump(&raw).expect("dump");
    let parked = dump
        .runs
        .iter()
        .any(|run| run.text.contains("PARK-RECAP") && !run.dim);
    let tip = dump.runs.iter().any(|run| run.text.contains("TIP-MARK"));
    assert!(
        parked,
        "{:?}",
        dump.runs.iter().map(|run| &run.text).collect::<Vec<_>>()
    );
    assert!(!tip, "tip stayed in the window");
}
