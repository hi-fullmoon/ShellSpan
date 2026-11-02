# Sourced by the disposable fixture's normal /etc/profile, never by the adapter.
case "${USER-}" in
  native41*|native44*|native53*)
    if shopt -q login_shell; then
      printf 'system-login:%s\n' "$HOME" >> "$HOME/system-profile-audit"
    else
      printf 'system-nonlogin:%s\n' "$HOME" >> "$HOME/system-profile-audit"
    fi
    ;;
esac
