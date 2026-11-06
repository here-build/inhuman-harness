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

mod embed;
pub mod syntax;
pub mod wasm;

#[cfg(not(target_arch = "wasm32"))]
pub mod birth;
#[cfg(not(target_arch = "wasm32"))]
pub mod bridge;
#[cfg(not(target_arch = "wasm32"))]
mod buffer;
#[cfg(not(target_arch = "wasm32"))]
pub mod capabilities;
#[cfg(not(target_arch = "wasm32"))]
pub mod composer_command;
#[cfg(not(target_arch = "wasm32"))]
pub mod copy_toast;
#[cfg(not(target_arch = "wasm32"))]
pub mod decode;
#[cfg(not(target_arch = "wasm32"))]
mod draft;
#[cfg(not(target_arch = "wasm32"))]
pub mod drawers;
#[cfg(not(target_arch = "wasm32"))]
mod echo;
#[cfg(not(target_arch = "wasm32"))]
pub mod expand;
#[cfg(not(target_arch = "wasm32"))]
mod host_overlay;
#[cfg(not(target_arch = "wasm32"))]
pub mod layout_chrome;
#[cfg(not(target_arch = "wasm32"))]
pub mod layout_engine;
#[cfg(not(target_arch = "wasm32"))]
pub mod layout_flex;
#[cfg(not(target_arch = "wasm32"))]
pub mod layout_hit;
#[cfg(not(target_arch = "wasm32"))]
pub mod layout_text;
#[cfg(not(target_arch = "wasm32"))]
mod mailbox_scene;
#[cfg(not(target_arch = "wasm32"))]
mod measure;
#[cfg(not(target_arch = "wasm32"))]
pub mod paint_replica;
#[cfg(not(target_arch = "wasm32"))]
mod paint_widget;
#[cfg(not(target_arch = "wasm32"))]
mod pierre;
#[cfg(not(target_arch = "wasm32"))]
pub mod present;
#[cfg(not(target_arch = "wasm32"))]
mod present_dump;
#[cfg(not(target_arch = "wasm32"))]
mod selection_host;
#[cfg(not(target_arch = "wasm32"))]
pub mod state;
#[cfg(not(target_arch = "wasm32"))]
pub mod stderr_hold;
#[cfg(not(target_arch = "wasm32"))]
mod syntax_diff;
#[cfg(not(target_arch = "wasm32"))]
pub mod theme;
#[cfg(not(target_arch = "wasm32"))]
pub mod widgets;

#[cfg(not(target_arch = "wasm32"))]
pub use buffer::{
    clone_buffer, create_buffer, dirty_rows, emit_ansi, emit_ansi_detailed, guard_content, put,
    Buffer, EmitAnsiOpts, EmitAnsiStats, Rgb, Style,
};
#[cfg(not(target_arch = "wasm32"))]
pub use measure::{
    display_width, display_width_ambiguous, grapheme_width, is_two_column_symbol, is_unit_width_run,
};
#[cfg(not(target_arch = "wasm32"))]
pub use present_dump::{dump, up_json, Dump, DumpError, DumpRun};
