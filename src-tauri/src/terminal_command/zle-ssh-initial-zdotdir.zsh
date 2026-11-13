# OpenSSH starts the account's Zsh with -c before executing the interactive
# shell. Its .zshenv can already have redirected ZDOTDIR. Restore the value
# passed to that exec parent so the interactive shell starts at the same file
# as an ordinary SSH shell request.
export __SHELLSPAN_NIP_ZDOTDIR_SET=0
unset __SHELLSPAN_NIP_ZDOTDIR_VALUE
if [[ -r /proc/$$/environ ]]; then
  while IFS= read -r -d '' __shellspan_nip_initial_entry; do
    if [[ $__shellspan_nip_initial_entry == ZDOTDIR=* ]]; then
      export __SHELLSPAN_NIP_ZDOTDIR_SET=1
      export __SHELLSPAN_NIP_ZDOTDIR_VALUE="${__shellspan_nip_initial_entry#ZDOTDIR=}"
      break
    fi
  done < /proc/$$/environ
  unset __shellspan_nip_initial_entry
elif [[ ${parameters[ZDOTDIR]-} == *export* ]]; then
  # Some hosts mask procfs. Preserve the previous exported handoff there.
  export __SHELLSPAN_NIP_ZDOTDIR_SET=1 __SHELLSPAN_NIP_ZDOTDIR_VALUE="$ZDOTDIR"
fi
