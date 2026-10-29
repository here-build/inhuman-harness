/**
 * Shiki TextMate grammar for Arrival Scheme (`.scm`).
 *
 * Bundled `scheme` marks `[]` illegal and has no `{…}` / `#null` / `#void` /
 * `#attachment` / suffix-colon. Leaf matchers follow
 * `@here.build/arrival/grammar.ebnf` (R7RS datum plus those supersets).
 * Compounds are begin/end so nested lists and block comments span lines —
 * the eBNF matcher is not shipped.
 */
import type { LanguageRegistration } from "shiki";

// Shiki's JS regex engine closes a class at `[\]`; escape both brackets.
// Same delimiter set as grammar.ebnf `[\s()[\]{}',]`.
const D = String.raw`[\s(){}',\[\]]`;
const BOUND = `(?=$|${D})`;
const NOT_D = String.raw`[^\s(){}',\[\]]`;

const KEYWORD = [
  "define-values",
  "define-syntax",
  "define-macro",
  "define-class",
  "define-record-type",
  "define/overridable",
  "define",
  "defmacro",
  "case-lambda",
  "opt-lambda",
  "lambda",
  "λ",
  "letrec-syntax",
  "let-syntax",
  "let-values",
  "let*-values",
  "letrec",
  "let*",
  "let/ec",
  "let/cc",
  "let",
  "syntax-rules",
  "syntax-case",
  "call-with-current-continuation",
  "call/cc",
  "dynamic-wind",
  "unquote-splicing",
  "quasiquote",
  "unquote",
  "quote",
  "for-each",
  "unless",
  "when",
  "cond",
  "case",
  "else",
  "begin",
  "if",
  "and",
  "or",
  "not",
  "do",
  "map",
  "delay",
  "force",
  "set!",
  "require",
  "import",
  "=>",
]
  .map((k) => k.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

export const ARRIVAL_LANG = {
  name: "scm",
  scopeName: "source.arrival",
  displayName: "Arrival Scheme",
  aliases: ["scheme", "arrival"],
  fileTypes: ["scm"],
  patterns: [
    { include: "#atmosphere" },
    { include: "#abbreviation" },
    { include: "#compound" },
    { include: "#label" },
    { include: "#simple" },
  ],
  repository: {
    atmosphere: {
      patterns: [
        { match: String.raw`;[^\n]*`, name: "comment.line.semicolon.arrival" },
        { include: "#block-comment" },
        { match: "#;", name: "comment.punctuation.datum.arrival" },
        {
          match: `#!(?:no-)?fold-case${BOUND}`,
          name: "keyword.control.directive.arrival",
        },
      ],
    },
    "block-comment": {
      name: "comment.block.arrival",
      begin: "#\\|",
      end: "\\|#",
      patterns: [{ include: "#block-comment" }],
    },
    abbreviation: {
      patterns: [
        { match: ",@", name: "keyword.operator.unquote-splicing.arrival" },
        { match: "'", name: "keyword.operator.quote.arrival" },
        { match: "`", name: "keyword.operator.quasiquote.arrival" },
        { match: ",", name: "keyword.operator.unquote.arrival" },
        { match: `#attachment${BOUND}`, name: "keyword.operator.attachment.arrival" },
      ],
    },
    compound: {
      patterns: [
        {
          name: "meta.list.arrival",
          begin: "\\(",
          beginCaptures: { 0: { name: "punctuation.section.parens.begin.arrival" } },
          end: "\\)",
          endCaptures: { 0: { name: "punctuation.section.parens.end.arrival" } },
          patterns: [{ include: "$self" }],
        },
        {
          name: "meta.bytevector.arrival",
          begin: "#u8\\(",
          beginCaptures: { 0: { name: "punctuation.section.vector.begin.arrival" } },
          end: "\\)",
          endCaptures: { 0: { name: "punctuation.section.vector.end.arrival" } },
          patterns: [{ include: "$self" }],
        },
        {
          name: "meta.vector.arrival",
          begin: "#\\(",
          beginCaptures: { 0: { name: "punctuation.section.vector.begin.arrival" } },
          end: "\\)",
          endCaptures: { 0: { name: "punctuation.section.vector.end.arrival" } },
          patterns: [{ include: "$self" }],
        },
        {
          name: "meta.vec-lit.arrival",
          begin: "\\[",
          beginCaptures: { 0: { name: "punctuation.section.brackets.begin.arrival" } },
          end: "\\]",
          endCaptures: { 0: { name: "punctuation.section.brackets.end.arrival" } },
          patterns: [{ match: "[,:]", name: "punctuation.separator.arrival" }, { include: "$self" }],
        },
        {
          name: "meta.dict-lit.arrival",
          begin: "\\{",
          beginCaptures: { 0: { name: "punctuation.section.braces.begin.arrival" } },
          end: "\\}",
          endCaptures: { 0: { name: "punctuation.section.braces.end.arrival" } },
          patterns: [{ match: "[,:]", name: "punctuation.separator.arrival" }, { include: "$self" }],
        },
      ],
    },
    label: {
      patterns: [
        { match: String.raw`#\d+=`, name: "variable.other.label.arrival" },
        { match: String.raw`#\d+#`, name: "variable.other.label.arrival" },
      ],
    },
    simple: {
      patterns: [
        {
          name: "string.quoted.double.arrival",
          begin: '"',
          end: '"',
          patterns: [{ match: String.raw`\\[\s\S]`, name: "constant.character.escape.arrival" }],
        },
        {
          match: `${String.raw`#\\[\s\S]`}${NOT_D}*${BOUND}`,
          name: "constant.character.arrival",
        },
        {
          match: `#(?:false|true|f|t)${BOUND}`,
          name: "constant.language.boolean.arrival",
        },
        {
          match: `#(?:null|void)${BOUND}`,
          name: "constant.language.arrival",
        },
        {
          match: `[+-](?:inf|nan)\\.0${BOUND}`,
          name: "constant.numeric.arrival",
        },
        {
          match: `#(?:[eidobx]#)?[eidobx][+-]?[0-9a-fA-F]+(?:/[0-9a-fA-F]+)?${BOUND}`,
          name: "constant.numeric.arrival",
        },
        {
          match: `[+-]?(?:[0-9]+/[0-9]+|(?:[0-9]+\\.[0-9]*|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[0-9]+(?:[eE][+-]?[0-9]+)?)${BOUND}`,
          name: "constant.numeric.arrival",
        },
        {
          name: "string.other.symbol.arrival",
          begin: "\\|",
          end: "\\|",
          patterns: [{ match: String.raw`\\[\s\S]`, name: "constant.character.escape.arrival" }],
        },
        {
          match: `(?<=^|${D})(?:${KEYWORD})(?=$|${D})`,
          name: "keyword.control.arrival",
        },
        {
          match: `:${NOT_D}+`,
          name: "variable.other.constant.arrival",
        },
        {
          match: `${NOT_D}+:${BOUND}`,
          name: "variable.other.constant.arrival",
        },
        {
          match: `(?!\\.(?:$|${D}))(?!#\\|)(?!#;)(?!#attachment(?:$|${D}))(?!\\|)(?![;"\`])${NOT_D}+`,
          name: "variable.other.arrival",
        },
        {
          match: `\\.${BOUND}`,
          name: "punctuation.separator.cons.arrival",
        },
      ],
    },
  },
} satisfies LanguageRegistration;
