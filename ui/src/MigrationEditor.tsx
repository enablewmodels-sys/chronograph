import { useEffect, useRef, type RefObject } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { lintGutter, linter } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
export type EditorHandle = { focus: () => void };
const theme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#101d2e",
      color: "#d5e1f3",
      fontSize: "13px",
      minHeight: "360px",
    },
    ".cm-scroller": { overflow: "auto", maxHeight: "65vh", minHeight: "360px" },
    ".cm-content": {
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      padding: "18px 0",
      caretColor: "#91b7ff",
    },
    ".cm-line": { padding: "0 18px", lineHeight: "1.85" },
    ".cm-gutters": {
      backgroundColor: "#101d2e",
      color: "#758aa7",
      borderRight: "1px solid #26364c",
      paddingRight: "8px",
    },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#172a4266" },
    "&.cm-focused": { outline: "2px solid #91b7ff", outlineOffset: "-2px" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#284872",
    },
    ".cm-tooltip": {
      backgroundColor: "#172a42",
      borderColor: "#496084",
      color: "#f3f5fa",
    },
  },
  { dark: true },
);
const highlights = HighlightStyle.define([
  { tag: tags.propertyName, color: "#8fc9fa" },
  { tag: tags.string, color: "#d9bc98" },
  { tag: tags.number, color: "#89d6c7" },
  { tag: [tags.bool, tags.null], color: "#baa8ea" },
]);
export default function MigrationEditor({
  value,
  onChange,
  readOnly,
  disabled,
  editorRef,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  disabled: boolean;
  editorRef: RefObject<EditorHandle | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const currentChange = useRef(onChange);
  currentChange.current = onChange;
  const externalChange = useRef(false);
  const editable = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    // CodeMirror uses constructible stylesheets in a shadow root, keeping its
    // generated styles isolated without relaxing the host's strict style CSP.
    const root =
      host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" });
    const instance = new EditorView({
      parent: root,
      root,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          json(),
          lintGutter(),
          linter(jsonParseLinter(), { delay: 600 }),
          syntaxHighlighting(highlights),
          theme,
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          editable.current.of([
            EditorState.readOnly.of(readOnly || disabled),
            EditorView.editable.of(!readOnly && !disabled),
          ]),
          EditorView.contentAttributes.of({
            "aria-label": "Migration JSON",
            role: "textbox",
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalChange.current)
              currentChange.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = instance;
    editorRef.current = { focus: () => instance.focus() };
    return () => {
      instance.destroy();
      view.current = null;
      editorRef.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = view.current;
    if (instance && instance.state.doc.toString() !== value) {
      externalChange.current = true;
      try {
        instance.dispatch({
          changes: { from: 0, to: instance.state.doc.length, insert: value },
        });
      } finally {
        externalChange.current = false;
      }
    }
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly || disabled),
        EditorView.editable.of(!readOnly && !disabled),
      ]),
    });
  }, [readOnly, disabled]);
  return <div ref={host} className="migration-editor-host" />;
}
