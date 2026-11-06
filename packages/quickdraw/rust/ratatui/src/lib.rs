pub mod buffer;
pub mod layout;
pub mod style;
pub mod text;
pub mod widgets;

pub mod prelude {
    pub use crate::buffer::{Cell, Buffer};
    pub use crate::layout::{
        Alignment, Constraint, Direction, Layout, Margin, Position, Rect, Size,
    };
    pub use crate::style::{Color, Modifier, Style, Stylize};
    pub use crate::text::{Line, Span, Text};
    pub use crate::widgets::{
        Block, BorderType, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation,
        ScrollbarState, StatefulWidget, Widget, Wrap,
    };
}
