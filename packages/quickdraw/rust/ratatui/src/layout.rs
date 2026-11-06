use std::rc::Rc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Position {
    pub x: u16,
    pub y: u16,
}

impl Position {
    pub const fn new(x: u16, y: u16) -> Self {
        Self { x, y }
    }
}

impl From<(u16, u16)> for Position {
    fn from((x, y): (u16, u16)) -> Self {
        Self::new(x, y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Size {
    pub width: u16,
    pub height: u16,
}

impl Size {
    pub const fn new(width: u16, height: u16) -> Self {
        Self { width, height }
    }
}

impl From<(u16, u16)> for Size {
    fn from((width, height): (u16, u16)) -> Self {
        Self::new(width, height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Margin {
    pub horizontal: u16,
    pub vertical: u16,
}

impl Margin {
    pub const fn new(horizontal: u16, vertical: u16) -> Self {
        Self {
            horizontal,
            vertical,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl Rect {
    pub const fn new(x: u16, y: u16, width: u16, height: u16) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub const fn area(self) -> u32 {
        self.width as u32 * self.height as u32
    }

    pub const fn is_empty(self) -> bool {
        self.width == 0 || self.height == 0
    }

    pub const fn left(self) -> u16 {
        self.x
    }

    pub const fn right(self) -> u16 {
        self.x.saturating_add(self.width)
    }

    pub const fn top(self) -> u16 {
        self.y
    }

    pub const fn bottom(self) -> u16 {
        self.y.saturating_add(self.height)
    }

    pub fn inner(self, margin: Margin) -> Self {
        let double_h = margin.horizontal.saturating_mul(2);
        let double_v = margin.vertical.saturating_mul(2);
        let x = self.x.saturating_add(margin.horizontal);
        let y = self.y.saturating_add(margin.vertical);
        let width = self.width.saturating_sub(double_h);
        let height = self.height.saturating_sub(double_v);
        Self::new(x, y, width, height)
    }

    pub fn intersection(self, other: Self) -> Self {
        let x1 = self.x.max(other.x);
        let y1 = self.y.max(other.y);
        let x2 = self.right().min(other.right());
        let y2 = self.bottom().min(other.bottom());
        Self::new(x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1))
    }

    pub fn intersects(self, other: Self) -> bool {
        let x1 = self.x.max(other.x);
        let y1 = self.y.max(other.y);
        let x2 = self.right().min(other.right());
        let y2 = self.bottom().min(other.bottom());
        x1 < x2 && y1 < y2
    }

    pub fn union(self, other: Self) -> Self {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        let x1 = self.x.min(other.x);
        let y1 = self.y.min(other.y);
        let x2 = self.right().max(other.right());
        let y2 = self.bottom().max(other.bottom());
        Self::new(x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1))
    }

    pub const fn contains(self, pos: Position) -> bool {
        pos.x >= self.x
            && pos.x < self.x.saturating_add(self.width)
            && pos.y >= self.y
            && pos.y < self.y.saturating_add(self.height)
    }

    pub fn clamp(self, other: Self) -> Self {
        let width = self.width.min(other.width);
        let height = self.height.min(other.height);
        let x = self.x.max(other.x).min(other.right().saturating_sub(width));
        let y = self.y.max(other.y).min(other.bottom().saturating_sub(height));
        Self::new(x, y, width, height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub enum Alignment {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub enum Direction {
    Horizontal,
    #[default]
    Vertical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Constraint {
    Percentage(u16),
    Ratio(u32, u32),
    Length(u16),
    Max(u16),
    Min(u16),
    Fill(u16),
}

impl Constraint {
    pub fn apply(&self, total: u16) -> u16 {
        match *self {
            Constraint::Percentage(p) => {
                let p = p.min(100) as u32;
                ((total as u32 * p) / 100).min(total as u32) as u16
            }
            Constraint::Ratio(n, d) => {
                if d == 0 {
                    0
                } else {
                    ((total as u32 * n) / d).min(total as u32) as u16
                }
            }
            Constraint::Length(l) => l.min(total),
            Constraint::Max(m) => m.min(total),
            Constraint::Min(m) => m.min(total),
            Constraint::Fill(_) => total,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    direction: Direction,
    constraints: Vec<Constraint>,
    margin: Margin,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            direction: Direction::Vertical,
            constraints: Vec::new(),
            margin: Margin::default(),
        }
    }
}

impl Layout {
    pub fn new(direction: Direction, constraints: impl IntoIterator<Item = Constraint>) -> Self {
        Self {
            direction,
            constraints: constraints.into_iter().collect(),
            margin: Margin::default(),
        }
    }

    pub fn horizontal(constraints: impl IntoIterator<Item = Constraint>) -> Self {
        Self::new(Direction::Horizontal, constraints)
    }

    pub fn vertical(constraints: impl IntoIterator<Item = Constraint>) -> Self {
        Self::new(Direction::Vertical, constraints)
    }

    pub fn direction(mut self, direction: Direction) -> Self {
        self.direction = direction;
        self
    }

    pub fn constraints<I: IntoIterator<Item = Constraint>>(mut self, constraints: I) -> Self {
        self.constraints = constraints.into_iter().collect();
        self
    }

    pub fn margin(mut self, margin: u16) -> Self {
        self.margin = Margin::new(margin, margin);
        self
    }

    pub fn horizontal_margin(mut self, horizontal: u16) -> Self {
        self.margin.horizontal = horizontal;
        self
    }

    pub fn vertical_margin(mut self, vertical: u16) -> Self {
        self.margin.vertical = vertical;
        self
    }

    pub fn split(&self, target: Rect) -> Rc<[Rect]> {
        let area = target.inner(self.margin);
        if self.constraints.is_empty() || area.is_empty() {
            let res: Rc<[Rect]> = vec![].into();
            return res;
        }

        let total_size = match self.direction {
            Direction::Horizontal => area.width,
            Direction::Vertical => area.height,
        };

        let mut fixed_sizes: Vec<Option<u16>> = vec![None; self.constraints.len()];
        let mut allocated = 0u16;

        // First pass: resolve exact lengths, percentages, ratios, mins, maxs
        for (i, c) in self.constraints.iter().enumerate() {
            match *c {
                Constraint::Length(l) => {
                    let sz = l.min(total_size.saturating_sub(allocated));
                    fixed_sizes[i] = Some(sz);
                    allocated = allocated.saturating_add(sz);
                }
                Constraint::Percentage(p) => {
                    let sz = (((total_size as u32 * (p.min(100) as u32)) / 100) as u16)
                        .min(total_size.saturating_sub(allocated));
                    fixed_sizes[i] = Some(sz);
                    allocated = allocated.saturating_add(sz);
                }
                Constraint::Ratio(n, d) => {
                    let sz = if d == 0 {
                        0
                    } else {
                        (((total_size as u32 * n) / d) as u16)
                            .min(total_size.saturating_sub(allocated))
                    };
                    fixed_sizes[i] = Some(sz);
                    allocated = allocated.saturating_add(sz);
                }
                Constraint::Max(m) => {
                    let sz = m.min(total_size.saturating_sub(allocated));
                    fixed_sizes[i] = Some(sz);
                    allocated = allocated.saturating_add(sz);
                }
                _ => {}
            }
        }

        // Second pass: distribute remaining space among Min and Fill
        let remaining = total_size.saturating_sub(allocated);
        let mut total_weight = 0u32;
        for (i, c) in self.constraints.iter().enumerate() {
            if fixed_sizes[i].is_none() {
                match *c {
                    Constraint::Fill(w) => total_weight += (w.max(1)) as u32,
                    Constraint::Min(m) => total_weight += (m.max(1)) as u32,
                    _ => total_weight += 1,
                }
            }
        }

        let mut dyn_allocated = 0u16;
        for (i, c) in self.constraints.iter().enumerate() {
            if fixed_sizes[i].is_none() {
                let weight = match *c {
                    Constraint::Fill(w) => w.max(1) as u32,
                    Constraint::Min(m) => m.max(1) as u32,
                    _ => 1,
                };
                let share = if total_weight == 0 {
                    0
                } else {
                    ((remaining as u32 * weight) / total_weight) as u16
                };
                let sz = share.min(remaining.saturating_sub(dyn_allocated));
                fixed_sizes[i] = Some(sz);
                dyn_allocated = dyn_allocated.saturating_add(sz);
            }
        }

        // Build output rectangles
        let mut rects = Vec::with_capacity(self.constraints.len());
        let mut offset = 0u16;
        for sz_opt in fixed_sizes {
            let sz = sz_opt.unwrap_or(0);
            let rect = match self.direction {
                Direction::Horizontal => {
                    let r = Rect::new(area.x + offset, area.y, sz, area.height);
                    offset = offset.saturating_add(sz);
                    r
                }
                Direction::Vertical => {
                    let r = Rect::new(area.x, area.y + offset, area.width, sz);
                    offset = offset.saturating_add(sz);
                    r
                }
            };
            rects.push(rect);
        }

        rects.into()
    }
}
