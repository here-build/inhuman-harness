import { createContext, useContext, type CSSProperties, type ReactNode } from "react";

import css from "../styles.css?raw";

/**
 * The brandbook's page furniture. It is drawn in the app's own tokens and
 * classes, so a page here changes when `styles.css` does; nothing is restated.
 */
export function Page({
  title,
  lede,
  children,
}: {
  readonly title: string;
  readonly lede: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="h-dvh overflow-y-auto bg-canvas text-ink">
      <article className="mx-auto flex max-w-[68rem] flex-col gap-16 px-6 py-14 md:px-10">
        <header>
          <p className="label text-sm text-muted">brandbook</p>
          <h1 className="mt-1 text-2xl tracking-[-0.025em]">{title}</h1>
          <div className="prose-wrap mt-3 max-w-[62ch] text-muted">{lede}</div>
        </header>
        {children}
      </article>
    </div>
  );
}

export function Section({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="border-b border-line pb-3">
        <h2 className="text-lg">{title}</h2>
        {note == null ? null : <div className="prose-wrap mt-1 max-w-[68ch] text-sm text-muted">{note}</div>}
      </div>
      {children}
    </section>
  );
}

/** A caption in the label role: a field or section name, never a heading. */
export function Label({ children }: { readonly children: ReactNode }) {
  return <p className="label text-sm text-muted">{children}</p>;
}

/** The same children painted once per scheme, side by side; `light-dark()` resolves per element. */
const SchemeContext = createContext<"light" | "dark" | null>(null);

export function Schemes({ children, className = "" }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(["light", "dark"] as const).map((scheme) => (
        <div
          key={scheme}
          className={`rounded-md border border-line bg-canvas p-5 text-ink ${className}`}
          style={{ colorScheme: scheme }}
        >
          <Label>{scheme}</Label>
          <SchemeContext.Provider value={scheme}>
            <div className="mt-3">{children}</div>
          </SchemeContext.Provider>
        </div>
      ))}
    </div>
  );
}

export function Rules({
  items,
}: {
  readonly items: readonly {
    readonly do: ReactNode;
    readonly dont: ReactNode;
  }[];
}) {
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {items.map((item, index) => (
        <li key={index} className="contents">
          <Verdict ok>{item.do}</Verdict>
          <Verdict ok={false}>{item.dont}</Verdict>
        </li>
      ))}
    </ul>
  );
}

/** The word carries the verdict; the bar's hue only repeats it. */
function Verdict({ ok, children }: { readonly ok: boolean; readonly children: ReactNode }) {
  return (
    <div
      className="rounded-sm border border-line bg-wash py-3 pr-4 pl-4 text-sm"
      style={{ boxShadow: `inset 2px 0 0 var(--${ok ? "success" : "danger"})` }}
    >
      <p className={`label text-xs ${ok ? "text-success" : "text-danger"}`}>{ok ? "do" : "don’t"}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** A link to a scene in this Storybook; it leaves the preview frame for the manager. */
export function StoryLink({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <a
      href={`/?path=/story/${id}`}
      target="_top"
      className="underline decoration-subtle underline-offset-[0.2em] hover:decoration-ink"
    >
      {children}
    </a>
  );
}

export function Mono({ children }: { readonly children: ReactNode }) {
  return <code className="mono text-[0.92em]">{children}</code>;
}

export type Token = {
  readonly name: string;
  readonly light: string;
  readonly dark: string;
};

/** The `:root` color pairs, read from the stylesheet the app ships. */
export const TOKENS: ReadonlyMap<string, Token> = (() => {
  const root = css.slice(css.search(/^:root\s*\{/m), css.indexOf("\n}", css.search(/^:root\s*\{/m)));
  const found = new Map<string, Token>();
  for (const [, name, light, dark] of root.matchAll(
    /--([\w-]+):\s*light-dark\((oklch\([^)]*\)),\s*(oklch\([^)]*\))\)/g,
  )) {
    found.set(name!, { name: name!, light: light!, dark: dark! });
  }
  return found;
})();

export function Swatch({
  name,
  role,
  style,
}: {
  readonly name: string;
  readonly role: ReactNode;
  readonly style?: CSSProperties;
}) {
  const token = TOKENS.get(name);
  const scheme = useContext(SchemeContext);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="h-14 rounded-sm border border-line" style={{ background: `var(--${name})`, ...style }} />
      <div className="min-w-0">
        <p className="mono text-sm text-ink">--{name}</p>
        <p className="text-sm text-muted">{role}</p>
        {token == null ? null : (
          <p className="mono mt-1 text-xs break-words text-subtle">
            {scheme == null ? (
              <>
                {token.light}
                <br />
                {token.dark}
              </>
            ) : (
              token[scheme]
            )}
          </p>
        )}
      </div>
    </div>
  );
}
