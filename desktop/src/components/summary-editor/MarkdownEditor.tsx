import { useEffect, useRef } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { basicSetup } from "codemirror";

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  placeholderText = "Zusammenfassung bearbeiten…",
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  placeholderText?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        placeholder(placeholderText),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            backgroundColor: "transparent",
            color: "var(--text)",
          },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
            fontSize: "13px",
            lineHeight: "1.65",
          },
          ".cm-content": {
            minHeight: "100%",
            padding: "22px 26px",
            caretColor: "var(--accent)",
          },
          ".cm-gutters": { display: "none" },
          ".cm-activeLine": {
            backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)",
          },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
            backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)",
          },
          ".cm-cursor": { borderLeftColor: "var(--accent)" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={hostRef} className="summary-markdown-editor" />;
}
