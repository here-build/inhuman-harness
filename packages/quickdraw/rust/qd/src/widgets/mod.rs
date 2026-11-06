//! Native ratatui widgets for the quickdraw TUI runtime.

pub mod agents_meter;
pub mod composer;
pub mod drawer;
pub mod pierre_diff;
pub mod speech;
pub mod statusline;
pub mod tape;
pub mod toast;
pub mod work_cell;

pub use agents_meter::{AgentsMeterWidget, SubagentStatus};
pub use composer::{AskPromptState, ComposerState, ComposerWidget};
pub use drawer::{DrawerItem, DrawerKind, DrawerState, DrawerWidget};
pub use pierre_diff::PierreDiffWidget;
pub use speech::{RecallBlock, SpeechRole, SpeechWidget, ThinkingBlock};
pub use statusline::StatuslineWidget;
pub use tape::{TapeRole, TapeState, TapeTurnItem, TapeWidget};
pub use toast::{ToastKind, ToastPlacement, ToastWidget};
pub use work_cell::{WorkCellKind, WorkCellState, WorkCellStatus, WorkCellWidget};
