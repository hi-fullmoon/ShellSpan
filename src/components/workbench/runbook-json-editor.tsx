import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/format/browser/formatActions';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/indentation/browser/indentation';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';
import {
  createRunbookJsonSchema,
  RUNBOOK_MODEL_URI,
  RUNBOOK_SCHEMA_URI,
  runbookVariableNames,
} from '@/lib/runbook-schema';
import { installMonacoSelectionGuard } from './monaco-selection-guard';

const existingMonacoEnvironment = globalThis.MonacoEnvironment;
globalThis.MonacoEnvironment = {
  ...existingMonacoEnvironment,
  getWorker: (_workerId, label) => (
    label === 'json' ? new JsonWorker() : new EditorWorker()
  ),
};

interface RunbookJsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  onProblemsChange?: (count: number) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}

function editorTheme(): 'vs' | 'vs-dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs';
}

export const RunbookJsonEditor: React.FC<RunbookJsonEditorProps> = ({
  value,
  onChange,
  onProblemsChange,
  disabled = false,
  ariaLabel,
  className,
}) => {
  const { locale, t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const modelRef = useRef<monaco.editor.ITextModel | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const onProblemsChangeRef = useRef(onProblemsChange);
  const applyingExternalValueRef = useRef(false);
  const tRef = useRef(t);

  onChangeRef.current = onChange;
  onProblemsChangeRef.current = onProblemsChange;
  tRef.current = t;

  useEffect(() => {
    jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      comments: 'error',
      trailingCommas: 'error',
      enableSchemaRequest: false,
      schemaRequest: 'error',
      schemaValidation: 'error',
      schemas: [{
        uri: RUNBOOK_SCHEMA_URI,
        fileMatch: [RUNBOOK_MODEL_URI],
        schema: createRunbookJsonSchema(t),
      }],
    });
  }, [locale, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const modelUri = monaco.Uri.parse(RUNBOOK_MODEL_URI);
    monaco.editor.getModel(modelUri)?.dispose();
    const model = monaco.editor.createModel(value, 'json', modelUri);
    const editor = monaco.editor.create(container, {
      model,
      ariaLabel,
      readOnly: disabled,
      domReadOnly: disabled,
      automaticLayout: true,
      theme: editorTheme(),
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 20,
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: false,
      formatOnPaste: true,
      formatOnType: true,
      folding: true,
      foldingHighlight: true,
      glyphMargin: false,
      guides: {
        bracketPairs: true,
        indentation: true,
      },
      bracketPairColorization: { enabled: true },
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      padding: { top: 12, bottom: 12 },
      quickSuggestions: {
        comments: false,
        other: true,
        strings: true,
      },
      renderLineHighlight: 'line',
      renderValidationDecorations: 'on',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      suggestOnTriggerCharacters: true,
      wordWrap: 'on',
      wordWrapColumn: 100,
      wrappingIndent: 'indent',
    });

    editorRef.current = editor;
    modelRef.current = model;
    const disposeSelectionGuard = installMonacoSelectionGuard(editor);

    const contentListener = model.onDidChangeContent(() => {
      if (!applyingExternalValueRef.current) onChangeRef.current(model.getValue());
    });
    const markerListener = monaco.editor.onDidChangeMarkers((resources) => {
      if (!resources.some((resource) => resource.toString() === model.uri.toString())) return;
      const count = monaco.editor.getModelMarkers({ resource: model.uri })
        .filter((marker) => marker.severity === monaco.MarkerSeverity.Error)
        .length;
      onProblemsChangeRef.current?.(count);
    });
    const completionProvider = monaco.languages.registerCompletionItemProvider('json', {
      triggerCharacters: ['{'],
      provideCompletionItems: (completionModel, position) => {
        if (completionModel.uri.toString() !== model.uri.toString()) return { suggestions: [] };
        const linePrefix = completionModel.getLineContent(position.lineNumber)
          .slice(0, position.column - 1);
        const placeholder = linePrefix.match(/\{\{([A-Z0-9_]*)$/);
        if (!placeholder) return { suggestions: [] };
        const typedName = placeholder[1];
        const range = new monaco.Range(
          position.lineNumber,
          position.column - typedName.length,
          position.lineNumber,
          position.column,
        );
        return {
          suggestions: runbookVariableNames(completionModel.getValue()).map((name) => ({
            label: `{{${name}}}`,
            kind: monaco.languages.CompletionItemKind.Variable,
            detail: tRef.current('runbook.editor.variableCompletion'),
            documentation: tRef.current('runbook.editor.variableDocumentation', { name }),
            insertText: `${name}}}`,
            range,
            sortText: `0-${name}`,
          })),
        };
      },
    });
    const themeObserver = new MutationObserver(() => {
      monaco.editor.setTheme(editorTheme());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      themeObserver.disconnect();
      disposeSelectionGuard();
      completionProvider.dispose();
      markerListener.dispose();
      contentListener.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = undefined;
      modelRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model || model.getValue() === value) return;
    applyingExternalValueRef.current = true;
    model.setValue(value);
    applyingExternalValueRef.current = false;
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      ariaLabel,
      readOnly: disabled,
      domReadOnly: disabled,
    });
  }, [ariaLabel, disabled]);

  return (
    <div
      ref={containerRef}
      data-slot="runbook-json-editor"
      className={cn(
        'h-[30rem] min-h-[24rem] resize-y overflow-hidden rounded-lg border bg-background',
        'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        disabled && 'opacity-60',
        className,
      )}
    />
  );
};

export default RunbookJsonEditor;
