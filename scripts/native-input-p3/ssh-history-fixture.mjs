import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectSshPeer } from './ssh-recovery-fixture.mjs';

export const sshHistoryVariants = Object.freeze(['default', 'small', 'custom', 'empty', 'unset']);

export function configureSshHistory(fixture, directory, variant) {
  assert(sshHistoryVariants.includes(variant));
  inspectSshPeer(fixture);
  const bash = fixture.shell === 'bash', user = fixture.username, home = `/home/${user}`;
  const run = (...args) => execFileSync('docker', ['exec', fixture.container, ...args], { encoding: 'utf8', timeout: 10000 });
  function install(name, target, source) {
    const path = resolve(directory, name);
    writeFileSync(path, source, { flag: 'wx', mode: 0o600 });
    execFileSync('docker', ['cp', path, `${fixture.container}:${target}`], { stdio: 'pipe', timeout: 10000 });
    run('chown', `${user}:${user}`, target);
    run('chmod', '600', target);
  }
  const state = 'printf "SSH_HISTORY_FILE:%s:%s\\n" "${HISTFILE+x}" "${HISTFILE-}"';
  if (bash) {
    const settings = {
      default: '', small: 'HISTSIZE=2\nHISTFILESIZE=2\n',
      custom: 'HISTFILE="$HOME/custom-history"\nreadonly HISTFILE\nHISTCONTROL=ignoredups\nHISTIGNORE=SKIP_HISTORY_*\n',
      empty: 'HISTFILE=\n', unset: 'unset HISTFILE\n',
    }[variant];
    install('fixture-bash-profile', `${home}/.bash_profile`,
      'shopt -q login_shell && printf "profile:%s\n" "$HOME" >> "$HOME/ssh-history-startup"\nsource "$HOME/.bashrc"\n' + settings);
    install('fixture-bashrc', `${home}/.bashrc`, `[[ $- == *i* ]] || return 0
printf 'rc:%s\n' "$HOME" >> "$HOME/ssh-history-startup"
PS1='SSH-BASH> '
set +o history
SKIP_HISTORY_MARK() { :; }
ssh_history_observe() { printf '\n%s%s\n' SSH_HISTORY_ BEGIN; ${state}; builtin history; printf '%s%s\n' SSH_HISTORY_ END; }
bind -x '"\\C-xh":ssh_history_observe'
set -o history
`);
  } else {
    const settings = {
      default: 'HISTFILE="$HOME/history"\nHISTSIZE=1000\nSAVEHIST=1000\n',
      small: 'HISTFILE="$HOME/history"\nHISTSIZE=2\nSAVEHIST=2\n',
      custom: 'HISTFILE="$HOME/custom-history"\nreadonly HISTFILE\nHISTSIZE=1000\nSAVEHIST=1000\nsetopt HIST_IGNORE_DUPS HIST_IGNORE_SPACE\n',
      empty: 'HISTFILE=\nHISTSIZE=1000\nSAVEHIST=1000\n', unset: 'unset HISTFILE\nHISTSIZE=1000\nSAVEHIST=1000\n',
    }[variant];
    run('install', '-d', '-m', '700', '-o', user, '-g', user, `${home}/ssh-zdot`);
    install('fixture-zshenv', `${home}/.zshenv`, `export ZDOTDIR="$HOME/ssh-zdot"
[[ -o interactive ]] && printf 'env:%s\n' "$ZDOTDIR" >> "$HOME/ssh-history-startup"
`);
    install('fixture-zprofile', `${home}/ssh-zdot/.zprofile`, `[[ -o login ]] && printf 'profile:%s\n' "$HOME" >> "$HOME/ssh-history-startup"
`);
    install('fixture-zshrc', `${home}/ssh-zdot/.zshrc`, settings + `printf 'rc:%s\n' "$ZDOTDIR" >> "$HOME/ssh-history-startup"
PROMPT='SSH-ZLE> '
SKIP_HISTORY_MARK() { :; }
zmodload zsh/parameter
ssh_history_observe() { local id; printf '\n%s%s\n' SSH_HISTORY_ BEGIN; ${state}; for id in ${'$'}{(onk)history}; do print -r -- "$id $history[$id]"; done; printf '%s%s\n' SSH_HISTORY_ END; }
zle -N ssh_history_observe
bindkey '^Xh' ssh_history_observe
`);
  }
}

export function inspectSshHistory(fixture, variant) {
  assert(sshHistoryVariants.includes(variant));
  const bash = fixture.shell === 'bash', home = `/home/${fixture.username}`;
  const run = (...args) => execFileSync('docker', ['exec', '--user', fixture.username, fixture.container, ...args],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  const startup = run('cat', `${home}/ssh-history-startup`);
  assert.equal(startup, bash ? `profile:${home}\nrc:${home}\n` : `env:${home}/ssh-zdot\nprofile:${home}\nrc:${home}/ssh-zdot\n`,
    'Actual startup ran out of order, duplicated, or substituted HOME/ZDOTDIR');
  if (bash) assert.equal(run('cat', `${home}/system-profile-audit`), `system-login:${home}\n`);
  const standard = `${home}/${bash ? '.bash_history' : 'history'}`;
  const path = variant === 'custom' ? `${home}/custom-history` : standard;
  const absent = ['empty', 'unset'].includes(variant);
  if (absent) {
    run('test', '!', '-e', path);
    return { startup, path, absent };
  }
  const history = run('cat', path);
  if (variant === 'custom') run('test', '!', '-e', standard);
  return { startup, path, absent, history };
}
