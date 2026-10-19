import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface SettingRowProps {
  children?: React.ReactNode;
  className?: string;
  controlId?: string;
  description: React.ReactNode;
  descriptionId?: string;
  label: React.ReactNode;
  labelId?: string;
}

export const SettingRow: React.FC<SettingRowProps> = ({
  children,
  className,
  controlId,
  description,
  descriptionId,
  label,
  labelId,
}) => (
  <Field
    className={cn(
      'min-h-14 gap-2 px-4 py-2.5 @min-[32rem]:flex-row @min-[32rem]:items-center @min-[32rem]:justify-between @min-[32rem]:gap-5',
      className,
    )}
  >
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <FieldLabel id={labelId} htmlFor={controlId} className="text-sm font-medium text-foreground">
        {label}
      </FieldLabel>
      <FieldDescription id={descriptionId}>
        {description}
      </FieldDescription>
    </div>
    {children && (
      <div
        data-slot="setting-control"
        className="flex min-h-8 w-full items-center justify-start @min-[32rem]:w-auto @min-[32rem]:shrink-0 @min-[32rem]:justify-end"
      >
        {children}
      </div>
    )}
  </Field>
);

interface SettingsGroupProps {
  action?: React.ReactNode;
  children: React.ReactNode;
  title?: React.ReactNode;
  titleId?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  action,
  children,
  title,
  titleId,
}) => {
  const rows = React.Children.toArray(children).filter((child) => (
    child !== null && child !== undefined && typeof child !== 'boolean'
  ));

  return (
    <section
      aria-labelledby={titleId}
      data-slot="settings-group"
      className="flex min-w-0 flex-col gap-2"
    >
      {(title || action) && (
        <div className="flex min-h-5 items-center justify-between gap-3 px-1">
          {title && (
            <h3 id={titleId} className="text-sm font-medium text-foreground">
              {title}
            </h3>
          )}
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </div>
      )}
      <Card size="sm" radius="compact" variant="outline" className="gap-0 py-0">
        <CardContent className="px-0">
          <FieldGroup className="gap-0">
            {rows.map((row, index) => (
              <React.Fragment key={index}>
                {index > 0 && <Separator className="mx-4 data-horizontal:w-auto" />}
                {row}
              </React.Fragment>
            ))}
          </FieldGroup>
        </CardContent>
      </Card>
    </section>
  );
};
