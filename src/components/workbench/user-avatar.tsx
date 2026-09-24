import React from 'react';
import { UserRoundIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UserAvatarProps {
  avatar?: string;
  name: string;
  className?: string;
  iconClassName?: string;
}

export const UserAvatar: React.FC<UserAvatarProps> = ({
  avatar,
  name,
  className,
  iconClassName,
}) => {
  if (avatar) {
    return (
      <span className={cn('relative inline-flex shrink-0 overflow-hidden rounded-full', className)}>
        <img src={avatar} alt={name} className="size-full object-cover" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary',
        className,
      )}
    >
      <UserRoundIcon aria-hidden className={cn('size-4', iconClassName)} />
    </span>
  );
};
