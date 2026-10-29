use qd::capabilities::{copy_selection, osc52_set, ClipboardSelect, CopyPayload, CopyWrite};
use qd::create_buffer;
use qd::layout_hit::{extend_selection, serialize_selection, start_selection, Granularity};
use qd::put;
use qd::Style;

#[test]
fn osc52_writes_the_serialized_selection_text() {
    let mut buf = create_buffer(20, 2);
    put(&mut buf, 0, 0, "hello world   ", &Style::default());
    put(&mut buf, 0, 1, "next", &Style::default());
    let sel = extend_selection(
        Some(start_selection(
            qd::layout_hit::Cell { col: 0, row: 0 },
            Granularity::Char,
            None,
            None,
        )),
        qd::layout_hit::Cell { col: 10, row: 0 },
    )
    .expect("extent");
    let text = serialize_selection(&buf, &sel, |col, _row| col == 1);
    assert_eq!(text, "hllo world\n");
    assert_eq!(
        copy_selection(CopyPayload::Text(&text)),
        CopyWrite::Osc(osc52_set(&text, ClipboardSelect::Both))
    );
    assert_eq!(copy_selection(CopyPayload::Text("")), CopyWrite::Empty);
    assert_eq!(copy_selection(CopyPayload::Image), CopyWrite::UnportedImage);

    let line = extend_selection(
        Some(start_selection(
            qd::layout_hit::Cell { col: 0, row: 0 },
            Granularity::Line,
            None,
            None,
        )),
        qd::layout_hit::Cell { col: 0, row: 1 },
    )
    .expect("lines");
    assert_eq!(
        serialize_selection(&buf, &line, |_, _| false),
        "hello world\nnext\n"
    );
}
