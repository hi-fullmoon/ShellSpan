import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';

describe('Tabs', () => {
  it('keeps the line-variant underline inside the trigger so scroll containers cannot clip it', () => {
    render(
      <Tabs defaultValue="one">
        <TabsList variant="line">
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">first</TabsContent>
        <TabsContent value="two">second</TabsContent>
      </Tabs>,
    );
    const active = screen.getByRole('tab', { name: 'One', selected: true });
    const inactive = screen.getByRole('tab', { name: 'Two', selected: false });
    for (const trigger of [active, inactive]) {
      expect(trigger).toHaveClass(
        'group-data-horizontal/tabs:after:bottom-0',
        'group-data-horizontal/tabs:after:inset-x-2.5',
        'after:rounded-full',
      );
      expect(trigger.className).not.toContain('after:bottom-[-5px]');
    }
  });
});
