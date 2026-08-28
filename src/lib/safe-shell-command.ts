const GENERIC_READ_ONLY_COMMANDS = new Set([
  'cat', 'df', 'du', 'free', 'grep', 'head', 'id', 'ls', 'lsof', 'netstat', 'ps', 'stat',
  'tail', 'uname', 'uptime', 'whoami',
]);
const SAFE_HOSTNAME_ARGUMENTS = new Set([
  '-A', '-d', '-f', '-i', '-I', '-s', '--all-fqdns', '--all-ip-addresses', '--domain',
  '--fqdn', '--help', '--ip-address', '--short', '--version',
]);
const MUTATING_JOURNALCTL_OPTIONS = [
  '--flush', '--relinquish-var', '--rotate', '--setup-keys', '--smart-relinquish-var',
  '--sync', '--update-catalog', '--vacuum-',
];

function hasFollowOrWatchOption(args: string[]): boolean {
  return args.some((argument) => (
    argument === '-F'
    || /^-[^-]*[fw][^-]*$/i.test(argument)
    || argument === '--watch-only'
    || argument.startsWith('--follow')
    || argument.startsWith('--watch')
  ));
}

function hasEnabledFlag(args: string[], option: string): boolean {
  return args.some((argument) => argument === option || argument === `${option}=true`);
}

function hasNumericLimit(args: string[], longOption: string, shortOption?: string): boolean {
  return args.some((argument, index) => {
    if (new RegExp(`^${longOption}=\\d+$`).test(argument)) return true;
    if (argument === longOption) return /^\d+$/.test(args[index + 1] ?? '');
    if (!shortOption) return false;
    if (argument === shortOption) return /^\d+$/.test(args[index + 1] ?? '');
    return new RegExp(`^${shortOption}\\d+$`).test(argument);
  });
}

/**
 * Validates commands before the AI panel offers its paste-only shortcut.
 * The allowlist intentionally excludes shell syntax and state-changing forms.
 */
export function isSafeReadOnlyCommand(command: string): boolean {
  const normalized = command.trim();
  if (
    !normalized
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
    || !/^[\p{L}\p{N} ._\/%:=+,@-]+$/u.test(normalized)
  ) return false;
  const [program, ...args] = normalized.split(/ +/);
  const action = args[0];
  if (program === 'tail') return !hasFollowOrWatchOption(args);
  if (program === 'cat') {
    return args.some((argument) => !argument.startsWith('-'))
      && !args.some((argument) => /^\/dev\/(?:full|null|random|urandom|zero)$/.test(argument));
  }
  if (GENERIC_READ_ONLY_COMMANDS.has(program)) return true;
  if (program === 'date') {
    return args.every((argument) => (
      argument === '-u'
      || argument === '--utc'
      || argument === '--help'
      || argument === '--version'
      || argument.startsWith('+')
      || argument.startsWith('--iso-8601')
      || argument.startsWith('--rfc-3339')
    ));
  }
  if (program === 'hostname') return args.every((argument) => SAFE_HOSTNAME_ARGUMENTS.has(argument));
  if (program === 'journalctl') {
    return !hasFollowOrWatchOption(args) && !args.some((argument) => (
      MUTATING_JOURNALCTL_OPTIONS.some((option) => argument.startsWith(option))
    )) && hasNumericLimit(args, '--lines', '-n');
  }
  if (program === 'ss') return !args.some((argument) => ['-K', '--kill'].includes(argument));
  if (program === 'systemctl') return ['status', 'show', 'is-active', 'list-units'].includes(action);
  if (program === 'docker') {
    if (action === 'stats') return hasEnabledFlag(args.slice(1), '--no-stream');
    if (action === 'logs') {
      return !hasFollowOrWatchOption(args.slice(1))
        && hasNumericLimit(args.slice(1), '--tail');
    }
    return ['ps', 'inspect'].includes(action);
  }
  if (program === 'kubectl') {
    if (action === 'logs') {
      return !hasFollowOrWatchOption(args.slice(1))
        && hasNumericLimit(args.slice(1), '--tail');
    }
    if (action === 'get') return !hasFollowOrWatchOption(args.slice(1));
    return ['describe', 'top'].includes(action);
  }
  return false;
}
