//! Oracle tests for ratatui custom widgets and buffer bridge.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::{StatefulWidget, Widget};

use qd::bridge::{
    emit_ratatui_ansi, qd_to_ratatui_buffer, ratatui_to_qd_buffer, render_stateful_widget_to_qd,
    render_widget_to_qd,
};
use qd::create_buffer;
use qd::widgets::agents_meter::{AgentsMeterWidget, SubagentStatus};
use qd::widgets::composer::{AskPromptState, ComposerState, ComposerWidget};
use qd::widgets::drawer::{DrawerItem, DrawerKind, DrawerState, DrawerWidget};
use qd::widgets::pierre_diff::PierreDiffWidget;
use qd::widgets::speech::{RecallBlock, SpeechWidget, ThinkingBlock};
use qd::widgets::statusline::StatuslineWidget;
use qd::widgets::tape::{TapeRole, TapeState, TapeTurnItem, TapeWidget};
use qd::widgets::toast::{ToastPlacement, ToastWidget};
use qd::widgets::work_cell::{WorkCellKind, WorkCellState, WorkCellStatus, WorkCellWidget};

fn buffer_to_lines(buf: &Buffer) -> Vec<String> {
    let mut lines = Vec::new();
    for y in buf.area.top()..buf.area.bottom() {
        let mut line = String::new();
        for x in buf.area.left()..buf.area.right() {
            line.push_str(buf.get(x, y).symbol());
        }
        lines.push(line);
    }
    lines
}

#[test]
fn test_tape_widget_render_and_sticky_bottom() {
    let turns = vec![
        TapeTurnItem::new("t1", TapeRole::User, vec![Line::raw("hello")]),
        TapeTurnItem::new("t2", TapeRole::Assistant, vec![Line::raw("world")]),
    ];

    let widget = TapeWidget::new(turns);
    let mut state = TapeState::new();

    let area = Rect::new(0, 0, 40, 10);
    let mut buf = Buffer::empty(area);

    widget.render(area, &mut buf, &mut state);

    let rendered = buffer_to_lines(&buf);
    assert!(rendered.iter().any(|l| l.contains("User")));
    assert!(rendered.iter().any(|l| l.contains("hello")));
    assert!(rendered.iter().any(|l| l.contains("Assistant")));
    assert!(rendered.iter().any(|l| l.contains("world")));
    assert!(state.sticky_bottom);

    // Scroll up unpins sticky bottom
    state.scroll_up(2);
    assert!(!state.sticky_bottom);

    // Scroll to bottom repins sticky bottom
    state.scroll_to_bottom();
    assert!(state.sticky_bottom);
}

#[test]
fn test_speech_widget_with_thinking_and_recall() {
    let thinking = ThinkingBlock::new(vec!["analyzing problem".into()], 1200);
    let recall = RecallBlock::new("Auth flow", vec!["JWT".into(), "OAuth".into()]);

    let widget = SpeechWidget::assistant("Here is the answer.")
        .with_thinking(thinking)
        .with_recall(recall)
        .with_hotkey('r', "retry")
        .with_hotkey('c', "copy");

    let area = Rect::new(0, 0, 50, 8);
    let mut buf = Buffer::empty(area);
    widget.render(area, &mut buf);

    let rendered = buffer_to_lines(&buf);
    assert!(rendered.iter().any(|l| l.contains("Thought for 1.2s")));
    assert!(rendered.iter().any(|l| l.contains("analyzing problem")));
    assert!(rendered.iter().any(|l| l.contains("Recall: Auth flow")));
    assert!(rendered.iter().any(|l| l.contains("Here is the answer.")));
    assert!(rendered.iter().any(|l| l.contains("[r] retry")));
    assert!(rendered.iter().any(|l| l.contains("[c] copy")));
}

#[test]
fn test_work_cell_widget_quarter_block_rule_and_badges() {
    let widget = WorkCellWidget::new(
        "call_1",
        WorkCellKind::Tool,
        "write_file",
        WorkCellStatus::Success,
    )
    .with_input("src/lib.rs")
    .with_output_lines(vec!["wrote 42 bytes".into()]);

    let mut state = WorkCellState::new(); // expanded by default
    let area = Rect::new(0, 0, 50, 6);
    let mut buf = Buffer::empty(area);

    widget.render(area, &mut buf, &mut state);

    let rendered = buffer_to_lines(&buf);
    // Verified quarter-block rule ▌ and tool details
    assert!(rendered.iter().any(|l| l.contains("▌") && l.contains("write_file")));
    assert!(rendered.iter().any(|l| l.contains("done")));
    assert!(rendered.iter().any(|l| l.contains("src/lib.rs")));
    assert!(rendered.iter().any(|l| l.contains("wrote 42 bytes")));
}

#[test]
fn test_pierre_diff_widget_rendering() {
    let patch = "\
diff --git a/main.rs b/main.rs
--- a/main.rs
+++ b/main.rs
@@ -1,3 +1,3 @@
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
 }
";
    let widget = PierreDiffWidget::new(patch).show_line_numbers(true);
    let area = Rect::new(0, 0, 50, 8);
    let mut buf = Buffer::empty(area);
    widget.render(area, &mut buf);

    let rendered = buffer_to_lines(&buf);
    assert!(rendered.iter().any(|l| l.contains("diff: main.rs")));
    assert!(rendered.iter().any(|l| l.contains("@@ -1,3 +1,3 @@")));
    assert!(rendered.iter().any(|l| l.contains('-') && l.contains("println!(\"old\");")));
    assert!(rendered.iter().any(|l| l.contains('+') && l.contains("println!(\"new\");")));
}

#[test]
fn test_composer_widget_cursor_and_ask_cover() {
    let widget = ComposerWidget::new();
    let mut state = ComposerState::new();

    state.insert_char('h');
    state.insert_char('i');
    assert_eq!(state.text, "hi");
    assert_eq!(state.cursor, 2);

    let area = Rect::new(0, 0, 40, 4);
    let mut buf = Buffer::empty(area);
    widget.clone().render(area, &mut buf, &mut state);

    let rendered = buffer_to_lines(&buf);
    assert!(rendered.iter().any(|l| l.contains("❯ hi")));

    // When ask approval cover is set, it renders approval modal
    state.ask_approval_cover = Some(AskPromptState::new("Allow shell command?"));
    let mut ask_buf = Buffer::empty(area);
    widget.render(area, &mut ask_buf, &mut state);

    let ask_rendered = buffer_to_lines(&ask_buf);
    assert!(ask_rendered.iter().any(|l| l.contains("Action Approval Required")));
    assert!(ask_rendered.iter().any(|l| l.contains("Allow shell command?")));
    assert!(ask_rendered.iter().any(|l| l.contains("[y] Yes")));
}

#[test]
fn test_drawer_widget_selection_and_filter() {
    let items = vec![
        DrawerItem::new("c1", "Anthropic Claude").with_badge("active").active(true),
        DrawerItem::new("c2", "OpenAI GPT-4o").with_badge("configured"),
        DrawerItem::new("c3", "Local Ollama"),
    ];

    let widget = DrawerWidget::new(DrawerKind::Model, items).width(35);
    let mut state = DrawerState::new();

    let area = Rect::new(0, 0, 60, 10);
    let mut buf = Buffer::empty(area);
    widget.clone().render(area, &mut buf, &mut state);

    let rendered = buffer_to_lines(&buf);
    assert!(rendered.iter().any(|l| l.contains("Select Model")));
    assert!(rendered.iter().any(|l| l.contains("› Anthropic Claude")));
    assert!(rendered.iter().any(|l| l.contains("[active]")));

    // Filtering items
    state.filter_query = "ollama".to_string();
    let mut f_buf = Buffer::empty(area);
    widget.render(area, &mut f_buf, &mut state);
    let f_rendered = buffer_to_lines(&f_buf);
    assert!(f_rendered.iter().any(|l| l.contains("Local Ollama")));
    assert!(!f_rendered.iter().any(|l| l.contains("Claude")));
}

#[test]
fn test_statusline_widget() {
    let widget = StatuslineWidget::new()
        .cwd("~/projects/harness")
        .model("claude-3-5-sonnet")
        .permission_mode("auto")
        .quota("14.2k tokens")
        .spinner_phase(3);

    let area = Rect::new(0, 0, 80, 1);
    let mut buf = Buffer::empty(area);
    widget.render(area, &mut buf);

    let rendered = buffer_to_lines(&buf);
    assert_eq!(rendered.len(), 1);
    let line = &rendered[0];
    assert!(line.contains("~/projects/harness"));
    assert!(line.contains("claude-3-5-sonnet"));
    assert!(line.contains("[auto]"));
    assert!(line.contains("14.2k tokens"));
}

#[test]
fn test_agents_meter_widget() {
    let agents = vec![
        SubagentStatus::new("a1", "code-search").with_steps(5),
        SubagentStatus::new("a2", "linter").completed(),
    ];
    let widget = AgentsMeterWidget::new(agents);

    let area = Rect::new(0, 0, 60, 1);
    let mut buf = Buffer::empty(area);
    widget.render(area, &mut buf);

    let rendered = buffer_to_lines(&buf);
    let line = &rendered[0];
    assert!(line.contains("Subagents: 1/2 active"));
    assert!(line.contains("code-search: 5 steps"));
    assert!(line.contains("linter"));
}

#[test]
fn test_toast_widget() {
    let widget = ToastWidget::success("Copied to clipboard").placement(ToastPlacement::TopRight);

    let area = Rect::new(0, 0, 40, 6);
    let mut buf = Buffer::empty(area);
    widget.render(area, &mut buf);

    let rendered = buffer_to_lines(&buf);
    assert!(rendered.iter().any(|l| l.contains("✓ Copied to clipboard")));
}

#[test]
fn test_buffer_bridge_conversions() {
    let area = Rect::new(0, 0, 10, 2);
    let mut r_buf = Buffer::empty(area);
    r_buf.set_string(0, 0, "hello", ratatui::style::Style::default());

    // 1. ratatui_to_qd_buffer
    let qd_buf = ratatui_to_qd_buffer(&r_buf);
    assert_eq!(qd_buf.width(), 10);
    assert_eq!(qd_buf.height(), 2);
    assert_eq!(qd_buf.cells()[0].ch, "h");

    // 2. qd_to_ratatui_buffer round-trip
    let r_roundtrip = qd_to_ratatui_buffer(&qd_buf);
    assert_eq!(r_roundtrip.get(0, 0).symbol(), "h");
    assert_eq!(r_roundtrip.get(1, 0).symbol(), "e");

    // 3. render_widget_to_qd
    let mut direct_qd = create_buffer(20, 1);
    let status = StatuslineWidget::new().model("test-model");
    render_widget_to_qd(status, &mut direct_qd);
    let text: String = direct_qd.cells().iter().map(|c| c.ch.as_str()).collect();
    assert!(text.contains("test-model"));

    // 4. render_stateful_widget_to_qd
    let mut stateful_qd = create_buffer(30, 2);
    let cell_widget = WorkCellWidget::new("c1", WorkCellKind::Tool, "fetch", WorkCellStatus::Success);
    let mut cell_state = WorkCellState::new();
    render_stateful_widget_to_qd(cell_widget, &mut stateful_qd, &mut cell_state);
    let cell_text: String = stateful_qd.cells().iter().map(|c| c.ch.as_str()).collect();
    assert!(cell_text.contains("fetch"));

    // 5. emit_ratatui_ansi
    let stats = emit_ratatui_ansi(&r_buf, None, &Default::default());
    assert!(!stats.ansi.is_empty());
    assert!(stats.ansi.contains("hello"));
}
