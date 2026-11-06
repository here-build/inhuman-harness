use ratatui::prelude::*;

#[test]
fn test_layout_split() {
    let area = Rect::new(0, 0, 100, 50);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(5), Constraint::Fill(1)])
        .split(area);

    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0], Rect::new(0, 0, 100, 5));
    assert_eq!(chunks[1], Rect::new(0, 5, 100, 45));
}

#[test]
fn test_buffer_set_string() {
    let area = Rect::new(0, 0, 20, 2);
    let mut buf = Buffer::empty(area);
    buf.set_string(0, 0, "Hello World", Style::default().bold());

    assert_eq!(buf.get(0, 0).symbol(), "H");
    assert_eq!(buf.get(4, 0).symbol(), "o");
    assert_eq!(buf.get(5, 0).symbol(), " ");
    assert_eq!(buf.get(6, 0).symbol(), "W");
    assert!(buf.get(0, 0).modifier.contains(Modifier::BOLD));
}

#[test]
fn test_block_and_paragraph() {
    let area = Rect::new(0, 0, 30, 5);
    let mut buf = Buffer::empty(area);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title("Test");
    let para = Paragraph::new("Hello in Block").block(block);
    para.render(area, &mut buf);

    assert_eq!(buf.get(0, 0).symbol(), "╭");
    assert_eq!(buf.get(area.width - 1, 0).symbol(), "╮");
    assert_eq!(buf.get(1, 0).symbol(), "T");
    assert_eq!(buf.get(1, 1).symbol(), "H");
}
