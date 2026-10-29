use qd::composer_command::{
    apply_draft_op, autocomplete_remainder, commit_composer_command, match_composer_command,
    CommandCommit, ComposerCommand, DraftOp, DraftState,
};

fn catalog() -> Vec<ComposerCommand> {
    vec![
        ComposerCommand {
            name: "connect".into(),
            description: Some("Bind a source".into()),
            aliases: vec!["conn".into()],
        },
        ComposerCommand {
            description: Some("Switch model".into()),
            ..ComposerCommand::named("model")
        },
        ComposerCommand {
            description: Some("Exit".into()),
            ..ComposerCommand::named("quit")
        },
    ]
}

fn selected(draft: &str, commands: &[ComposerCommand]) -> (Option<String>, Vec<String>) {
    let matched = match_composer_command(draft, commands);
    (
        matched.selected.map(|command| command.name.clone()),
        matched
            .matches
            .iter()
            .map(|command| command.name.clone())
            .collect(),
    )
}

#[test]
fn composer_command_commits_on_the_draft_the_caret_already_uses() {
    let commands = catalog();
    assert_eq!(selected("hello", &commands), (None, Vec::<String>::new()));
    assert_eq!(
        selected("/conn", &commands),
        (Some("connect".into()), vec!["connect".into()])
    );
    assert_eq!(
        selected("/", &commands),
        (
            Some("connect".into()),
            vec!["connect".into(), "model".into(), "quit".into()]
        )
    );

    assert_eq!(
        [
            autocomplete_remainder("/", "/connect"),
            autocomplete_remainder("/con", "/connect"),
            autocomplete_remainder("/connect", "/connect"),
        ],
        ["connect", "nect", ""]
    );
    assert_eq!(
        [
            autocomplete_remainder("/connect", "openrouter"),
            autocomplete_remainder("/connect ", "openrouter"),
        ],
        [" openrouter", "openrouter"]
    );
    assert_eq!(
        [
            autocomplete_remainder("/connect open", "openrouter"),
            autocomplete_remainder("/connect open", "openai"),
            autocomplete_remainder("/connect openrouter", "openrouter"),
        ],
        ["router", "ai", ""]
    );
    assert_eq!(
        [
            autocomplete_remainder("/connect", "LM Studio"),
            autocomplete_remainder("/connect LM", "LM Studio"),
            autocomplete_remainder("/connect LM ", "LM Studio"),
            autocomplete_remainder("/connect LM St", "LM Studio"),
            autocomplete_remainder("/connect LM Studio", "LM Studio"),
            autocomplete_remainder("/connect Docker Model", "Docker Model Runner"),
        ],
        [" LM Studio", " Studio", "Studio", "udio", "", " Runner"]
    );
    assert_eq!(
        [
            autocomplete_remainder("/connect gpt", "chatgpt"),
            autocomplete_remainder("hello", "openrouter"),
            autocomplete_remainder("/connect foo bar", "openrouter"),
        ],
        ["", "", ""]
    );
    assert_eq!(
        autocomplete_remainder("/connect Open", "openrouter"),
        "router"
    );

    let matched = match_composer_command("/conn", &commands);
    let name = matched
        .selected
        .map(|command| command.name.as_str())
        .unwrap_or("");
    let typed = DraftState::new("/conn", 5, Some(1));
    let committed = commit_composer_command(&typed, CommandCommit::Verb { name });
    assert_eq!(committed.draft, "/connect ");
    assert_eq!(committed.cursor, "/connect ".len());
    assert_eq!(committed.mark, None);
    let argued = apply_draft_op(
        &committed,
        &DraftOp::Insert {
            text: "open".into(),
        },
    );
    assert_eq!(argued.draft, "/connect open");
    let chosen = commit_composer_command(&argued, CommandCommit::Choice { name: "openrouter" });
    assert_eq!(chosen.draft, "/connect openrouter");
    assert_eq!(chosen.cursor, chosen.draft.len());
    assert_eq!(chosen.mark, None);
    let kept = commit_composer_command(
        &DraftState::new("/connect grok\nkeep", 0, None),
        CommandCommit::Choice { name: "opus" },
    );
    assert_eq!(kept.draft, "/connect opus\nkeep");
    assert_eq!(kept.cursor, "/connect opus".len());
}
