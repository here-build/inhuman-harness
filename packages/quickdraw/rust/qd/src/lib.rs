//! Quickdraw's TUI runtime as a Rust process.
//!
//! The present tick is probe → theme → layout → paint → this grid → ANSI,
//! then input back up. This crate does not call the TypeScript runtime.
//! A module is added when its tests match `packages/quickdraw/src`.
//! `expand` builds markdown and diff nodes. Those variants expand in the
//! place walk only after [`layout_engine::set_realize`] (present installs it).
//! Until then they measure `0×0`. A chrome frame is [`layout_engine::Node::Chrome`];
//! [`layout_engine::Node::Skipped`] is a raw hole.
//! Highlighting is irosashi. `embed` splices a second language into a bash
//! command after the bash tokens exist.

pub mod birth;
mod buffer;
pub mod capabilities;
pub mod composer_command;
pub mod copy_toast;
pub mod decode;
mod draft;
pub mod drawers;
mod echo;
mod embed;
pub mod expand;
mod host_overlay;
pub mod layout_chrome;
pub mod layout_engine;
pub mod layout_flex;
pub mod layout_hit;
pub mod layout_text;
mod mailbox_scene;
mod measure;
pub mod paint_replica;
mod paint_widget;
mod pierre;
pub mod present;
mod present_dump;
mod selection_host;
pub mod stderr_hold;
pub mod syntax;
mod syntax_diff;
pub mod theme;

pub use buffer::{
    clone_buffer, create_buffer, dirty_rows, emit_ansi, emit_ansi_detailed, guard_content, put,
    Buffer, EmitAnsiOpts, EmitAnsiStats, Rgb, Style,
};
pub use measure::{
    display_width, display_width_ambiguous, grapheme_width, is_two_column_symbol, is_unit_width_run,
};
pub use present_dump::{dump, up_json, Dump, DumpError, DumpRun};
