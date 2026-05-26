/**
 * markdown.jsx — shared Markdown renderer for chat + notebook surfaces.
 *
 * Wraps react-markdown + remark-gfm with a Prism syntax-highlighter
 * theme (vsc-dark-plus) so fenced code blocks render with VS Code-
 * style token coloring. Used by both ChatPanel (live advisor stream)
 * and NotebookPanel (saved-note rendering) so the visual treatment
 * is identical across both surfaces.
 *
 * Languages are registered lazily here at module load — once, then
 * every importer shares the registered set. Add new languages by
 * appending an import + a `registerLanguage` call in the block below.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

// Register only the languages that appear in this project's lessons.
// Each language module is ~2-5KB; importing the full bundle would add
// ~80KB of grammars we'd never use. Add more here as new lesson types
// appear in the SOT.
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";

SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("js", javascript);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("ts", typescript);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("html", markup);
SyntaxHighlighter.registerLanguage("xml", markup);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("py", python);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sh", bash);
SyntaxHighlighter.registerLanguage("shell", bash);
SyntaxHighlighter.registerLanguage("json", json);


// =====================================================
//  mdComponents — element overrides for ReactMarkdown
// =====================================================
/**
 * mdComponents — element overrides handed to <ReactMarkdown /> so the
 * rendered output matches the app's visual aesthetic.
 *
 * Each override receives the same props ReactMarkdown's default would,
 * including `children`. We discard the `node` prop (an AST node
 * ReactMarkdown attaches that we don't need) and forward the rest.
 */
export const mdComponents = {
  h1: ({ node, children, ...props }) => (
    <h1 {...props} style={{ fontSize: 22, fontWeight: 700, marginTop: 18, marginBottom: 10, color: "var(--text, #fff)" }}>
      {children}
    </h1>
  ),
  h2: ({ node, children, ...props }) => (
    <h2 {...props} style={{ fontSize: 18, fontWeight: 600, marginTop: 18, marginBottom: 8, color: "var(--text, #fff)", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: 4 }}>
      {children}
    </h2>
  ),
  h3: ({ node, children, ...props }) => (
    <h3 {...props} style={{ fontSize: 15, fontWeight: 600, marginTop: 14, marginBottom: 6, color: "rgba(255,255,255,0.88)" }}>
      {children}
    </h3>
  ),
  p: ({ node, children, ...props }) => (
    <p {...props} style={{ margin: "8px 0", lineHeight: 1.6 }}>
      {children}
    </p>
  ),
  ul: ({ node, children, ordered, ...props }) => (
    <ul {...props} style={{ margin: "6px 0 10px 0", paddingLeft: 22 }}>
      {children}
    </ul>
  ),
  ol: ({ node, children, ordered, ...props }) => (
    <ol {...props} style={{ margin: "6px 0 10px 0", paddingLeft: 22 }}>
      {children}
    </ol>
  ),
  li: ({ node, children, ...props }) => (
    <li {...props} style={{ margin: "3px 0", lineHeight: 1.55 }}>
      {children}
    </li>
  ),
  hr: ({ node, ...props }) => (
    <hr {...props} style={{ border: 0, borderTop: "1px solid rgba(255,255,255,0.10)", margin: "20px 0" }} />
  ),
  blockquote: ({ node, children, ...props }) => (
    <blockquote {...props} style={{ borderLeft: "3px solid rgba(57,255,20,0.4)", paddingLeft: 12, color: "rgba(255,255,255,0.78)", margin: "10px 0" }}>
      {children}
    </blockquote>
  ),
  a: ({ node, children, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: "var(--accent, #39ff14)",
        textDecoration: "underline",
        textDecorationColor: "rgba(57,255,20,0.4)",
      }}
    >
      {children}
    </a>
  ),
  // `code` covers BOTH inline `code` and code-block children. ReactMarkdown
  // wraps fenced code in <pre><code>; an inline backtick produces a bare
  // <code>. The `inline` prop tells us which case we're in.
  code: ({ node, inline, className, children, ...props }) => {
    if (inline) {
      return (
        <code
          {...props}
          style={{
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
            fontSize: "0.92em",
            background: "rgba(57,255,20,0.08)",
            color: "var(--accent, #39ff14)",
            padding: "1px 6px",
            borderRadius: 3,
          }}
        >
          {children}
        </code>
      );
    }
    // Fenced code block — hand off to Prism via SyntaxHighlighter for
    // VS-Code-style token coloring. `className` looks like
    // "language-jsx" when the fence has a language hint; we extract
    // the name and fall back to plain text if no hint is present.
    // PreTag="div" prevents the surrounding <pre> (from ReactMarkdown's
    // default code-block wrapper, neutralized below) from double-wrapping.
    const match = /language-([\w-]+)/.exec(className || "");
    const language = match ? match[1] : "text";
    return (
      <SyntaxHighlighter
        language={language}
        style={vscDarkPlus}
        PreTag="div"
        customStyle={{
          margin: "10px 0",
          padding: "12px 14px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.08)",
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
        codeTagProps={{
          style: {
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
          },
        }}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    );
  },
  // ReactMarkdown wraps fenced code in <pre><code> by default. Since
  // SyntaxHighlighter (above) renders its own div-wrapped block with
  // PreTag="div", we make the outer <pre> a transparent fragment —
  // otherwise the styling would double up and the highlighter's
  // background would sit inside an unstyled extra pre box.
  pre: ({ children }) => <>{children}</>,
};


/**
 * MarkdownBody — convenience wrapper. Pass markdown text as children
 * and the renderer + styling are wired up automatically.
 *
 * @param {object} props
 * @param {string} props.children  Raw markdown text to render.
 */
export function MarkdownBody({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={mdComponents}
    >
      {children || ""}
    </ReactMarkdown>
  );
}


// =====================================================
//  CodeBlock + language heuristic
// =====================================================
/**
 * detectLanguage — guess the language of a raw code string.
 *
 * The SOT stores code as plain strings without language metadata.
 * The advisor's markdown output has fenced code blocks with language
 * tags (and gets accurate highlighting via `mdComponents.code`); the
 * SOT-direct surfaces (LessonDrawer, SotBrowser, ArchivesPanel) and
 * the Classroom's EXAMPLE-beat `code` field don't.
 *
 * This heuristic checks the most distinctive markers first (HTML
 * doctype, JSX tags + React imports, Python `def`, etc.) and falls
 * through to "text" when nothing matches — at which point the
 * caller suppresses the language chip and renders without
 * Prism colors. Catches the common cases in the project's actual
 * lesson content (FE/JS/JSX, Python, HTML, CSS, shell).
 *
 * Order matters: more distinctive patterns first, so we don't
 * misclassify (e.g. JSX before plain JS; HTML before CSS).
 */
export function detectLanguage(code) {
  if (!code) return "text";
  const s = code.trim();

  // HTML — doctype or html-shaped tags. Most distinctive marker.
  if (
    /^<!doctype\s+html/i.test(s) ||
    /^<html[\s>]/i.test(s) ||
    /^<(head|body|div|p|h[1-6]|ul|ol|li|table|form|input|button|a)[\s>]/i.test(s)
  ) {
    return "html";
  }

  // CSS — selector { property: value } pattern, no JS keywords
  if (
    /^[.#a-zA-Z][\w-]*\s*(\,\s*[.#a-zA-Z][\w-]*\s*)*\{/m.test(s) &&
    /[a-z-]+\s*:\s*[^;{}\n]+;/.test(s) &&
    !/=>|function\s+\w+\s*\(|const\s+\w+\s*=/.test(s)
  ) {
    return "css";
  }

  // JSX — React imports, capitalized component tags, or JSX returns
  if (
    /\bimport\s+(React|\{[^}]*\})\s+from\s+["']react["']/i.test(s) ||
    /<[A-Z]\w*[\s/>]/.test(s) ||
    (/return\s*\(\s*</.test(s) && /<\/?[a-z]/i.test(s)) ||
    /useState|useEffect|useRef|useMemo|useCallback/.test(s)
  ) {
    return "jsx";
  }

  // Python — def/class/print/if __name__/imports without "from {} from"
  if (
    /^def\s+\w+\s*\(/m.test(s) ||
    /^class\s+\w+(\([\w.,\s]+\))?\s*:/m.test(s) ||
    /^if\s+__name__\s*==\s*['"]__main__['"]/m.test(s) ||
    /^\s*print\s*\(/m.test(s) ||
    /^import\s+[\w.]+\s*$/m.test(s) ||
    /^from\s+[\w.]+\s+import\s+/m.test(s)
  ) {
    return "python";
  }

  // JavaScript / TypeScript — function declarations, modern syntax
  if (
    /^(function|const|let|var)\s+[\w$]+/m.test(s) ||
    /=>\s*[{(]/.test(s) ||
    /^(import|export)\s+/m.test(s) ||
    /\.then\(|\.catch\(|\bawait\s+/.test(s)
  ) {
    // Distinguish TypeScript if explicit type annotations appear
    if (/:\s*(string|number|boolean|any|void|never|unknown)\b/.test(s)) {
      return "typescript";
    }
    return "javascript";
  }

  // Shell / bash — common command-line patterns
  if (
    /^\$\s+\S/m.test(s) ||
    /^(npm|node|python|pip|git|cd|ls|mkdir|rm|cp|mv|brew|curl|sudo|chmod|chown|export)\s+/m.test(s)
  ) {
    return "bash";
  }

  // JSON — starts with { or [, has "key": value pattern
  if (
    (/^[\s\n]*[{[]/.test(s) && /"[\w-]+"\s*:\s*/.test(s)) &&
    !/=>|function\s+|const\s+/.test(s)
  ) {
    return "json";
  }

  return "text";
}

/**
 * CodeBlock — standalone syntax-highlighted code block.
 *
 * Use when you have raw code (not markdown) and want it rendered
 * with the same visual treatment that fenced code gets inside a
 * <MarkdownBody/>. Same Prism engine, same vsc-dark-plus theme,
 * same border and padding — so a code block in the LessonDrawer
 * looks identical to one in a my-AI-stro Chat response.
 *
 * Language detection: if `language` isn't passed, runs the
 * heuristic above. If the heuristic returns "text" (couldn't
 * identify a language), the language chip is suppressed and the
 * block renders as plain monospace with no token coloring.
 *
 * @param {object} props
 * @param {string} props.code        Raw code string.
 * @param {string} [props.language]  Optional explicit language tag.
 *                                   If omitted, runs detectLanguage.
 */
export function CodeBlock({ code, language }) {
  if (!code) return null;
  const detected = language || detectLanguage(code);
  const showChip = detected !== "text";

  return (
    <div style={{ position: "relative", margin: "10px 0" }}>
      {showChip && (
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 10,
            padding: "1px 7px",
            background: "rgba(0,0,0,0.5)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 3,
            fontSize: 9,
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
            letterSpacing: "0.08em",
            textTransform: "lowercase",
            color: "rgba(255,255,255,0.55)",
            zIndex: 1,
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          {detected}
        </div>
      )}
      <SyntaxHighlighter
        language={detected}
        style={vscDarkPlus}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: "12px 14px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.08)",
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
        codeTagProps={{
          style: {
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
          },
        }}
      >
        {code.replace(/\n+$/, "")}
      </SyntaxHighlighter>
    </div>
  );
}
