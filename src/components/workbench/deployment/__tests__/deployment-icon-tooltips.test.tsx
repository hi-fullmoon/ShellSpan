import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { WorkflowListPane } from '../workflow-list-pane';

afterEach(cleanup);

describe('deployment borderless icon tooltips', () => {
  it('covers every deployment ghost icon button with a tooltip and readable label', () => {
    const directory = resolve(process.cwd(), 'src/components/workbench/deployment');
    const files = [
      ...readdirSync(directory).filter((file) => file.endsWith('.tsx')).map((file) => resolve(directory, file)),
      resolve(directory, '../deployment-workflow-center.tsx'),
      resolve(directory, '../deployment-workflow-runtime.tsx'),
    ];
    let count = 0;
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'Button') {
          const attribute = (name: string): string | undefined => {
            const value = node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === name);
            return value && ts.isJsxAttribute(value) && value.initializer && ts.isStringLiteral(value.initializer)
              ? value.initializer.text : undefined;
          };
          if (attribute('variant') === 'ghost' && attribute('size')?.startsWith('icon')) {
            count += 1;
            let parent: ts.Node | undefined = node.parent;
            while (parent && !(ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === 'Tooltip')) parent = parent.parent;
            expect(parent, `${file}: icon button needs a Tooltip`).toBeDefined();
            expect(parent?.getText(source)).toContain('<TooltipContent>');
            expect(parent?.getText(source)).toContain('aria-label={t(');
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(count).toBeGreaterThanOrEqual(7);
  });

  it.each(['zh-CN', 'en-US'] as const)('shows the create hint and preserves its action and disabled state in %s', async (locale) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const user = userEvent.setup();
    let createCount = 0;
    const pane = (canCreate: boolean) => (
      <TooltipProvider delay={0}>
        <WorkflowListPane
          workflows={[]}
          selectedWorkflowId={null}
          search=""
          onSearchChange={() => undefined}
          onSelect={() => undefined}
          onCreate={() => { createCount += 1; }}
          canCreate={canCreate}
        />
      </TooltipProvider>
    );
    const { rerender } = render(pane(true));
    const label = t('deployment.editor.template.title');
    const button = screen.getByRole('button', { name: label });
    expect(button).toHaveClass('size-8');
    await user.hover(button);
    expect(await screen.findByText(label)).toBeVisible();
    await user.unhover(button);
    await waitFor(() => expect(screen.queryByText(label)).not.toBeInTheDocument());
    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByText(label)).toBeVisible();
    await user.keyboard('{Enter}');
    expect(createCount).toBe(1);
    rerender(pane(false));
    expect(button).toBeDisabled();
    await user.click(button);
    expect(createCount).toBe(1);
  });
});
