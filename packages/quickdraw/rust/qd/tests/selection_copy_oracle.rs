use qd::capabilities::{copy_selection, osc52_set, ClipboardSelect, CopyPayload, CopyWrite};

#[test]
fn osc52_writes_the_serialized_selection_text() {
    let text = "hllo world\n";
    assert_eq!(
        copy_selection(CopyPayload::Text(text)),
        CopyWrite::Osc(osc52_set(text, ClipboardSelect::Both))
    );
    assert_eq!(copy_selection(CopyPayload::Text("")), CopyWrite::Empty);
    assert_eq!(copy_selection(CopyPayload::Image), CopyWrite::UnportedImage);
}
