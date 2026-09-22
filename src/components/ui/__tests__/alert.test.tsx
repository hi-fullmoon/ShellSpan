import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert, AlertDescription, AlertTitle } from '../alert';
import { InfoIcon } from 'lucide-react';

describe('Alert compact typography', () => {
  it.each(['default', 'sm', 'xs'] as const)('colors the info icon without changing text at size %s', size => {
    render(<Alert variant="info" size={size}><InfoIcon /><AlertDescription>操作提示</AlertDescription></Alert>);
    expect(screen.getByRole('alert')).toHaveClass('*:[svg]:text-primary', 'text-foreground');
    expect(screen.getByRole('alert')).not.toHaveClass('*:[svg]:text-current');
  });

  it.each(['default', 'sm', 'xs'] as const)('uses a 4px icon gap at size %s', size => {
    render(<Alert size={size}><InfoIcon /><AlertDescription>操作提示</AlertDescription></Alert>);
    expect(screen.getByRole('alert')).toHaveClass('has-[>svg]:gap-x-1');
  });

  it.each(['sm', 'xs'] as const)('keeps %s text in its natural line box', size => {
    render(<Alert size={size}>
      <AlertTitle>操作提示</AlertTitle>
      <AlertDescription>发送后会在当前终端新建续接会话，旧命令不会自动重试。</AlertDescription>
    </Alert>);
    for (const text of ['操作提示', '发送后会在当前终端新建续接会话，旧命令不会自动重试。']) {
      expect(screen.getByText(text).className).not.toContain('translate-y');
    }
    expect(screen.getByRole('alert')).toHaveAttribute('data-size', size);
  });
});
