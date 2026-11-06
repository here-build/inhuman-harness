//! Quickdraw's TUI runtime as a Rust process.
//!
//! Highlighting is irosashi. `embed` splices a second language into a bash
//! command after the bash tokens exist.

mod embed;
pub mod syntax;
pub mod wasm;

#[cfg(not(target_arch = "wasm32"))]
pub mod bridge;
#[cfg(not(target_arch = "wasm32"))]
mod buffer;
#[cfg(not(target_arch = "wasm32"))]
pub mod capabilities;
#[cfg(not(target_arch = "wasm32"))]
pub mod composer_command;
#[cfg(not(target_arch = "wasm32"))]
pub mod decode;
#[cfg(not(target_arch = "wasm32"))]
mod draft;
#[cfg(not(target_arch = "wasm32"))]
mod measure;
#[cfg(not(target_arch = "wasm32"))]
pub mod paint_replica;
#[cfg(not(target_arch = "wasm32"))]
mod paint_widget;
#[cfg(not(target_arch = "wasm32"))]
mod pierre;
#[cfg(not(target_arch = "wasm32"))]
pub mod state;
#[cfg(not(target_arch = "wasm32"))]
pub mod stderr_hold;
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
