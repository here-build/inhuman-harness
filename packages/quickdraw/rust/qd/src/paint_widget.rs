//! Interpreted paint fields.
//!
//! The wire is still a JSON object. After the kind is known, the keys a
//! layout arm reads live on [`Widget`]. Every other key stays in the caller's
//! tail, so a patch of `model` or `caption` still applies. Layout reads
//! caption, pretty block, drawer rows, and rewind pins from that tail.
//!
//! A missing string takes the ingest default (`assistant`, `live`, `none`).
//! A present non-string, and a later remove, become `""`. That is what
//! `owned_str` did when the key was absent. A bool uses one default for a
//! missing key, a wrong type, and a remove. A missing `cursor` is `0`; null
//! and a later remove are absent. Other numbers are absent in all three cases.

use std::collections::BTreeMap;

use crate::paint_replica::Json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Root,
    Turn,
    Stack,
    Preview,
    Rewind,
    Completion,
    Speech,
    Thinking,
    Failure,
    Recall,
    Compact,
    Tool,
    Scheme,
    Loop,
    Ask,
    Wait,
    Composer,
    Statusline,
    Agents,
}

impl Kind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Kind::Root => "root",
            Kind::Turn => "turn",
            Kind::Stack => "stack",
            Kind::Preview => "preview",
            Kind::Rewind => "rewind",
            Kind::Completion => "completion",
            Kind::Speech => "speech",
            Kind::Thinking => "thinking",
            Kind::Failure => "failure",
            Kind::Recall => "recall",
            Kind::Compact => "compact",
            Kind::Tool => "tool",
            Kind::Scheme => "scheme",
            Kind::Loop => "loop",
            Kind::Ask => "ask",
            Kind::Wait => "wait",
            Kind::Composer => "composer",
            Kind::Statusline => "statusline",
            Kind::Agents => "agents",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "root" => Kind::Root,
            "turn" => Kind::Turn,
            "stack" => Kind::Stack,
            "preview" => Kind::Preview,
            "rewind" => Kind::Rewind,
            "completion" => Kind::Completion,
            "speech" => Kind::Speech,
            "thinking" => Kind::Thinking,
            "failure" => Kind::Failure,
            "recall" => Kind::Recall,
            "compact" => Kind::Compact,
            "tool" => Kind::Tool,
            "scheme" => Kind::Scheme,
            "loop" => Kind::Loop,
            "ask" => Kind::Ask,
            "wait" => Kind::Wait,
            "composer" => Kind::Composer,
            "statusline" => Kind::Statusline,
            "agents" => Kind::Agents,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkKind {
    Tool,
    Scheme,
    Loop,
    Ask,
    Wait,
}

impl WorkKind {
    fn kind(self) -> Kind {
        match self {
            WorkKind::Tool => Kind::Tool,
            WorkKind::Scheme => Kind::Scheme,
            WorkKind::Loop => Kind::Loop,
            WorkKind::Ask => Kind::Ask,
            WorkKind::Wait => Kind::Wait,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Speech {
    pub(crate) text: String,
    pub(crate) voice: String,
    pub(crate) recap: bool,
    pub(crate) at_ms: Option<f64>,
    pub(crate) annotation: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Completion {
    pub(crate) state: String,
    pub(crate) thought_live: bool,
    pub(crate) debug_note: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Work {
    pub(crate) name: String,
    pub(crate) object: String,
    pub(crate) status: String,
    pub(crate) state: String,
    pub(crate) fuse: bool,
    pub(crate) receipt_kind: String,
    pub(crate) receipt_text: String,
    pub(crate) diff_path: String,
    pub(crate) diff_old: String,
    pub(crate) diff_new: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Composer {
    pub(crate) draft: String,
    pub(crate) cursor: Option<f64>,
    pub(crate) mark: Option<f64>,
    pub(crate) interactive: bool,
    pub(crate) read_only: bool,
    pub(crate) placeholder: String,
    pub(crate) annotation: String,
}

#[derive(Clone, Debug)]
pub(crate) enum Widget {
    Root,
    Turn,
    Stack,
    Preview,
    Speech(Speech),
    Thinking {
        text: String,
    },
    Recall {
        text: String,
    },
    Compact {
        text: String,
    },
    Failure {
        end_detail: String,
        fail_reason: String,
    },
    Completion(Completion),
    Work {
        kind: WorkKind,
        body: Work,
    },
    Composer(Composer),
    Statusline {
        left: String,
        cwd: String,
    },
    Agents {
        meter_left: String,
        meter_right: String,
    },
    Rewind {
        at_tip: bool,
    },
}

pub(crate) struct Parsed {
    pub(crate) widget: Widget,
    pub(crate) tail: BTreeMap<String, Json>,
}

pub(crate) enum FieldMut<'a> {
    Str(&'a mut String),
    Bool(&'a mut bool, bool),
    Num(&'a mut Option<f64>),
    Tail,
}

impl Widget {
    pub(crate) fn kind(&self) -> Kind {
        match self {
            Widget::Root => Kind::Root,
            Widget::Turn => Kind::Turn,
            Widget::Stack => Kind::Stack,
            Widget::Preview => Kind::Preview,
            Widget::Speech(_) => Kind::Speech,
            Widget::Thinking { .. } => Kind::Thinking,
            Widget::Recall { .. } => Kind::Recall,
            Widget::Compact { .. } => Kind::Compact,
            Widget::Failure { .. } => Kind::Failure,
            Widget::Completion(_) => Kind::Completion,
            Widget::Work { kind, .. } => kind.kind(),
            Widget::Composer(_) => Kind::Composer,
            Widget::Statusline { .. } => Kind::Statusline,
            Widget::Agents { .. } => Kind::Agents,
            Widget::Rewind { .. } => Kind::Rewind,
        }
    }

    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            Widget::Speech(speech) => Some(speech.text.as_str()),
            Widget::Thinking { text } | Widget::Recall { text } | Widget::Compact { text } => {
                Some(text.as_str())
            }
            _ => None,
        }
    }

    pub(crate) fn speech(&self) -> Option<&Speech> {
        match self {
            Widget::Speech(speech) => Some(speech),
            _ => None,
        }
    }

    pub(crate) fn completion(&self) -> Option<&Completion> {
        match self {
            Widget::Completion(completion) => Some(completion),
            _ => None,
        }
    }

    pub(crate) fn work(&self) -> Option<&Work> {
        match self {
            Widget::Work { body, .. } => Some(body),
            _ => None,
        }
    }

    pub(crate) fn composer(&self) -> Option<&Composer> {
        match self {
            Widget::Composer(composer) => Some(composer),
            _ => None,
        }
    }

    pub(crate) fn failure(&self) -> Option<(&str, &str)> {
        match self {
            Widget::Failure {
                end_detail,
                fail_reason,
            } => Some((end_detail.as_str(), fail_reason.as_str())),
            _ => None,
        }
    }

    pub(crate) fn statusline(&self) -> Option<(&str, &str)> {
        match self {
            Widget::Statusline { left, cwd } => Some((left.as_str(), cwd.as_str())),
            _ => None,
        }
    }

    pub(crate) fn agents(&self) -> Option<(&str, &str)> {
        match self {
            Widget::Agents {
                meter_left,
                meter_right,
            } => Some((meter_left.as_str(), meter_right.as_str())),
            _ => None,
        }
    }

    pub(crate) fn at_tip(&self) -> Option<bool> {
        match self {
            Widget::Rewind { at_tip } => Some(*at_tip),
            _ => None,
        }
    }

    /// `Err` is the rejected kind name. `self` and `tail` stay put.
    pub(crate) fn rekind(
        &mut self,
        tail: &mut BTreeMap<String, Json>,
        new_kind: &str,
    ) -> Result<(), String> {
        let mut fields = tail.clone();
        fields.remove("kind");
        fields.extend(self.to_fields());
        let mut parsed = parse(new_kind, fields)?;
        parsed
            .tail
            .insert("kind".to_string(), Json::String(new_kind.to_string()));
        *self = parsed.widget;
        *tail = parsed.tail;
        Ok(())
    }

    pub(crate) fn is_known(&self, key: &str) -> bool {
        known(self.kind(), key).is_some()
    }

    pub(crate) fn field_mut(&mut self, key: &str) -> FieldMut<'_> {
        let kind = self.kind();
        let Some(slot) = known(kind, key) else {
            return FieldMut::Tail;
        };
        match (self, slot) {
            (Widget::Speech(body), Slot::Str) => match key {
                "text" => FieldMut::Str(&mut body.text),
                "voice" => FieldMut::Str(&mut body.voice),
                "annotation" => FieldMut::Str(&mut body.annotation),
                _ => FieldMut::Tail,
            },
            (Widget::Speech(body), Slot::Bool) => FieldMut::Bool(&mut body.recap, false),
            (Widget::Speech(body), Slot::Num) => FieldMut::Num(&mut body.at_ms),
            (
                Widget::Thinking { text } | Widget::Recall { text } | Widget::Compact { text },
                Slot::Str,
            ) => FieldMut::Str(text),
            (
                Widget::Failure {
                    end_detail,
                    fail_reason,
                },
                Slot::Str,
            ) => match key {
                "endDetail" => FieldMut::Str(end_detail),
                "failReason" => FieldMut::Str(fail_reason),
                _ => FieldMut::Tail,
            },
            (Widget::Completion(body), Slot::Str) => match key {
                "state" => FieldMut::Str(&mut body.state),
                "debugNote" => FieldMut::Str(&mut body.debug_note),
                _ => FieldMut::Tail,
            },
            (Widget::Completion(body), Slot::Bool) => FieldMut::Bool(&mut body.thought_live, false),
            (Widget::Work { body, .. }, Slot::Str) => match key {
                "name" => FieldMut::Str(&mut body.name),
                "object" => FieldMut::Str(&mut body.object),
                "status" => FieldMut::Str(&mut body.status),
                "state" => FieldMut::Str(&mut body.state),
                "receiptKind" => FieldMut::Str(&mut body.receipt_kind),
                "receiptText" => FieldMut::Str(&mut body.receipt_text),
                "diffPath" => FieldMut::Str(&mut body.diff_path),
                "diffOld" => FieldMut::Str(&mut body.diff_old),
                "diffNew" => FieldMut::Str(&mut body.diff_new),
                _ => FieldMut::Tail,
            },
            (Widget::Work { body, .. }, Slot::Bool) => FieldMut::Bool(&mut body.fuse, false),
            (Widget::Composer(body), Slot::Str) => match key {
                "draft" => FieldMut::Str(&mut body.draft),
                "placeholder" => FieldMut::Str(&mut body.placeholder),
                "annotation" => FieldMut::Str(&mut body.annotation),
                _ => FieldMut::Tail,
            },
            (Widget::Composer(body), Slot::Bool) => match key {
                "interactive" => FieldMut::Bool(&mut body.interactive, true),
                "readOnly" => FieldMut::Bool(&mut body.read_only, false),
                _ => FieldMut::Tail,
            },
            (Widget::Composer(body), Slot::Num) => match key {
                "cursor" => FieldMut::Num(&mut body.cursor),
                "mark" => FieldMut::Num(&mut body.mark),
                _ => FieldMut::Tail,
            },
            (Widget::Statusline { left, cwd }, Slot::Str) => match key {
                "left" => FieldMut::Str(left),
                "cwd" => FieldMut::Str(cwd),
                _ => FieldMut::Tail,
            },
            (
                Widget::Agents {
                    meter_left,
                    meter_right,
                },
                Slot::Str,
            ) => match key {
                "meterLeft" => FieldMut::Str(meter_left),
                "meterRight" => FieldMut::Str(meter_right),
                _ => FieldMut::Tail,
            },
            (Widget::Rewind { at_tip }, Slot::Bool) => FieldMut::Bool(at_tip, true),
            _ => FieldMut::Tail,
        }
    }

    fn to_fields(&self) -> BTreeMap<String, Json> {
        let mut map = BTreeMap::new();
        match self {
            Widget::Root | Widget::Turn | Widget::Stack | Widget::Preview => {}
            Widget::Speech(body) => {
                put_str(&mut map, "text", &body.text);
                put_str(&mut map, "voice", &body.voice);
                put_bool(&mut map, "recap", body.recap);
                put_num(&mut map, "atMs", body.at_ms);
                put_str(&mut map, "annotation", &body.annotation);
            }
            Widget::Thinking { text } | Widget::Recall { text } | Widget::Compact { text } => {
                put_str(&mut map, "text", text);
            }
            Widget::Failure {
                end_detail,
                fail_reason,
            } => {
                put_str(&mut map, "endDetail", end_detail);
                put_str(&mut map, "failReason", fail_reason);
            }
            Widget::Completion(body) => {
                put_str(&mut map, "state", &body.state);
                put_bool(&mut map, "thoughtLive", body.thought_live);
                put_str(&mut map, "debugNote", &body.debug_note);
            }
            Widget::Work { body, .. } => {
                put_str(&mut map, "name", &body.name);
                put_str(&mut map, "object", &body.object);
                put_str(&mut map, "status", &body.status);
                put_str(&mut map, "state", &body.state);
                put_bool(&mut map, "fuse", body.fuse);
                put_str(&mut map, "receiptKind", &body.receipt_kind);
                put_str(&mut map, "receiptText", &body.receipt_text);
                put_str(&mut map, "diffPath", &body.diff_path);
                put_str(&mut map, "diffOld", &body.diff_old);
                put_str(&mut map, "diffNew", &body.diff_new);
            }
            Widget::Composer(body) => {
                put_str(&mut map, "draft", &body.draft);
                put_num(&mut map, "cursor", body.cursor);
                put_num(&mut map, "mark", body.mark);
                put_bool(&mut map, "interactive", body.interactive);
                put_bool(&mut map, "readOnly", body.read_only);
                put_str(&mut map, "placeholder", &body.placeholder);
                put_str(&mut map, "annotation", &body.annotation);
            }
            Widget::Statusline { left, cwd } => {
                put_str(&mut map, "left", left);
                put_str(&mut map, "cwd", cwd);
            }
            Widget::Agents {
                meter_left,
                meter_right,
            } => {
                put_str(&mut map, "meterLeft", meter_left);
                put_str(&mut map, "meterRight", meter_right);
            }
            Widget::Rewind { at_tip } => put_bool(&mut map, "atTip", *at_tip),
        }
        map
    }
}

/// `Err` is the kind name. `kind` and `children` are not left in the tail.
pub(crate) fn parse(kind_name: &str, mut fields: BTreeMap<String, Json>) -> Result<Parsed, String> {
    let Some(kind) = Kind::parse(kind_name) else {
        return Err(kind_name.to_string());
    };
    fields.remove("kind");
    fields.remove("children");
    let widget = match kind {
        Kind::Root => Widget::Root,
        Kind::Turn => Widget::Turn,
        Kind::Stack => Widget::Stack,
        Kind::Preview => Widget::Preview,
        Kind::Speech => Widget::Speech(Speech {
            text: take_string(&mut fields, "text", ""),
            voice: take_string(&mut fields, "voice", "assistant"),
            recap: take_bool(&mut fields, "recap", false),
            at_ms: take_num(&mut fields, "atMs"),
            annotation: take_string(&mut fields, "annotation", ""),
        }),
        Kind::Thinking => Widget::Thinking {
            text: take_string(&mut fields, "text", ""),
        },
        Kind::Recall => Widget::Recall {
            text: take_string(&mut fields, "text", ""),
        },
        Kind::Compact => Widget::Compact {
            text: take_string(&mut fields, "text", ""),
        },
        Kind::Failure => Widget::Failure {
            end_detail: take_string(&mut fields, "endDetail", ""),
            fail_reason: take_string(&mut fields, "failReason", ""),
        },
        Kind::Completion => Widget::Completion(Completion {
            state: take_string(&mut fields, "state", "live"),
            thought_live: take_bool(&mut fields, "thoughtLive", false),
            debug_note: take_string(&mut fields, "debugNote", ""),
        }),
        Kind::Tool | Kind::Scheme | Kind::Loop | Kind::Ask | Kind::Wait => Widget::Work {
            kind: match kind {
                Kind::Tool => WorkKind::Tool,
                Kind::Scheme => WorkKind::Scheme,
                Kind::Loop => WorkKind::Loop,
                Kind::Ask => WorkKind::Ask,
                Kind::Wait => WorkKind::Wait,
                _ => unreachable!("this arm runs only for a work kind"),
            },
            body: Work {
                name: take_string(&mut fields, "name", ""),
                object: take_string(&mut fields, "object", ""),
                status: take_string(&mut fields, "status", ""),
                state: take_string(&mut fields, "state", "live"),
                fuse: take_bool(&mut fields, "fuse", false),
                receipt_kind: take_string(&mut fields, "receiptKind", "none"),
                receipt_text: take_string(&mut fields, "receiptText", ""),
                diff_path: take_string(&mut fields, "diffPath", ""),
                diff_old: take_string(&mut fields, "diffOld", ""),
                diff_new: take_string(&mut fields, "diffNew", ""),
            },
        },
        Kind::Composer => Widget::Composer(Composer {
            draft: take_string(&mut fields, "draft", ""),
            // A missing cursor is 0. A null cursor, and a later remove, are absent.
            cursor: take_num_default(&mut fields, "cursor", Some(0.0)),
            mark: take_num(&mut fields, "mark"),
            interactive: take_bool(&mut fields, "interactive", true),
            read_only: take_bool(&mut fields, "readOnly", false),
            placeholder: take_string(&mut fields, "placeholder", ""),
            annotation: take_string(&mut fields, "annotation", ""),
        }),
        Kind::Statusline => Widget::Statusline {
            left: take_string(&mut fields, "left", ""),
            cwd: take_string(&mut fields, "cwd", ""),
        },
        Kind::Agents => Widget::Agents {
            meter_left: take_string(&mut fields, "meterLeft", ""),
            meter_right: take_string(&mut fields, "meterRight", ""),
        },
        Kind::Rewind => Widget::Rewind {
            at_tip: take_bool(&mut fields, "atTip", true),
        },
    };
    // Keys the layout never reads. The old constructor inserted them, and a
    // remove of one still has to succeed when the snapshot omitted it.
    fill_tail(kind, &mut fields);
    Ok(Parsed {
        widget,
        tail: fields,
    })
}

#[derive(Clone, Copy)]
enum Slot {
    Str,
    Bool,
    Num,
}

fn known(kind: Kind, key: &str) -> Option<Slot> {
    Some(match (kind, key) {
        (Kind::Speech, "text" | "voice" | "annotation") => Slot::Str,
        (Kind::Speech, "recap") => Slot::Bool,
        (Kind::Speech, "atMs") => Slot::Num,
        (Kind::Thinking | Kind::Recall | Kind::Compact, "text") => Slot::Str,
        (Kind::Failure, "endDetail" | "failReason") => Slot::Str,
        (Kind::Completion, "state" | "debugNote") => Slot::Str,
        (Kind::Completion, "thoughtLive") => Slot::Bool,
        (
            Kind::Tool | Kind::Scheme | Kind::Loop | Kind::Ask | Kind::Wait,
            "name" | "object" | "status" | "state" | "receiptKind" | "receiptText" | "diffPath"
            | "diffOld" | "diffNew",
        ) => Slot::Str,
        (Kind::Tool | Kind::Scheme | Kind::Loop | Kind::Ask | Kind::Wait, "fuse") => Slot::Bool,
        (Kind::Composer, "draft" | "placeholder" | "annotation") => Slot::Str,
        (Kind::Composer, "interactive" | "readOnly") => Slot::Bool,
        (Kind::Composer, "cursor" | "mark") => Slot::Num,
        (Kind::Statusline, "left" | "cwd") => Slot::Str,
        (Kind::Agents, "meterLeft" | "meterRight") => Slot::Str,
        (Kind::Rewind, "atTip") => Slot::Bool,
        _ => return None,
    })
}

fn take_string(fields: &mut BTreeMap<String, Json>, key: &str, missing: &str) -> String {
    match fields.remove(key) {
        Some(Json::String(text)) => text,
        Some(_) => String::new(),
        None => missing.to_string(),
    }
}

fn take_bool(fields: &mut BTreeMap<String, Json>, key: &str, default: bool) -> bool {
    match fields.remove(key) {
        Some(Json::Bool(value)) => value,
        _ => default,
    }
}

fn take_num(fields: &mut BTreeMap<String, Json>, key: &str) -> Option<f64> {
    take_num_default(fields, key, None)
}

fn take_num_default(
    fields: &mut BTreeMap<String, Json>,
    key: &str,
    missing: Option<f64>,
) -> Option<f64> {
    match fields.remove(key) {
        None => missing,
        Some(Json::Number(number)) if number.is_finite() => Some(number),
        _ => None,
    }
}

fn fill_tail(kind: Kind, fields: &mut BTreeMap<String, Json>) {
    let mut fill = |key: &str, value: Json| {
        fields.entry(key.to_string()).or_insert(value);
    };
    match kind {
        Kind::Speech => fill("recapHotkeys", Json::Array(Vec::new())),
        Kind::Completion => {
            fill("workerPresent", Json::Bool(false));
            fill("model", Json::String(String::new()));
            fill("startedAt", Json::Null);
            fill("durationMs", Json::Null);
            fill("retryUntilMs", Json::Null);
            fill("thoughtKind", Json::String(String::new()));
        }
        Kind::Tool | Kind::Scheme | Kind::Loop | Kind::Ask | Kind::Wait => {
            fill("toolCallId", Json::String(String::new()));
            fill("caption", Json::String(String::new()));
            fill("indent", Json::Bool(false));
            fill("split", Json::Bool(false));
            fill("agent", Json::Bool(false));
            fill("pretty", Json::Bool(false));
            fill("prettyBlock", Json::String(String::new()));
            fill("diffLineStart", Json::Number(0.0));
            fill("startedAt", Json::Null);
            fill("retryUntilMs", Json::Null);
        }
        Kind::Composer => fill("mode", Json::String("normal".to_string())),
        Kind::Statusline => {
            fill("cwdRoot", Json::String(String::new()));
            fill("note", Json::String(String::new()));
        }
        Kind::Agents => fill("open", Json::Bool(false)),
        Kind::Rewind => fill("seatRim", Json::Bool(true)),
        Kind::Root
        | Kind::Turn
        | Kind::Stack
        | Kind::Preview
        | Kind::Thinking
        | Kind::Failure
        | Kind::Recall
        | Kind::Compact => {}
    }
}

fn put_str(map: &mut BTreeMap<String, Json>, key: &str, value: &str) {
    map.insert(key.to_string(), Json::String(value.to_string()));
}

fn put_bool(map: &mut BTreeMap<String, Json>, key: &str, value: bool) {
    map.insert(key.to_string(), Json::Bool(value));
}

fn put_num(map: &mut BTreeMap<String, Json>, key: &str, value: Option<f64>) {
    map.insert(
        key.to_string(),
        match value {
            Some(number) => Json::Number(number),
            None => Json::Null,
        },
    );
}
