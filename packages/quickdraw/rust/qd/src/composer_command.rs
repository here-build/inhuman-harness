//! Slash-command match, the dim remainder, and the commit back onto a draft.
//!
//! Commit writes through [`crate::draft::apply_draft_op`]. The result is a
//! [`crate::draft::DraftState`], the same caret the echo already paints.

pub use crate::draft::{apply_draft_op, DraftOp, DraftState};

/// One catalog row. `name` is the verb without a required leading slash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposerCommand {
    pub name: String,
    pub description: Option<String>,
    pub aliases: Vec<String>,
}

impl ComposerCommand {
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: None,
            aliases: Vec::new(),
        }
    }
}

/// Prefix match. An empty `/` keeps the catalog. A draft with no slash matches nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandMatch<'a> {
    pub matches: Vec<&'a ComposerCommand>,
    pub selected: Option<&'a ComposerCommand>,
}

/// What Tab/Enter writes. `Verb` replaces the slash token. `Choice` replaces the argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandCommit<'a> {
    Verb { name: &'a str },
    Choice { name: &'a str },
}

pub fn match_composer_command<'a>(
    input: &str,
    commands: &'a [ComposerCommand],
) -> CommandMatch<'a> {
    let first = first_line(input).trim();
    let token = verb_token(first);
    if token.is_empty() && !first.starts_with('/') {
        return CommandMatch {
            matches: Vec::new(),
            selected: None,
        };
    }
    let matches: Vec<&ComposerCommand> = if token.is_empty() {
        commands.iter().collect()
    } else {
        commands
            .iter()
            .filter(|command| {
                command_names(command)
                    .iter()
                    .any(|name| name.starts_with(&token))
            })
            .collect()
    };
    let selected = matches.first().copied();
    CommandMatch { matches, selected }
}

/// Dim suffix after the caret. Empty when the draft is not a single-line slash prefix.
pub fn autocomplete_remainder(input: &str, selected_name: &str) -> String {
    if input.contains('\n') {
        return String::new();
    }
    let choice = selected_name.trim();
    if choice.is_empty() {
        return String::new();
    }
    let rest = input.trim_start();
    if !rest.starts_with('/') {
        return String::new();
    }
    let split_at = rest.find(char::is_whitespace);
    if choice.starts_with('/') {
        let Some(_) = split_at else {
            if !starts_with_insensitive(choice, rest) {
                return String::new();
            }
            return slice_from(choice, rest.chars().count()).to_string();
        };
        return String::new();
    }
    let Some(sp) = split_at else {
        return format!(" {choice}");
    };
    let args = &rest[sp + 1..];
    if !starts_with_insensitive(choice, args) {
        return String::new();
    }
    slice_from(choice, args.chars().count()).to_string()
}

/// Write the selected command onto `state` and clear the mark.
pub fn commit_composer_command(state: &DraftState, commit: CommandCommit<'_>) -> DraftState {
    let (first, rest) = split_first_line(&state.draft);
    match commit {
        CommandCommit::Verb { name } => {
            let lead = leading_ws(first);
            let after = &first[lead.len()..];
            if !after.starts_with('/') {
                return replace_draft(&state.draft, state.draft.len());
            }
            let args = match after.find(char::is_whitespace) {
                Some(sp) => &after[sp..],
                None => " ",
            };
            let verb = name.strip_prefix('/').unwrap_or(name);
            let next_first = format!("{lead}/{verb}{args}");
            let cursor = next_first.len();
            replace_draft(&format!("{next_first}{rest}"), cursor)
        }
        CommandCommit::Choice { name } => {
            let Some(verb) = slash_verb(first) else {
                return state.clone();
            };
            let lead = leading_ws(first);
            let next_first = format!("{lead}/{verb} {name}");
            let cursor = next_first.len();
            replace_draft(&format!("{next_first}{rest}"), cursor)
        }
    }
}

fn replace_draft(text: &str, cursor: usize) -> DraftState {
    let inserted = apply_draft_op(
        &DraftState::new("", 0, None),
        &DraftOp::Insert {
            text: text.to_string(),
        },
    );
    apply_draft_op(&inserted, &DraftOp::SetCaret { cursor, mark: None })
}

fn first_line(input: &str) -> &str {
    input.split('\n').next().unwrap_or("")
}

fn split_first_line(draft: &str) -> (&str, &str) {
    match draft.find('\n') {
        Some(index) => (&draft[..index], &draft[index..]),
        None => (draft, ""),
    }
}

fn leading_ws(text: &str) -> &str {
    let end = text
        .find(|ch: char| !ch.is_whitespace())
        .unwrap_or(text.len());
    &text[..end]
}

fn verb_token(first_trimmed: &str) -> String {
    let Some(rest) = first_trimmed.strip_prefix('/') else {
        return String::new();
    };
    rest.split(char::is_whitespace)
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn slash_verb(first: &str) -> Option<&str> {
    let token = first.trim().split(char::is_whitespace).next().unwrap_or("");
    let rest = token.strip_prefix('/')?;
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

fn command_names(command: &ComposerCommand) -> Vec<String> {
    std::iter::once(command.name.as_str())
        .chain(command.aliases.iter().map(String::as_str))
        .map(|name| name.trim_start_matches('/').to_lowercase())
        .collect()
}

fn starts_with_insensitive(full: &str, prefix: &str) -> bool {
    full.to_lowercase().starts_with(&prefix.to_lowercase())
}

fn slice_from(text: &str, chars: usize) -> &str {
    let start = text
        .char_indices()
        .nth(chars)
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    &text[start..]
}
