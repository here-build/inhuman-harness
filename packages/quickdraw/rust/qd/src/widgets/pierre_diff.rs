//! PierreDiff widget rendering line-numbered syntax-highlighted unified diffs.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;

use crate::pierre::{parse_patch_files, ChangeKind, Hunk, HunkBlock, PatchFileMeta};

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

    pub fn from_old_new(path: &str, old: &str, new: &str, line_start: usize) -> Self {
        let old_lines: Vec<String> = if old.is_empty() {
            Vec::new()
        } else {
            old.lines().map(str::to_string).collect()
        };
        let new_lines: Vec<String> = if new.is_empty() {
            Vec::new()
        } else {
            new.lines().map(str::to_string).collect()
        };

        let mut prefix = 0usize;
        while prefix < old_lines.len()
            && prefix < new_lines.len()
            && old_lines[prefix] == new_lines[prefix]
        {
            prefix += 1;
        }
        let mut suffix = 0usize;
        while suffix < (old_lines.len().saturating_sub(prefix))
            && suffix < (new_lines.len().saturating_sub(prefix))
            && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
        {
            suffix += 1;
        }

        let mut blocks = Vec::new();
        if prefix > 0 {
            let start = prefix.saturating_sub(2);
            blocks.push(HunkBlock::Context {
                lines: old_lines[start..prefix].to_vec(),
            });
        }
        let del_end = old_lines.len().saturating_sub(suffix);
        let add_end = new_lines.len().saturating_sub(suffix);
        if prefix < del_end || prefix < add_end {
            blocks.push(HunkBlock::Change {
                deletions: old_lines[prefix..del_end].to_vec(),
                additions: new_lines[prefix..add_end].to_vec(),
            });
        }
        if suffix > 0 {
            let take = suffix.min(2);
            blocks.push(HunkBlock::Context {
                lines: old_lines[del_end..del_end + take].to_vec(),
            });
        }

        let start_no = (line_start.max(1) + prefix.saturating_sub(2)) as i64;
        let hunk = Hunk {
            deletion_start: start_no,
            deletion_count: old_lines.len() as i64,
            addition_start: start_no,
            addition_count: new_lines.len() as i64,
            collapsed_before: 0,
            blocks,
        };
        let file = PatchFileMeta {
            name: if path.is_empty() {
                "diff".to_string()
            } else {
                path.to_string()
            },
            prev_name: None,
            kind: ChangeKind::Change,
            hunks: vec![hunk],
        };

        Self {
            patch_text: String::new(),
            files: vec![file],
            show_line_numbers: true,
        }
    }

    pub fn show_line_numbers(mut self, show: bool) -> Self {
        self.show_line_numbers = show;
        self
    }

    pub fn height(&self) -> u16 {
        let mut rows = 0usize;
        for file in &self.files {
            rows += 1;
            for hunk in &file.hunks {
                rows += 1;
                for block in &hunk.blocks {
                    match block {
                        HunkBlock::Context { lines } => rows += lines.len(),
                        HunkBlock::Change {
                            deletions,
                            additions,
                        } => rows += deletions.len() + additions.len(),
                    }
                }
            }
        }
        rows as u16
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
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            );
            y += 1;

            for hunk in &file.hunks {
                if y >= area.bottom() {
                    break;
                }

                let hunk_hdr = format!(
                    "@@ -{},{} +{},{} @@",
                    hunk.deletion_start,
                    hunk.deletion_count,
                    hunk.addition_start,
                    hunk.addition_count
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
