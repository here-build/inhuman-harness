use qd::copy_toast::{
    copy_toast_dismissed, copy_toast_phase, paint_copy_toast, place_copy_toast, CopyToastPhase,
    ToastNotice, ToastSide, COPY_TOAST_ARM_MS, COPY_TOAST_HOLD_MS, COPY_TOAST_TEXT,
};
use qd::create_buffer;
use qd::layout_chrome::CHROME_FRAME_CORNERS;
use qd::present::{cell_glyph, cell_style, Present, PresentOpts};
use qd::theme::FgP;

fn row_at(buf: &qd::Buffer, place_x: i64, place_y: i64, w: i64, dy: i64) -> String {
    let mut line = String::new();
    let y = usize::try_from(place_y + dy).unwrap_or(0);
    for dx in 0..w {
        let x = usize::try_from(place_x + dx).unwrap_or(0);
        line.push_str(cell_glyph(buf, x, y));
    }
    line
}

#[test]
fn copy_toast_is_one_line_and_clears_on_the_caller_clock() {
    let down = place_copy_toast(10, 2, 0, 40, 12, COPY_TOAST_TEXT);
    let up = place_copy_toast(10, 5, 8, 40, 12, COPY_TOAST_TEXT);
    let left = place_copy_toast(0, 2, 0, 40, 12, COPY_TOAST_TEXT);
    let last_row = place_copy_toast(10, 11, 8, 40, 12, COPY_TOAST_TEXT);
    let flip_up = place_copy_toast(10, 1, 5, 40, 12, COPY_TOAST_TEXT);
    assert_eq!(
        (down.x, down.y, down.w, down.h, down.side),
        (6, 3, 10, 3, ToastSide::Below)
    );
    assert_eq!((up.x, up.y, up.side), (6, 2, ToastSide::Above));
    assert_eq!((left.x, left.side), (0, ToastSide::Below));
    assert_eq!((last_row.y, last_row.side), (8, ToastSide::Above));
    assert_eq!((flip_up.y, flip_up.side), (2, ToastSide::Below));

    let mut buf = create_buffer(40, 12);
    paint_copy_toast(&mut buf, down, |style| style.clone(), COPY_TOAST_TEXT);
    let bar = "─".repeat(8);
    assert_eq!(
        row_at(&buf, down.x, down.y, down.w, 0),
        format!(
            "{}{bar}{}",
            CHROME_FRAME_CORNERS.tl, CHROME_FRAME_CORNERS.tr
        )
    );
    assert_eq!(
        row_at(&buf, down.x, down.y, down.w, 1),
        format!("│ {COPY_TOAST_TEXT} │")
    );
    assert_eq!(
        row_at(&buf, down.x, down.y, down.w, 2),
        format!(
            "{}{bar}{}",
            CHROME_FRAME_CORNERS.bl, CHROME_FRAME_CORNERS.br
        )
    );
    let rim = cell_style(
        &buf,
        usize::try_from(down.x).unwrap_or(0),
        usize::try_from(down.y).unwrap_or(0),
    );
    let ink = cell_style(
        &buf,
        usize::try_from(down.x + 2).unwrap_or(0),
        usize::try_from(down.y + 1).unwrap_or(0),
    );
    assert_eq!(rim.role.as_deref(), Some("foreground"));
    assert_eq!(rim.prominence, Some(FgP::GHOST));
    assert_eq!(ink.role.as_deref(), Some("foreground"));
    assert_eq!(ink.prominence, Some(FgP::PRIMARY));
    assert_eq!(
        cell_glyph(
            &buf,
            usize::try_from(down.x + 2).unwrap_or(0),
            usize::try_from(down.y + 1).unwrap_or(0)
        ),
        "C"
    );

    assert_eq!(
        copy_toast_phase(0, 0),
        CopyToastPhase::Shown { armed: false }
    );
    assert_eq!(
        copy_toast_phase(0, COPY_TOAST_ARM_MS - 1),
        CopyToastPhase::Shown { armed: false }
    );
    assert_eq!(
        copy_toast_phase(0, COPY_TOAST_ARM_MS),
        CopyToastPhase::Shown { armed: true }
    );
    assert_eq!(
        copy_toast_phase(0, COPY_TOAST_HOLD_MS - 1),
        CopyToastPhase::Shown { armed: true }
    );
    assert_eq!(
        copy_toast_phase(0, COPY_TOAST_HOLD_MS),
        CopyToastPhase::Clear
    );
    assert!(!copy_toast_dismissed(0, 1, ToastNotice::Input));
    assert!(copy_toast_dismissed(0, 1, ToastNotice::Press));
    assert!(copy_toast_dismissed(
        0,
        COPY_TOAST_ARM_MS,
        ToastNotice::Input
    ));

    let mut session = Present::boot(PresentOpts {
        cols: 40,
        rows: 12,
        ..PresentOpts::default()
    });
    session.note_copy(10, 2, 0, 0);
    assert!(session
        .content_rows()
        .iter()
        .any(|row| row.contains(COPY_TOAST_TEXT)));
    let cleared = session.paint_if_needed(COPY_TOAST_HOLD_MS);
    assert!(cleared.caused);
    assert!(session
        .content_rows()
        .iter()
        .all(|row| !row.contains(COPY_TOAST_TEXT)));
}
