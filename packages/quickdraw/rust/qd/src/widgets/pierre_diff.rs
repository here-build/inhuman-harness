//! PierreDiff widget rendering line-numbered syntax-highlighted unified diffs.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;

use crate::pierre::{parse_patch_files, HunkBlock, PatchFileMeta};

#[derive(Debug, Clone)]
pub struct PierreDiffWidget {
    pub patch_text: String,
    pub(crate) files: Vec<PatchFileMeta>,
    pub show_line_numbers: bool,
}

impl PierreDiffWidget {
    pub fn new(patch_text: impl Into<String>) -> Self {
        let text = patch_text.into();
        let files = parse_patch_files(&text);
        Self {
            patch_text: text,
            files,
            show_line_numbers: true,
        }
    }

    pub fn show_line_numbers(mut self, show: bool) -> Self {
        self.show_line_numbers = show;
        self
    }
}

impl Widget for PierreDiffWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        let mut y = area.top();

        for file in &self.files {
            if y >= area.bottom() {
                break;
            }

            let header = format!("diff: {}", file.name);
            buf.set_stringn(
                area.left(),
                y,
                header,
                area.width as usize,
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            );
            y += 1;

            for hunk in &file.hunks {
                if y >= area.bottom() {
                    break;
                }

                let hunk_hdr = format!(
                    "@@ -{},{} +{},{} @@",
                    hunk.deletion_start, hunk.deletion_count, hunk.addition_start, hunk.addition_count
                );
                buf.set_stringn(
                    area.left(),
                    y,
                    hunk_hdr,
                    area.width as usize,
                    Style::default().fg(Color::Cyan),
                );
                y += 1;

                let mut old_num = hunk.deletion_start;
                let mut new_num = hunk.addition_start;

                for block in &hunk.blocks {
                    if y >= area.bottom() {
                        break;
                    }
                    match block {
                        HunkBlock::Context { lines } => {
                            for line in lines {
                                if y >= area.bottom() {
                                    break;
                                }
                                let gutter = if self.show_line_numbers {
                                    format!("{:4} {:4}   ", old_num, new_num)
                                } else {
                                    "  ".to_string()
                                };
                                let spans = vec![
                                    Span::styled(gutter, Style::default().fg(Color::DarkGray)),
                                    Span::styled(line.as_str(), Style::default().fg(Color::Gray)),
                                ];
                                buf.set_line(area.left(), y, &Line::from(spans), area.width);
                                old_num += 1;
                                new_num += 1;
                                y += 1;
                            }
                        }
                        HunkBlock::Change {
                            deletions,
                            additions,
                        } => {
                            for del in deletions {
                                if y >= area.bottom() {
                                    break;
                                }
                                let gutter = if self.show_line_numbers {
                                    format!("{:4}      - ", old_num)
                                } else {
                                    "- ".to_string()
                                };
                                let spans = vec![
                                    Span::styled(gutter, Style::default().fg(Color::Red)),
                                    Span::styled(
                                        del.as_str(),
                                        Style::default().fg(Color::LightRed),
                                    ),
                                ];
                                buf.set_line(area.left(), y, &Line::from(spans), area.width);
                                old_num += 1;
                                y += 1;
                            }
                            for add in additions {
                                if y >= area.bottom() {
                                    break;
                                }
                                let gutter = if self.show_line_numbers {
                                    format!("     {:4} + ", new_num)
                                } else {
                                    "+ ".to_string()
                                };
                                let spans = vec![
                                    Span::styled(gutter, Style::default().fg(Color::Green)),
                                    Span::styled(
                                        add.as_str(),
                                        Style::default().fg(Color::LightGreen),
                                    ),
                                ];
                                buf.set_line(area.left(), y, &Line::from(spans), area.width);
                                new_num += 1;
                                y += 1;
                            }
                        }
                    }
                }
            }
        }
    }
}
