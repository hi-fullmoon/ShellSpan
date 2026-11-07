# Read-only public Zsh history observation for owned acceptance homes.
# One file per native history event preserves literal LF, CR, Tab and Unicode;
# callers serialize the files with their platform's standard JSON library.
p3_history_export() {
  local p3_destination=$1 p3_key
  for p3_key in ${(k)history}; do
    builtin print -rn -- "${history[$p3_key]}" > "$p3_destination/entry-$p3_key"
  done
  builtin print -rn -- "$HISTSIZE" > "$p3_destination/histsize"
  builtin print -rn -- "$SAVEHIST" > "$p3_destination/savehist"
  builtin print -rn -- "${+HISTFILE}" > "$p3_destination/histfile-set"
  builtin print -rn -- "${HISTFILE-}" > "$p3_destination/histfile"
  for p3_key in appendhistory incappendhistory sharehistory extendedhistory rcs banghist; do
    builtin print -rn -- "${options[$p3_key]}" > "$p3_destination/option-$p3_key"
  done
  builtin print -rn -- complete > "$p3_destination/ready"
}
